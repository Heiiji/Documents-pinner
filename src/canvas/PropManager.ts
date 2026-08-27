/**
 * The only stateful singleton in the module.
 *
 * IMPURE. Owns everything that has to exist exactly once: the per-prop records, ONE
 * ticker callback, ONE shared uniform group, the texture LRU, the generation queue and
 * the LOD state machine. Every other module in the project is stateless, and the
 * reason is here — this is the file where a second copy of any of these would show up
 * as doubled work per frame that nobody could attribute to anything.
 *
 * The frame path is the part to be careful with:
 *
 * - **One ticker callback**, at LOW priority, after core has done its own work.
 * - **A dirty check on the six matrix components**, not the `canvasPan` hook — that
 *   hook fires every tick for the whole duration of an animated pan, and six float
 *   comparisons cost nothing and skip everything when the view is still.
 * - **LOD recompute debounced** after the transform settles, because a tier change
 *   allocates a texture and a zoom gesture would otherwise allocate dozens.
 * - **Texture generation is concurrency-1**, ordered by distance from the viewport
 *   centre, so what the GM is looking at is drawn first and the main thread is never
 *   holding two rasterisations at once.
 */

import { DEFAULTS, MODULE_ID } from "../const";
import { cancelIdle, cv, g, notify, onIdle, rendererResolution } from "../fvtt";
import * as settings from "../settings";
import { readPin } from "../data/PinData";
import * as api from "../api";
import {
  apparentWidth,
  rectsIntersect,
  rotatedBounds,
  sameMat,
  stageMatrix,
  visibleSceneRect,
  type Mat,
} from "./transform";
import {
  demote,
  initialPerf,
  lodFor,
  priorityOf,
  stepPerf,
  textureLongEdge,
  type LodTier,
  type PerfState,
} from "./lod";
import {
  loadCardCss,
  rasterise,
  rasterisationAvailable,
  releaseTexture,
} from "../render/Rasterizer";
import { resolveCard } from "../render/ContentResolver";
import { svgDocument } from "../render/CardTemplate";
import { inlineFonts, inlineImages } from "../render/AssetInliner";
import { TextureCache, cacheKey } from "../render/TextureCache";
import { currentLevel, sampleFrame } from "../effects/level";

interface PropRecord {
  id: string;
  tier: LodTier;
  /** The cache key currently bound to the mesh, so a rebind can be skipped. */
  boundKey: string | null;
  /** The texture core had before we replaced it, restored on teardown. */
  originalTexture: any;
  generating: boolean;
  lastSeen: number;
}

class Manager {
  #records = new Map<string, PropRecord>();
  #cache = new TextureCache();
  #matrix: Mat | null = null;
  #ticker: ((delta: number) => void) | null = null;
  #lodTimer = 0;
  #idleHandle = 0;
  #perf: PerfState = initialPerf();
  #queue: { id: string; priority: number }[] = [];
  #working = false;
  #clock = 0;
  #focusedId: string | null = null;
  /** Alt-peek: every prop drops towards transparent so the map can be read. */
  #peeking = false;
  /** Uniform amount every prop is demoted by, after the perf guard fires. */
  #globalDemotions = 0;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    this.stop();
    const ticker = cv()?.app?.ticker;
    if (!ticker) return;

    const PIXI = (globalThis as any).PIXI;
    this.#ticker = () => this.#onFrame();
    ticker.add(this.#ticker, this, PIXI?.UPDATE_PRIORITY?.LOW ?? 0);

    this.#matrix = null;
    this.refresh();
  }

