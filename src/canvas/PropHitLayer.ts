/**
 * Invisible hit areas so players can interact with props.
 *
 * IMPURE. This layer exists because of one cost of anchoring on `Tile`: the Tiles
 * layer is GM-only, so a player's pointer never reaches a Tile placeable at all. The
 * layer carries one empty container per prop with a rotated polygon hit area, sitting
 * in the `interface` group where player pointer events do arrive.
 *
 * `CanvasLayer`, deliberately NOT `InteractionLayer`: an InteractionLayer ties
 * `interactiveChildren` to whether the layer is *active*, and this layer is never the
 * active one — a player has no layer controls at all. A plain `CanvasLayer` does not
 * escape the flag either: it defaults to `false`, so `sync()` turns it on.
 *
 * The GM gets hit areas too, on ONE layer: Notes, where the module's own tools leave
 * them. Core only lets a Tile be selected while the Tiles layer is active — `control()`
 * returns false anywhere else, with no error and no cursor change — so a GM who placed a
 * pin from the Notes rail and tried to drag it got nothing, and the module shipped a
 * whole toolbar button to say "go to the Tiles layer first". Now a press on a prop from
 * the Notes layer switches layer and selects it, and the next press drags it. Core's
 * own handles still do the moving and resizing; this only removes the detour.
 *
 * Two rules keep it from stealing the canvas:
 *
 * 1. **It sits below tokens and notes**, at a `zIndex` read from those layers at
 *    runtime rather than hardcoded, so a core or module change to the stacking order
 *    moves us with it instead of putting props in front of tokens.
 * 2. **A drag passing over a prop is not a hover.** A token dragged across a letter
 *    must not light it up or pop its tooltip on the way. This used to be "hit areas go
 *    dead during a drag", wired to hooks named `dragLeftStart`/`dragLeftDrop` — which
 *    are callback names inside core's mouse manager, not hooks, so it never ran. A held
 *    button on the hover is the signal core does give.
 */

import { MODULE_ID } from "../const";
import { cfg, cv, g } from "../fvtt";
import { readPin } from "../data/PinData";
import * as api from "../api";
import { isArmed } from "../apps/PlacementGhost";

const LAYER_NAME = "documentsPinnerHits";

let registered = false;

/**
 * Register the layer. Call at `init`, before the canvas is built.
 *
 * `CONFIG.Canvas.layers` is a documented module extension point and is already in live
 * use by other modules in the wild, so this is an addition rather than an override.
 */
export function registerPropHitLayer(): boolean {
  if (registered) return true;

  const config = cfg();
  const CanvasLayer = (globalThis as any).foundry?.canvas?.layers?.CanvasLayer;
  if (!config?.Canvas?.layers || !CanvasLayer) return false;

  config.Canvas.layers[LAYER_NAME] = {
    layerClass: buildLayerClass(CanvasLayer),
    group: "interface",
  };
  registered = true;
  return true;
}

