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
import { logger } from "../log";
import { cancelIdle, cv, g, notify, ns, nsAny, onIdle, rendererResolution } from "../fvtt";
import * as settings from "../settings";
import { readPin } from "../data/PinData";
import { cardMetrics } from "../data/pin-schema";
import * as api from "../api";
import {
  apparentWidth,
  rectsIntersect,
  rotatedBounds,
  sameMat,
  scaleOf,
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
  textureFromCanvas,
} from "../render/Rasterizer";
import { resolveCard } from "../render/ContentResolver";
import { pdfSourceOf, renderPdfPage } from "../render/PdfPage";
import { bakeEffects, copyCanvas } from "../render/BakeEffects";
import { dressing } from "../effects/EffectRegistry";
import { svgDocument } from "../render/CardTemplate";
import { inlineFonts, inlineImages } from "../render/AssetInliner";
import { TextureCache, cacheKey } from "../render/TextureCache";
import { currentLevel, sampleFrame, sampledFps } from "../effects/level";
import { findPreset } from "../effects/preset-library";
import { clearDomTier, setDomPropAlpha, syncDomTier, type DomPropEntry } from "./DomPropTier";

const log = logger("props");

/**
 * The frame time above which the scene counts as struggling.
 *
 * 45 fps rather than 60: a scene that dips below 60 on a wheel scroll is normal, and one
 * that holds under 45 for a solid second is not going to recover on its own.
 */
export const DEGRADE_FRAME_MS = 1000 / 45;

interface PropRecord {
  id: string;
  tier: LodTier;
  /** The cache key currently bound to the mesh, so a rebind can be skipped. */
  boundKey: string | null;
  /** The texture core had before we replaced it, restored on teardown. */
  originalTexture: any;
  generating: boolean;
  lastSeen: number;
  /**
   * The content hash of the card last drawn for this prop.
   *
   * The cache key had NO content signal at all — `docHash` was `width + "x" + height` —
   * so a pin anchored to a whole JournalEntry never invalidated when one of its pages was
   * edited: `keysFor` prefix-matches the page uuid against the entry uuid and finds
   * nothing, and the prop stayed stale for the rest of the session. `ResolvedCard` had
   * been computing `contentHash` all along and nothing read it.
   */
  contentHash: string;
  /** Whether this client could see it last time we looked, for the reveal animation. */
  wasVisible: boolean;
  /** Whether the key this prop currently wants is one that already failed to draw. */
  lastKeyFailed: boolean;
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
  /**
   * Cache keys that could not be drawn.
   *
   * Without this a card that cannot rasterise is re-enriched, re-parsed, re-built and
   * re-failed on EVERY LOD pass — which is after every pan, for as long as the scene is
   * open. The key is content-addressed, so an edit, a resize or a preset change produces
   * a different key and the retry happens on its own; nothing has to expire this.
   */
  #failedKeys = new Set<string>();
  #working = false;
  /**
   * Bumped whenever everything in flight becomes irrelevant.
   *
   * `#generate` awaits five times and then wrote into the cache and onto a mesh with no
   * check that any of it still existed. `stop()` cleared the records but cancelled
   * nothing, so a pending generate resolved into the NEW scene's cache under the OLD
   * scene's key and assigned `mesh.texture` on a destroyed mesh.
   */
  #epoch = 0;
  /** Whether the "no mesh to bind to" fault has already been reported this session. */
  #warnedNoMesh = false;
  /**
   * Settings read once per LOD pass rather than per prop or per frame.
   *
   * `currentLevel()` costs a settings read plus a fresh `window.matchMedia` every time,
   * and it was called once per prop inside `#keyFor`; `autoDegrade` was read inside the
   * ticker.
   */
  #level = currentLevel();
  #autoDegrade = true;
  #clock = 0;
  #focusedId: string | null = null;
  /** Alt-peek: every prop drops towards transparent so the map can be read. */
  #peeking = false;
  /** Uniform amount every prop is demoted by, after the perf guard fires. */
  #globalDemotions = 0;

