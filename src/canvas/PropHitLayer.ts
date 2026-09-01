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
 * active one — a player has no layer controls at all.
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
 * 2. **Hit areas go dead during a drag or a measurement.** A GM dragging a token
 *    across a letter, or pulling a ruler over it, must not have the gesture swallowed
 *    by a prop underneath.
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
    suspended = false;

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
      for (const container of this.hits.values()) container.destroy({ children: true });
      this.hits.clear();

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
        if (this.suspended || isArmed() || event?.button === 2) return;
        cv()?.tiles?.activate?.();
        tile.control?.({ releaseOthers: !event?.shiftKey });
      });
      container.on("pointertap", (event: any) => {
        if (this.suspended || isArmed()) return;
        if (event?.detail === 2) void api.openLocally(doc);
      });
      container.on("pointerover", () => Hooks.callAll(`${MODULE_ID}.propHover`, doc, true));
      container.on("pointerout", () => Hooks.callAll(`${MODULE_ID}.propHover`, doc, false));

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

      const open = () => {
        if (this.suspended) return;
        void api.openLocally(doc);
      };
      container.on(
        pin.interaction.open === "single" ? "pointerdown" : "pointertap",
        (event: any) => {
          // A double-click open must not also fire the single-click handler underneath.
          if (pin.interaction.open === "double" && event?.detail !== 2) return;
          open();
        }
      );
      container.on("pointerover", () => Hooks.callAll(`${MODULE_ID}.propHover`, doc, true));
      container.on("pointerout", () => Hooks.callAll(`${MODULE_ID}.propHover`, doc, false));

      this.hits.set(doc.id, container);
      return container;
    }

    /** Go dead while another gesture owns the pointer. */
    suspend(active: boolean) {
      this.suspended = active;
      this.eventMode = active ? "none" : "passive";
      for (const container of this.hits.values()) {
        container.eventMode = active ? "none" : "static";
      }
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

export function suspendHits(active: boolean): void {
  hitLayer()?.suspend?.(active);
}

declare const Hooks: any;
