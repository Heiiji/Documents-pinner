/**
 * The texture LRU.
 *
 * IMPURE only in that it destroys PIXI textures; the eviction policy itself is pure
 * and tested through `plan`.
 *
 * The cache key is the whole reason this file exists. A prop's texture depends on:
 *
 *   uuid       — which document
 *   userId     — WHICH USER, because enrichment strips secrets per viewer and two
 *                users must never share a texture
 *   resTier    — the LOD rung it was drawn for
 *   presetBake — the baked half of the effect, which is drawn INTO the pixels
 *   docHash    — the content, so an edit invalidates it
 *
 * Dropping `userId` from that key is the single most dangerous mistake available in
 * this module: it would let a GM's texture — secrets and all — be handed to a player
 * on the same client session. It is in the key, and the key builder is tested.
 *
 * Eviction is by least-recently-SEEN rather than least-recently-created, because a prop
 * the party is currently reading must outrank one drawn a moment ago off-screen.
 */

import { releaseTexture } from "./Rasterizer";

export interface CacheKeyParts {
  uuid: string;
  userId: string;
  resTier: number;
  presetBake: string;
  docHash: string;
}

export function cacheKey(parts: CacheKeyParts): string {
  return [parts.uuid, parts.userId, parts.resTier, parts.presetBake, parts.docHash].join("|");
}

/**
 * A cheap, stable content hash.
 *
 * FNV-1a: not cryptographic and not meant to be — the only question it answers is
 * "has this content changed since we drew it", where a collision costs one stale card
 * until the next edit.
 */
export function hashContent(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface CacheEntry {
  key: string;
  texture: any;
  bytes: number;
  lastSeen: number;
}

/**
 * PURE. Which keys to evict to get under `budget`, least-recently-seen first.
 *
 * Returned rather than performed so the policy can be tested without a GPU, and so a
 * caller can decide what to do with the evicted props — they demote to the silhouette
 * tier rather than vanishing.
 */
export function plan(
  entries: readonly { key: string; bytes: number; lastSeen: number }[],
  budget: number,
  protectedKeys: readonly string[] = []
): string[] {
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  if (total <= budget) return [];

  const keep = new Set(protectedKeys);
  const candidates = entries
    .filter((entry) => !keep.has(entry.key))
    .sort((a, b) => a.lastSeen - b.lastSeen);

  const evicted: string[] = [];
  let remaining = total;
  for (const entry of candidates) {
    if (remaining <= budget) break;
    evicted.push(entry.key);
    remaining -= entry.bytes;
  }
  return evicted;
}

export class TextureCache {
  #entries = new Map<string, CacheEntry>();
  #bytes = 0;
  #clock = 0;

  get bytes(): number {
    return this.#bytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Look up and mark as seen in one step, so a read cannot forget to touch it. */
  get(key: string): any {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    entry.lastSeen = ++this.#clock;
    return entry.texture;
  }

  has(key: string): boolean {
    return this.#entries.has(key);
  }

  set(key: string, texture: any, bytes: number): void {
    this.delete(key);
    this.#entries.set(key, { key, texture, bytes, lastSeen: ++this.#clock });
    this.#bytes += bytes;
  }

  /** Destroying the base texture is what actually frees the GPU memory. */
  delete(key: string): boolean {
    const entry = this.#entries.get(key);
    if (!entry) return false;
    releaseTexture(entry.texture);
    this.#entries.delete(key);
    this.#bytes -= entry.bytes;
    return true;
  }

  /** Evict down to `budget`. Returns the keys removed, for the caller to demote. */
  trim(budget: number, protectedKeys: readonly string[] = []): string[] {
    const evicted = plan([...this.#entries.values()], budget, protectedKeys);
    for (const key of evicted) this.delete(key);
    return evicted;
  }

  /** Every key for a given document, for invalidating after an edit. */
  keysFor(uuid: string): string[] {
    return [...this.#entries.keys()].filter((key) => key.startsWith(`${uuid}|`));
  }

  invalidate(uuid: string): number {
    const keys = this.keysFor(uuid);
    for (const key of keys) this.delete(key);
    return keys.length;
  }

  clear(): void {
    for (const key of [...this.#entries.keys()]) this.delete(key);
  }
}