  /**
   * Whether props are drawn into the scene or over it.
   *
   * Two independent reasons to fall back: the client cannot rasterise at all (WebKit
   * taints a `foreignObject` canvas), or the GM chose the compatibility path. Either
   * way `DomPropTier` takes over — it is never "no props at all", which is what this
   * used to mean.
   */
  #domMode(): boolean {
    return rasterisationAvailable() === false || settings.get("rendering") === "dom";
  }

  /**
   * Whether THIS prop has to be drawn as DOM.
   *
   * A PDF is the exception, and it is the interesting one. `rasterisationAvailable()`
   * being false means the HTML pipeline cannot reach a texture — an SVG `foreignObject`
   * taints the canvas, see DESIGN A10 — but pdf.js paints with Canvas2D and its output
   * uploads fine. So a pinned PDF still gets the canvas tier, and with it the lighting,
   * fog, occlusion and token z-order that no other source type can have.
   *
   * A GM who deliberately chose DOM rendering still gets DOM, for everything.
   */
  #domModeFor(pin: any): boolean {
    if (settings.get("rendering") === "dom") return true;
    if (rasterisationAvailable() !== false) return false;
    // HTML cannot reach a texture on this client, but a PDF still can.
    return !this.#isPdf(pin);
  }

  #isPdf(pin: any): boolean {
    return pdfSourceOf(api.resolveSourceSync(pin)) !== null;
  }

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
    // Everything in flight is now about a scene that is going away.
    this.#epoch++;
    this.#working = false;

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
    this.#failedKeys.clear();
    clearDomTier();
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
          contentHash: "",
          // Assume visible, so props already on screen at load do not all animate in.
          wasVisible: true,
          lastKeyFailed: false,
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

  /**
   * Drop a document's textures after an edit, so the next frame redraws it.
   *
   * RESTORE BEFORE DESTROY, and only for the props that actually reference this source.
   * It used to destroy through the cache and then null `boundKey` on EVERY record, which
   * made the later `#unbind` early-return and never put core's own texture back — so
   * editing a page ten props referenced left ten meshes pointing at destroyed textures
   * for 250 ms plus however long the serialised regeneration took.
   */
  invalidate(uuid: string): void {
    const affected = [...this.#records.values()].filter((record) =>
      this.#referencesSource(record, uuid)
    );

    for (const record of affected) {
      this.#restore(record);
      // Forget the content signal so the next pass builds a key this cache cannot serve.
      record.contentHash = "";
    }

    // Both directions: a pin on a whole JournalEntry must be invalidated by an edit to
    // one of its PAGES, whose uuid is longer than the entry's.
    const sources = new Set<string>([uuid]);
    for (const record of affected) {
      const source = this.#sourceUuidOf(record);
      if (source) sources.add(source);
    }
    for (const source of sources) this.#cache.invalidate(source);

    // A card that failed to draw deserves another go once its content has changed.
    for (const key of [...this.#failedKeys]) {
      for (const source of sources) {
        if (key.startsWith(`${source}|`)) this.#failedKeys.delete(key);
      }
    }
    this.#scheduleLod(DEFAULTS.editDebounce);
  }

  /** The source uuid a prop draws from, which is the first field of its cache key. */
  #sourceUuidOf(record: PropRecord): string | null {
    const tile = cv()?.tiles?.get(record.id);
    const pin = tile ? readPin(tile.document) : null;
    return pin?.source.uuid ?? pin?.source.src ?? record.id;
  }

  #referencesSource(record: PropRecord, uuid: string): boolean {
    const source = this.#sourceUuidOf(record);
    if (!source) return false;
    return source === uuid || source.startsWith(uuid) || uuid.startsWith(source);
  }

  /**
   * Core redrew a tile, so the texture we captured to restore later is stale.
   *
   * `PinnedTile` has been firing this since it was written and nothing listened, so a
   * redraw left `originalTexture` pointing at a texture core had already replaced — and
   * `boundKey` claiming a binding the new mesh does not have.
   */
  onTileDrawn(tile: any): void {
    const record = this.#records.get(tile?.id);
    if (!record) return;
    record.boundKey = null;
    record.originalTexture = tile.mesh?.texture ?? null;
    this.#scheduleLod(0);
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

    const tokens = visibleTokens();

    for (const record of this.#records.values()) {
      const tile = canvas.tiles?.get(record.id);
      const pin = tile ? readPin(tile.document) : null;
      if (!tile || !pin) continue;

      // The reader dims its own prop; leaving that alone keeps the two from fighting.
      if (this.#focusedId === record.id) continue;

      const dom = this.#domModeFor(pin);
      const alpha = this.#alphaFor(tile, pin, tokens);
      if (dom) setDomPropAlpha(record.id, alpha);
      if (tile.mesh) tile.mesh.alpha = this.#meshAlphaFor(record, alpha, dom);
    }
  }

  /** The alpha a prop should be drawn at, whichever tier is drawing it. */
  #alphaFor(tile: any, pin: any, tokens: any[]): number {
    let alpha = tile.document.alpha ?? 1;
    if (pin.display.fadeUnderTokens && tokens.some((token: any) => overlaps(tile, token))) {
      alpha = Math.min(alpha, pin.display.fadeUnderTokensAlpha);
    }
    if (this.#peeking) alpha = Math.min(alpha, 0.15);
    return alpha;
  }

  /**
   * The alpha the tile's own MESH should be drawn at.
   *
   * Every anchor now carries a real placeholder texture, because core builds no mesh
   * without one — so the mesh has something to draw at every moment, and the two tiers
   * have to say when that something should be seen.
   *
   * On the DOM path: never. The card over it IS the prop, and a placeholder icon
   * stretched to letter size showing through it would be the artefact.
   *
   * On the canvas path: not while a readable-sized prop is still being drawn. The
   * placeholder is an icon, not a letter, and stretching it across a prop the GM is
   * waiting for reads as a bug rather than as loading. Below the silhouette threshold it
   * is left alone, because at that size it is a speck either way.
   */
  #meshAlphaFor(record: PropRecord, alpha: number, dom: boolean): number {
    if (dom) return 0;
    // "Waiting" only counts while there is still something to wait FOR. A prop whose card
    // has already failed to draw is never going to get a texture, and holding it at zero
    // then means an invisible prop with nothing on screen to explain it — strictly worse
    // than the stretched placeholder this hold exists to avoid.
    const awaitingTexture =
      record.boundKey === null &&
      record.tier !== "L0" &&
      record.tier !== "L1" &&
      !record.lastKeyFailed;
    return awaitingTexture ? 0 : alpha;
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

    if (!this.#autoDegrade) return;

    // The SCENE's frame time, not ours. This used to time the six lines above it — a
    // counter increment, a matrix read and six float compares, a few microseconds against
    // a 4 ms budget — because every real cost in this module is deliberately off the
    // ticker. The guard could therefore never fire and acceptance criterion 10 could
    // never be observed. `sampledFps` is the rolling rate the effects level already
    // trusts, so the two agree about what "slow" means.
    const frameMs = 1000 / Math.max(1, sampledFps());
    const { state, degrade } = stepPerf(this.#perf, frameMs, DEGRADE_FRAME_MS);
    this.#perf = state;
    if (degrade) this.#degrade();
  }

  #degrade(): void {
    log.warn(
      `frame rate held below target; reducing every prop's detail one step ` +
        `(now ${this.#globalDemotions + 1})`
    );
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

    // Hoisted out of the per-prop and per-frame paths: both of these cost a settings
    // read, and `currentLevel` also builds a fresh `window.matchMedia` every call.
    this.#level = currentLevel();
    this.#autoDegrade = settings.get("autoDegrade");

    const matrix = stageMatrix();
    const viewport = visibleSceneRect(0);
    const centre = { x: viewport.x + viewport.width / 2, y: viewport.y + viewport.height / 2 };
    const resolution = rendererResolution();
    const queue: { id: string; priority: number }[] = [];
    const anyDom = this.#domMode();
    const domEntries: DomPropEntry[] = [];
    const tokens = anyDom ? visibleTokens() : [];

    for (const record of this.#records.values()) {
      const tile = canvas.tiles?.get(record.id);
      const pin = tile ? readPin(tile.document) : null;
      if (!tile || !pin) continue;

      const bounds = rotatedBounds(tile.document);
      const metrics = cardMetrics(pin.display, {
        width: tile.document.width,
        height: tile.document.height,
      });
      let tier = lodFor({
        apparentWidth: apparentWidth(matrix, tile.document.width),
        apparentTypeSize: metrics.fontPx * scaleOf(matrix),
        onScreen: rectsIntersect(bounds, viewport),
        visible: tile.isVisible === true,
        focused: this.#focusedId === record.id,
        readable: api.canUserOpen(tile.document, g()?.user?.id ?? ""),
      });

      // The perf guard demotes uniformly: a scene where half the props are sharp and
      // half are mush looks broken, one that is uniformly softer looks deliberate.
      for (let i = 0; i < this.#globalDemotions; i++) tier = demote(tier);

      const dom = this.#domModeFor(pin);

      const visible = tile.isVisible === true;
      if (visible && !record.wasVisible) this.#playReveal(tile, pin, record, dom);
      record.wasVisible = visible;

      record.tier = tier;
      record.lastSeen = ++this.#clock;

      if (dom) {
        // No mesh work at all on this path: the card is a DOM element over the canvas,
        // and the tile's own texture stays exactly as core left it.
        this.#unbind(record, tile);
        domEntries.push({
          id: record.id,
          doc: tile.document,
          pin,
          tier,
          focused: this.#focusedId === record.id,
          alpha: this.#alphaFor(tile, pin, tokens),
          pdf: this.#isPdf(pin),
        });
        continue;
      }

      if (tier === "L0" || tier === "L1") {
        this.#unbind(record, tile);
        continue;
      }

      const longEdge = textureLongEdge(
        tier,
        Math.max(tile.document.width, tile.document.height) * scaleOf(matrix),
        resolution
      );
      const key = this.#keyFor(tile, pin, longEdge, record.contentHash);

      record.lastKeyFailed = this.#failedKeys.has(key);

      const cached = this.#cache.get(key);
      if (cached) {
        this.#bind(record, tile, cached, key);
      } else if (!record.generating && !record.lastKeyFailed) {
        queue.push({ id: record.id, priority: priorityOf(bounds, centre) });
      }
    }

    // Always reconcile: a GM switching the rendering setting back to canvas mid-session
    // would otherwise leave every mounted card in the overlay forever, on top of the
    // meshes now drawing the same props. An empty list clears them all.
    syncDomTier(domEntries);
    this.#queue = queue.sort((a, b) => a.priority - b.priority);
    this.applyAlpha();
    this.#trim();
    this.#pump();
  }

  /**
   * The reveal.
   *
   * A prop appearing instantly reads as a rendering glitch; the same prop fading up
   * over half a second reads as something being revealed, which is the entire moment
   * the module exists for. Driven by core's own animation so it shares the ticker and
   * is cancelled correctly when the scene is torn down mid-animation.
   */
  #playReveal(tile: any, pin: any, record: PropRecord, dom: boolean): void {
    const mesh = tile.mesh;
    if (!mesh) return;

    // The library, not just the shipped ten: a user preset's reveal never played.
    const preset = findPreset(pin.effect.id);
    const animation = preset?.reveal.animation ?? "fade";
    const target = tile.document.alpha ?? 1;

    // The sound belongs to the reveal whichever tier draws it, and plays either way.
    playRevealSound(preset?.reveal.sound ?? null);

    // The MESH does not, and this decision comes FIRST — before the level check, which
    // also writes alpha. At the moment a reveal fires the prop's own texture has by
    // definition not been drawn yet, so touching the mesh here puts the PLACEHOLDER on
    // screen — a book icon stretched across a letter — and leaves it there, overriding
    // the hold in `#meshAlphaFor`. On the DOM path it would sit under the card as well.
    // The arrival is somebody else's job either way: `#fadeIn` when the texture lands,
    // and the `.dp-prop--in` transition on the DOM card.
    if (dom || record.boundKey === null) return;

    if (animation === "none" || this.#level !== "full") {
      mesh.alpha = target;
      return;
    }

    const duration = Math.max(0, preset?.reveal.durationMs ?? 400);
    const CanvasAnimation = ns("canvas.animation.CanvasAnimation");
    mesh.alpha = 0;

    if (!CanvasAnimation?.animate) {
      mesh.alpha = target;
      return;
    }
    void CanvasAnimation.animate([{ parent: mesh, attribute: "alpha", to: target }], {
      duration,
      // `materialise` and `fade` were the same linear alpha ramp, so half the shipped
      // presets declared an animation that behaved identically to the other half. The
      // alpha channel is the ONLY one this may touch — the mesh's position, size,
      // rotation and anchor belong to core — so the two are distinguished by their
      // curve: a fade arrives at a constant rate, a materialise eases in and out and
      // reads as something resolving rather than something being turned up.
      easing: animation === "materialise" ? CanvasAnimation.easeInOutCosine : undefined,
      name: `${MODULE_ID}.reveal.${tile.id}`,
    });
  }

  /**
   * The cache key for a prop.
   *
   * `docHash` carries the CONTENT hash as well as the geometry. It used to be
   * `width + "x" + height` alone, so nothing in the key ever changed when a document
   * did — and a pin on a whole JournalEntry stayed stale for the session when one of its
   * pages was edited, because `keysFor` prefix-matches the page uuid against the entry
   * uuid and finds nothing to drop.
   *
   * The hash comes from the record rather than from a fresh resolve, because this runs
   * synchronously for every prop on every LOD pass and resolving a card enriches a
   * document. `#generate` writes the real hash back after resolving, so the first draw
   * costs one provisional key and every later pass agrees with the cache.
   */
  #keyFor(tile: any, pin: any, longEdge: number, contentHash: string): string {
    const doc = tile.document;
    // The type size and the pad are drawn INTO the pixels, so they are in the key for the
    // same reason the preset is. A prop whose metrics are stored no longer changes its
    // type when the tile changes size, so the geometry alone could not catch a type edit.
    const { fontPx, padPx } = cardMetrics(pin.display, { width: doc.width, height: doc.height });
    return cacheKey({
      uuid: pin.source.uuid ?? pin.source.src ?? tile.id,
      // The viewing user is in the key because enrichment strips secrets per viewer.
      // Removing this would let a GM's texture be served to a player.
      userId: g()?.user?.id ?? "",
      resTier: longEdge,
      presetBake: `${pin.effect.id}:${pin.effect.intensity}:${pin.effect.seed}:${pin.display.paper}:${this.#level}`,
      docHash: `${doc.width}x${doc.height}:${fontPx}:${padPx}:${contentHash}`,
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
    // Nothing to rasterise on the DOM path — `DomPropTier` has already drawn those — but
    // a PDF prop still has canvas work to do even when HTML rasterisation is unavailable.
    if (settings.get("rendering") === "dom") return;

    // Drain stale entries in a loop rather than by recursing: a queue built just before
    // a dozen tiles were deleted would otherwise recurse once per dead entry.
    let record: PropRecord | undefined;
    let tile: any;
    while (this.#queue.length) {
      const next = this.#queue.shift()!;
      record = this.#records.get(next.id);
      tile = cv()?.tiles?.get(next.id);
      if (record && tile) break;
      record = undefined;
    }
    if (!record || !tile) return;

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

    /**
     * Whether this work still matters.
     *
     * Five awaits separate the decision to draw from the write, and nothing checked any
     * of it: not that the record still existed, not that the tile did, not that the scene
     * had not changed, not that the prop had not left the viewport. A pending generate
     * resolved into the new scene's cache under the old scene's key and then assigned
     * `mesh.texture` on a destroyed mesh.
     */
    const epoch = this.#epoch;
    const alive = () =>
      this.#epoch === epoch &&
      this.#records.get(record.id) === record &&
      cv()?.tiles?.get(record.id) === tile &&
      record.tier !== "L0" &&
      record.tier !== "L1";

    const size = { width: tile.document.width, height: tile.document.height };
    const longEdge = textureLongEdge(
      record.tier,
      Math.max(size.width, size.height) * scaleOf(stageMatrix()),
      rendererResolution()
    );
    if (!longEdge) return;

    const provisional = this.#keyFor(tile, pin, longEdge, record.contentHash);
    if (this.#cache.has(provisional)) {
      this.#bind(record, tile, this.#cache.get(provisional), provisional);
      this.applyAlpha();
      return;
    }

    // A PDF skips the HTML pipeline entirely: pdf.js paints the page onto a canvas that
    // is not tainted, so it uploads to WebGL and the prop becomes a real scene object —
    // lit, fogged, occluded, behind tokens. The one source type that can do that.
    const pdfSrc = pdfSourceOf(api.resolveSourceSync(pin));
    if (pdfSrc) {
      const rendered = await renderPdfPage(pdfSrc, pdfPageOf(pin), longEdge);
      if (!alive()) return;

      const key = this.#keyFor(tile, pin, longEdge, `pdf:${pdfPageOf(pin)}`);
      const cachedPdf = this.#cache.get(key);
      if (cachedPdf) {
        this.#bind(record, tile, cachedPdf, key);
        this.applyAlpha();
        return;
      }

      // The effects, painted on. A PDF has no card for CSS to reach, so the static half
      // of the preset is composited onto a COPY of the page — the page cache must never
      // be painted over, or the next preset would inherit this one's stains.
      let surface = rendered?.canvas ?? null;
      const preset = findPreset(pin.effect.id);
      if (surface && preset && !bakedTaints) {
        const dressed = dressing({
          preset,
          intensity: pin.effect.intensity,
          seed: pin.effect.seed,
          tier: record.tier,
          level: this.#level,
          // A texture cannot animate, so this is the static rendition by construction —
          // which is exactly the set of layers Canvas2D can paint.
          baked: true,
        });
        surface = copyCanvas(surface);
        await bakeEffects(surface, dressed.vars);
        if (!alive()) return;
      }

      let result = surface ? textureFromCanvas(surface, rendered!.width, rendered!.height) : null;

      // Baking taints the canvas on some browsers — WebKit does for an SVG source,
      // Chromium does not — and a tainted canvas cannot be uploaded. Fall back to the page
      // exactly as pdf.js drew it, which is known to upload, rather than losing the prop
      // for the sake of some stains. Latched: the answer is a property of the browser.
      if (!result && rendered && surface !== rendered.canvas) {
        if (!bakedTaints) {
          bakedTaints = true;
          log.warn("effects cannot be baked on this browser; drawing PDF pages unadorned");
        }
        result = textureFromCanvas(copyCanvas(rendered.canvas), rendered.width, rendered.height);
      }

      if (!result) {
        log.warn(`could not draw the PDF behind ${tile.id}`);
        this.#failedKeys.add(key);
        record.lastKeyFailed = true;
        this.applyAlpha();
        return;
      }

      record.contentHash = `pdf:${pdfPageOf(pin)}`;
      this.#cache.set(key, result.texture, result.bytes);
      this.#bind(record, tile, result.texture, key);
      this.applyAlpha();
      this.#fadeIn(tile);
      this.#trim();
      return;
    }

    const card = await resolveCard(pin, size, { tier: record.tier, baked: true });
    if (!alive()) return;

    // The real content signal, now that the card exists. Written back so the next LOD
    // pass builds the same key synchronously and hits the cache.
    record.contentHash = card.contentHash;
    const key = this.#keyFor(tile, pin, longEdge, card.contentHash);

    const cached = this.#cache.get(key);
    if (cached) {
      this.#bind(record, tile, cached, key);
      this.applyAlpha();
      return;
    }
    if (this.#failedKeys.has(key)) return;

    const [css, fonts, body] = await Promise.all([
      loadCardCss(),
      inlineFonts(),
      inlineImages(card.html),
    ]);
    if (!alive()) return;

    const svg = svgDocument(body, `${fonts}\n${css}`, size.width, size.height);
    const result = await rasterise(svg, size.width, size.height, longEdge);
    if (!result) {
      // Not retried until this pin's content, size or preset changes — which is what the
      // key encodes — so say so once rather than going quiet.
      log.warn(`could not draw ${tile.id}; it will not be retried until its content changes`);
      this.#failedKeys.add(key);
      record.lastKeyFailed = true;
      this.applyAlpha();
      return;
    }
    if (!alive()) {
      // Drawn for a scene that is gone: free it here rather than caching it under a key
      // nothing will ever ask for again.
      releaseTexture(result.texture);
      return;
    }

    log.debug(
      `drew ${tile.id} at ${result.width}x${result.height} (${Math.round(result.bytes / 1024)} kB, ` +
        `tier ${record.tier}); cache now ${this.#cache.size} textures, ` +
        `${Math.round(this.#cache.bytes / 1024 / 1024)} MB`
    );
    this.#cache.set(key, result.texture, result.bytes);
    this.#bind(record, tile, result.texture, key);
    // The mesh was held invisible while there was only a placeholder on it; now that the
    // prop's own texture is bound it has something worth showing. `#recomputeLod` runs
    // this before the queue drains, so the bind has to say so itself.
    this.applyAlpha();
    this.#fadeIn(tile);
    this.#trim();
  }

  /**
   * Ease a freshly drawn prop up to its alpha instead of popping it on.
   *
   * The mesh is held at zero while a readable-sized prop is still being rasterised, so
   * without this the moment the texture lands is a hard cut from nothing to a full
   * letter — which reads as a glitch for exactly the same reason a reveal does.
   *
   * Short and only on a real draw, not on a cache rebind: a GM panning back over a prop
   * they have already seen should find it there, not watch it arrive again.
   */
  #fadeIn(tile: any): void {
    const mesh = tile.mesh;
    if (!mesh || this.#level !== "full") return;

    const target = mesh.alpha;
    if (!target) return;

    const CanvasAnimation = ns("canvas.animation.CanvasAnimation");
    if (!CanvasAnimation?.animate) return;

    mesh.alpha = 0;
    void CanvasAnimation.animate([{ parent: mesh, attribute: "alpha", to: target }], {
      duration: 200,
      name: `${MODULE_ID}.draw.${tile.id}`,
    });
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
    if (!mesh) {
      // Indistinguishable from "still loading" if it stays quiet, and it is the exact
      // symptom of an anchor written with no valid texture: core never adds such a tile
      // to `canvas.primary`, so there is no mesh and the whole canvas tier is a no-op.
      if (!this.#warnedNoMesh) {
        this.#warnedNoMesh = true;
        log.warn(
          `tile ${tile.id} has no mesh; its texture may be missing, ` +
            `so the prop cannot be drawn into the scene`
        );
      }
      return;
    }

    if (record.originalTexture === null) record.originalTexture = mesh.texture;
    mesh.texture = texture;
    record.boundKey = key;
  }

  #unbind(record: PropRecord, tile: any): void {
    if (record.boundKey === null) return;
    this.#restore(record, tile);
  }

  /**
   * Put core's own texture back on the mesh.
   *
   * The fallback matters: with no captured texture this used to leave OUR texture in
   * place, and every caller here is on its way to destroying it — so the mesh would be
   * pointing at a destroyed texture. An empty texture draws nothing, which is the correct
   * "not currently ours" state.
   */
  #restore(record: PropRecord, tile?: any): void {
    const mesh = (tile ?? cv()?.tiles?.get(record.id))?.mesh;
    if (mesh) {
      const empty = (globalThis as any).PIXI?.Texture?.EMPTY ?? null;
      mesh.texture = record.originalTexture ?? empty ?? mesh.texture;
    }
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
    log.debug(
      `evicted ${evicted.length} texture(s) to stay under ` +
        `${Math.round(settings.vramBudgetBytes() / 1024 / 1024)} MB`
    );

    // Evicted props demote rather than vanish: the mesh keeps core's own texture.
    for (const record of this.#records.values()) {
      if (record.boundKey && evicted.includes(record.boundKey)) this.#restore(record);
    }

    // And the alpha has to follow. `#recomputeLod` and `#generate` both apply alpha
    // BEFORE trimming, so without this an evicted prop sat at full alpha showing the
    // restored placeholder icon — stretched across a letter — until the next pan, edit or
    // zoom triggered another pass. That is precisely what `#meshAlphaFor` exists to stop.
    this.applyAlpha();
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

/**
 * Play a preset's reveal sound, locally.
 *
 * `reveal.sound` was validated and stored and never read by anything. It is played on
 * THIS client only — the module has no socket, and a reveal is already seen by everyone
 * in the audience because every client runs this for itself.
 *
 * The path is checked before it reaches the audio helper: a preset is meant to be
 * exported and pasted in from a stranger, so the same rule `safeUrl` applies to a texture
 * path applies here — same-origin relative paths only, nothing that could reach out.
 */
function playRevealSound(src: string | null): void {
  if (!src || /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return;

  const AudioHelper = nsAny("audio.AudioHelper", "helpers.AudioHelper");
  try {
    AudioHelper?.play?.({ src, volume: 0.6, autoplay: true, loop: false }, false);
  } catch (error) {
    log.warn(`could not play reveal sound ${src}`, error);
  }
}

/**
 * Whether baking effects onto a page taints the canvas on this browser.
 *
 * Latched after the first failure, because the answer is a property of the browser and
 * retrying it once per prop per LOD pass would waste a full composite every time.
 */
let bakedTaints = false;

/** Which page of a multi-page PDF a pin shows. One-based, as pdf.js counts. */
function pdfPageOf(pin: any): number {
  const raw = Number(pin?.source?.pageId);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 1;
}

/** Every token a player can currently see, which is what a prop fades underneath. */
function visibleTokens(): any[] {
  return (cv()?.tokens?.placeables ?? []).filter((token: any) => token.visible);
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