  stop(): void {
    const ticker = cv()?.app?.ticker;
    if (this.#ticker && ticker) ticker.remove(this.#ticker, this);
    this.#ticker = null;

    if (this.#lodTimer) window.clearTimeout(this.#lodTimer);
    if (this.#idleHandle) cancelIdle(this.#idleHandle);
    this.#lodTimer = 0;
    this.#idleHandle = 0;

    for (const record of this.#records.values()) this.#restore(record);
    this.#records.clear();
    this.#cache.clear();
    this.#queue = [];
    this.#perf = initialPerf();
    this.#globalDemotions = 0;
  }

  /** Rebuild the record set from the scene. Cheap; the textures are what cost. */
  refresh(): void {
    const live = new Set<string>();

    for (const tile of cv()?.tiles?.placeables ?? []) {
      const pin = readPin(tile.document);
      if (!pin || pin.mode !== "prop") continue;
      live.add(tile.id);

      if (!this.#records.has(tile.id)) {
        this.#records.set(tile.id, {
          id: tile.id,
          tier: "L0",
          boundKey: null,
          originalTexture: tile.mesh?.texture ?? null,
          generating: false,
          lastSeen: 0,
        });
      }
    }

    for (const [id, record] of [...this.#records]) {
      if (live.has(id)) continue;
      this.#restore(record);
      this.#records.delete(id);
    }

    this.#scheduleLod(0);
  }

  /** Drop a document's textures after an edit, so the next frame redraws it. */
  invalidate(uuid: string): void {
    this.#cache.invalidate(uuid);
    for (const record of this.#records.values()) record.boundKey = null;
    this.#scheduleLod(DEFAULTS.editDebounce);
  }

  /**
   * Peek.
   *
   * The one control players get, and the reason a GM can lay a letter across a
   * corridor without making the corridor unusable. One alpha write per prop, and only
   * when the state actually changes.
   */
  setPeeking(active: boolean): void {
    if (this.#peeking === active) return;
    this.#peeking = active;
    this.applyAlpha();
  }

  /**
   * Fade a prop that a token is standing on, and apply the peek.
   *
   * Recomputed on token movement and on the debounced LOD pass rather than per frame:
   * it is an O(props x tokens) overlap test, and at fifty props it has no business
   * running sixty times a second for a state that changes when someone drags a token.
   */
  applyAlpha(): void {
    const canvas = cv();
    if (!canvas?.ready) return;

    const tokens = (canvas.tokens?.placeables ?? []).filter((token: any) => token.visible);

    for (const record of this.#records.values()) {
      const tile = canvas.tiles?.get(record.id);
      const pin = tile ? readPin(tile.document) : null;
      if (!tile?.mesh || !pin) continue;

      let alpha = tile.document.alpha ?? 1;
      if (pin.display.fadeUnderTokens && tokens.some((token: any) => overlaps(tile, token))) {
        alpha = Math.min(alpha, pin.display.fadeUnderTokensAlpha);
      }
      if (this.#peeking) alpha = Math.min(alpha, 0.15);

      // The reader dims its own prop; leaving that alone keeps the two from fighting.
      if (this.#focusedId === record.id) continue;
      tile.mesh.alpha = alpha;
    }
  }

  setFocused(id: string | null): void {
    if (this.#focusedId === id) return;
    this.#focusedId = id;
    this.#scheduleLod(0);
  }

  // -------------------------------------------------------------------------
  // The frame
  // -------------------------------------------------------------------------

  #onFrame(): void {
    const started = performance.now();
    sampleFrame(started);

    const matrix = stageMatrix();
    if (!this.#matrix || !sameMat(matrix, this.#matrix)) {
      this.#matrix = matrix;
      // The view moved. Recompute LOD once it settles rather than on every tick of an
      // animated pan — a tier change allocates, and a zoom would allocate dozens.
      this.#scheduleLod(DEFAULTS.lodDebounce);
    }

    const elapsed = performance.now() - started;
    if (!settings.get("autoDegrade")) return;

    const { state, degrade } = stepPerf(this.#perf, elapsed);
    this.#perf = state;
    if (degrade) this.#degrade();
  }

  #degrade(): void {
    this.#globalDemotions += 1;
    notify({ key: "DP.notice.degraded" }, "warn");
    this.#scheduleLod(0);
  }

  #scheduleLod(delay: number): void {
    if (this.#lodTimer) window.clearTimeout(this.#lodTimer);
    this.#lodTimer = window.setTimeout(() => {
      this.#lodTimer = 0;
      this.#recomputeLod();
    }, delay);
  }

  /**
   * Decide every prop's tier and queue whatever work that implies.
   *
   * Runs off the frame path entirely: it walks every prop, and doing that per frame is
   * exactly the cost the ladder exists to avoid.
   */
  #recomputeLod(): void {
    const canvas = cv();
    if (!canvas?.ready) return;

    const matrix = stageMatrix();
    const viewport = visibleSceneRect(0);
    const centre = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
    const resolution = rendererResolution();
    const queue: { id: string; priority: number }[] = [];

    for (const record of this.#records.values()) {
      const tile = canvas.tiles?.get(record.id);
      const pin = tile ? readPin(tile.document) : null;
      if (!tile || !pin) continue;

      const bounds = rotatedBounds(tile.document);
      let tier = lodFor({
        apparentWidth: apparentWidth(matrix, tile.document.width),
        onScreen: rectsIntersect(bounds, viewport),
        visible: tile.isVisible === true,
        focused: this.#focusedId === record.id,
        readable: api.canUserOpen(tile.document, g()?.user?.id ?? ""),
      });

      // The perf guard demotes uniformly: a scene where half the props are sharp and
      // half are mush looks broken, one that is uniformly softer looks deliberate.
      for (let i = 0; i < this.#globalDemotions; i++) tier = demote(tier);

      record.tier = tier;
      record.lastSeen = ++this.#clock;

      if (tier === "L0" || tier === "L1") {
        this.#unbind(record, tile);
        continue;
      }

      const longEdge = textureLongEdge(
        tier,
        Math.max(tile.document.width, tile.document.height) * (matrix.a || 1),
        resolution
      );
      const key = this.#keyFor(tile, pin, longEdge);

      const cached = this.#cache.get(key);
      if (cached) {
        this.#bind(record, tile, cached, key);
      } else if (!record.generating) {
        queue.push({ id: record.id, priority: priorityOf(bounds, centre) });
      }
    }

    this.#queue = queue.sort((a, b) => a.priority - b.priority);
    this.applyAlpha();
    this.#trim();
    this.#pump();
  }

  #keyFor(tile: any, pin: any, longEdge: number): string {
    return cacheKey({
      uuid: pin.source.uuid ?? pin.source.src ?? tile.id,
      // The viewing user is in the key because enrichment strips secrets per viewer.
      // Removing this would let a GM's texture be served to a player.
      userId: g()?.user?.id ?? "",
      resTier: longEdge,
      presetBake: `${pin.effect.id}:${pin.effect.intensity}:${pin.effect.seed}:${pin.display.paper}:${currentLevel()}`,
      docHash: String(tile.document.width) + "x" + String(tile.document.height),
    });
  }

  // -------------------------------------------------------------------------
  // Texture generation
  // -------------------------------------------------------------------------

  /**
   * Draw one prop at a time, nearest first.
   *
   * Concurrency 1 on purpose: rasterisation decodes an image and touches a canvas, and
   * two at once on the main thread produce two long frames instead of one.
   */
  #pump(): void {
    if (this.#working || !this.#queue.length) return;
    if (rasterisationAvailable() === false || settings.get("rendering") === "dom") return;

    const next = this.#queue.shift()!;
    const record = this.#records.get(next.id);
    const tile = cv()?.tiles?.get(next.id);
    if (!record || !tile) {
      this.#pump();
      return;
    }

    this.#working = true;
    record.generating = true;

    void this.#generate(record, tile).finally(() => {
      record.generating = false;
      this.#working = false;
      // Off-screen work waits for idle time so it never competes with a live frame.
      this.#idleHandle = onIdle(() => this.#pump(), 30);
    });
  }

  async #generate(record: PropRecord, tile: any): Promise<void> {
    const pin = readPin(tile.document);
    if (!pin) return;

    const size = { width: tile.document.width, height: tile.document.height };
    const longEdge = textureLongEdge(
      record.tier,
      Math.max(size.width, size.height) * (stageMatrix().a || 1),
      rendererResolution()
    );
    if (!longEdge) return;

    const key = this.#keyFor(tile, pin, longEdge);
    if (this.#cache.has(key)) {
      this.#bind(record, tile, this.#cache.get(key), key);
      return;
    }

    const card = await resolveCard(pin, size, { tier: record.tier, baked: true });
    const [css, fonts, body] = await Promise.all([
      loadCardCss(),
      inlineFonts(),
      inlineImages(card.html),
    ]);

    const svg = svgDocument(body, `${fonts}\n${css}`, size.width, size.height);
    const result = await rasterise(svg, size.width, size.height, longEdge);
    if (!result) return;

    this.#cache.set(key, result.texture, result.bytes);
    this.#bind(record, tile, result.texture, key);
    this.#trim();
  }

  // -------------------------------------------------------------------------
  // Binding
  // -------------------------------------------------------------------------

  /**
   * Put a texture on the tile's own mesh.
   *
   * The mesh's POSITION, SIZE and ROTATION are never touched — core owns the transform
   * entirely, and v14 has already changed how the mesh is positioned once.
   */
  #bind(record: PropRecord, tile: any, texture: any, key: string): void {
    if (!texture || record.boundKey === key) return;
    const mesh = tile.mesh;
    if (!mesh) return;

    if (record.originalTexture === null) record.originalTexture = mesh.texture;
    mesh.texture = texture;
    record.boundKey = key;
  }