function buildLayerClass(CanvasLayer: any): any {
  return class PropHitLayer extends CanvasLayer {
    /** tileId -> the container carrying that prop's hit area. */
    hits = new Map<string, any>();
    /** The pin under the pointer, so a rebuild can say it is no longer hovered. */
    hovered: any = null;

    static get layerOptions() {
      return { ...(super.layerOptions ?? {}), name: LAYER_NAME };
    }

    async _draw() {
      this.eventMode = "passive";
      this.sortableChildren = true;
      this.zIndex = belowTokens();
      this.sync();
    }

    async _tearDown() {
      this.#clearHover();
      this.removeChildren().forEach((child: any) => child.destroy({ children: true }));
      this.hits.clear();
    }

    /**
     * Rebuild the hit areas from the scene.
     *
     * Full rebuild rather than a diff: a scene holds tens of props, the work is a few
     * polygon allocations, and a diff would be one more place for the hit area and the
     * placeable to drift apart.
     */
    sync() {
      // A destroyed container never receives its `pointerout`, so the pin it was hovering
      // kept its warm light, its tint and its tooltip until the pointer happened to cross
      // another prop — guaranteed on the GM's press from the Notes layer, which switches
      // layer and so rebuilds. The pointer's next move re-establishes a real hover.
      this.#clearHover();
      for (const container of this.hits.values()) container.destroy({ children: true });
      this.hits.clear();

      // v14's `CanvasLayer` declares `interactiveChildren = false` as a class field, so
      // a layer that never says otherwise has every child skipped by the hit test: the
      // press fell through to the stage and not one player could open a prop, on every
      // map (measured on 14.367). Core's own `ControlsLayer` sets it back in its
      // constructor for the same reason. Here it is asserted on every rebuild rather
      // than once, so nothing that touches the flag between draws can strand the layer.
      this.interactiveChildren = true;

      // The GM interacts with the real Tile placeable — on the Tiles layer, where it is
      // interactive and a hit area here would shadow it, and on Tokens, where a
      // rubber-band select across a prop must keep selecting tokens. On Notes, where
      // the module's own tools leave them, the GM gets a way onto the pin.
      const gm = g()?.user?.isGM === true;
      if (gm && !onNotesLayer()) return;

      for (const tile of cv()?.tiles?.placeables ?? []) {
        const pin = readPin(tile.document);
        // BOTH modes. The Tiles layer is GM-only, so a mode skipped here is a mode no
        // player can ever click — and filtering to props made the module's first
        // promise, "a little token players double-click to see the document",
        // unreachable for everyone it was written for. `rotatedPolygon` is already
        // mode-agnostic; nothing else needed to change.
        if (!pin) continue;
        // A GM must always be able to grab a pin, whatever it does for a player.
        if (!gm && pin.interaction.open === "never") continue;
        if (!tile.isVisible) continue;

        // The GM's area is the same whatever the pin does for a player.
        this.addChild(gm ? this.#buildGmHit(tile) : this.#buildHit(tile, pin));
      }
    }

    /**
     * The GM's hit area: a press selects the pin where core can move it, a double
     * click opens it, a hover shows the tooltip the GM authored and could never see.
     *
     * The press switches to the Tiles layer FIRST, because that is the one layer on
     * which `control()` says yes; the selection frame and handles are core's, and the
     * next press on the now-interactive placeable drags. Nothing while a placement is
     * armed — the ghost owns the press then, and landing a pin on top of a prop must
     * not also select the prop.
     */
    #buildGmHit(tile: any): any {
      const PIXI = (globalThis as any).PIXI;
      const doc = tile.document;
      const container = new PIXI.Container();

      container.eventMode = "static";
      container.cursor = "pointer";
      container.hitArea = rotatedPolygon(doc, PIXI);
      container.interactiveChildren = false;

      container.on("pointerdown", (event: any) => {
        if (isArmed() || event?.button === 2) return;
        cv()?.tiles?.activate?.();
        tile.control?.({ releaseOthers: !event?.shiftKey });
        // Handled, as core's own placeables say it: a press left to bubble reached the
        // canvas, whose click closes the HUD that selecting just opened and — with core's
        // "left-click to release" on — released the pin it had just selected.
        event?.stopPropagation?.();
      });
      container.on("pointertap", (event: any) => {
        if (isArmed()) return;
        if (event?.detail === 2) void api.openLocally(doc);
      });
      this.#hover(container, doc);

      this.hits.set(doc.id, container);
      return container;
    }

    #buildHit(tile: any, pin: any): any {
      const PIXI = (globalThis as any).PIXI;
      const doc = tile.document;
      const container = new PIXI.Container();

      container.eventMode = "static";
      container.cursor = "pointer";
      container.hitArea = rotatedPolygon(doc, PIXI);
      container.interactiveChildren = false;

      // A player's press is deliberately left to bubble. A prop can cover a good part of
      // the map, and swallowing the press there would take away the long-press ping on it
      // — "look at this letter" is exactly what a player wants to ping.
      container.on(
        pin.interaction.open === "single" ? "pointerdown" : "pointertap",
        (event: any) => {
          // A double-click open must not also fire the single-click handler underneath.
          if (pin.interaction.open === "double" && event?.detail !== 2) return;
          void api.openLocally(doc);
        }
      );
      this.#hover(container, doc);

      this.hits.set(doc.id, container);
      return container;
    }

    /** Hover in and out, ignoring a pointer that arrives with a button held: a drag. */
    #hover(container: any, doc: any): void {
      container.on("pointerover", (event: any) => {
        if (event?.buttons) return;
        this.hovered = doc;
        Hooks.callAll(`${MODULE_ID}.propHover`, doc, true);
      });
      container.on("pointerout", () => {
        if (this.hovered === doc) this.hovered = null;
        Hooks.callAll(`${MODULE_ID}.propHover`, doc, false);
      });
    }

    #clearHover(): void {
      const doc = this.hovered;
      this.hovered = null;
      if (doc) Hooks.callAll(`${MODULE_ID}.propHover`, doc, false);
    }
  };
}

/** Whether the Notes layer is the active one — the layer the module's tools live on. */
function onNotesLayer(): boolean {
  const canvas = cv();
  return !!canvas?.notes && canvas.activeLayer === canvas.notes;
}

/**
 * A `zIndex` just below whichever of tokens and notes sits lowest.
 *
 * Read at runtime, never hardcoded: core has renumbered the interface layers before,
 * and a stale constant here would put invisible hit areas in front of tokens, which
 * looks exactly like "I cannot click my own token any more".
 */
function belowTokens(): number {
  const canvas = cv();
  const candidates = [canvas?.tokens?.zIndex, canvas?.notes?.zIndex].filter(
    (z) => typeof z === "number"
  ) as number[];
  return candidates.length ? Math.min(...candidates) - 1 : 0;
}

/**
 * The prop's footprint in scene space, rotated about its centre — which is the document's
 * own point on v14 (see `tileRect` in `transform.ts`), so the corners are laid out around
 * `x, y` directly. Deriving a corner from the point first is what put every player's hit
 * area half a card down and right of the paper.
 */
export function rotatedPolygon(doc: any, PIXI: any): any {
  const { x: cx, y: cy, width, height } = doc;
  const rotation = ((doc.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  const corners = [
    [-width / 2, -height / 2],
    [width / 2, -height / 2],
    [width / 2, height / 2],
    [-width / 2, height / 2],
  ].flatMap(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);

  return new PIXI.Polygon(corners);
}

/** The live layer, if the canvas has been drawn. */
export function hitLayer(): any {
  return (cv() as any)?.[LAYER_NAME] ?? null;
}

export function syncHitLayer(): void {
  hitLayer()?.sync?.();
}

declare const Hooks: any;