  #unbind(record: PropRecord, tile: any): void {
    if (record.boundKey === null) return;
    this.#restore(record, tile);
  }

  #restore(record: PropRecord, tile?: any): void {
    const mesh = (tile ?? cv()?.tiles?.get(record.id))?.mesh;
    if (mesh && record.originalTexture) mesh.texture = record.originalTexture;
    record.boundKey = null;
  }

  /**
   * Evict down to the VRAM budget.
   *
   * The focused prop is protected: it is the one thing on screen the user is actually
   * reading, and reclaiming its texture to free memory would be the single most
   * visible way to save the least.
   */
  #trim(): void {
    const focused = this.#focusedId ? this.#records.get(this.#focusedId) : null;
    const evicted = this.#cache.trim(
      settings.vramBudgetBytes(),
      focused?.boundKey ? [focused.boundKey] : []
    );
    if (!evicted.length) return;

    // Evicted props demote rather than vanish: the mesh keeps core's own texture.
    for (const record of this.#records.values()) {
      if (record.boundKey && evicted.includes(record.boundKey)) this.#restore(record);
    }
  }

  stats(): { props: number; textures: number; bytes: number; degraded: boolean } {
    return {
      props: this.#records.size,
      textures: this.#cache.size,
      bytes: this.#cache.bytes,
      degraded: this.#perf.degraded,
    };
  }
}

let manager: Manager | null = null;

export function propManager(): Manager {
  manager ??= new Manager();
  return manager;
}

/** Release everything. Called on `canvasTearDown` and when the module is disabled. */
export function teardownProps(): void {
  manager?.stop();
}

/** Bounding-box overlap in scene space. Rotation is ignored deliberately: the fade is
 * a gameplay courtesy, not a hit test, and a token near the corner of a tilted letter
 * should still reveal it. */
function overlaps(tile: any, token: any): boolean {
  const a = rotatedBounds(tile.document);
  const b = {
    x: token.document.x,
    y: token.document.y,
    width: token.w ?? token.document.width * (cv()?.grid?.size ?? 100),
    height: token.h ?? token.document.height * (cv()?.grid?.size ?? 100),
  };
  return rectsIntersect(a, b);
}

/** Exposed for the Pinboard's diagnostics and for the smoke test. */
export function propStats() {
  return manager?.stats() ?? { props: 0, textures: 0, bytes: 0, degraded: false };
}

export { releaseTexture, MODULE_ID };
