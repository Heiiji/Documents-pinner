/**
 * The Tile placeable, extended for pins.
 *
 * IMPURE. Registered by CHAINING the current `CONFIG.Tile.objectClass` at `init`
 * rather than replacing it, so a system or another module that has already subclassed
 * Tile keeps its behaviour and ours composes on top. Replacing it outright is how two
 * modules that both "just set objectClass" silently break each other.
 *
 * The audience model rides on `isVisible`, so that getter is the single point every
 * other visibility question is answered through. Two safeguards sit around it:
 *
 * 1. `_refreshVisibility` also hides the mesh EXPLICITLY. Whether overriding
 *    `isVisible` propagates to `mesh.visible` on its own was the one probe that came
 *    back inconclusive, and the failure mode — a player seeing a prop they are not in
 *    the audience for — is the worst one this module has. So it never depends on it.
 * 2. That safeguard can only ever hide, never show. Core sets `mesh.visible` for its
 *    own reasons (occlusion, culling, roof fade), and forcing it true would fight
 *    every one of them.
 *
 * **The transform is never touched.** Core owns the mesh's position, size, rotation
 * and anchor completely; v14 moved the mesh position to equal the document's own, and
 * a module that adjusts any of it will be wrong the next time that changes.
 *
 * **The drag preview is dressed, never moved.** A press-and-drag on the Tiles layer makes
 * core clone each controlled tile into the layer's preview container and move the clones;
 * the originals stay put until the drop commits. A clone is drawn from `_original.texture`
 * — the placeholder book every anchor is created with — never from what the prop manager
 * bound to the original's mesh, and the manager never sees a clone at all: it walks
 * `canvas.tiles.placeables`, and a preview is in neither that list nor the document
 * collection. So the clone's mesh is dressed here: to nothing on the DOM path, where the
 * card is the prop and follows the clone, and to the original's own page on the canvas
 * path. The clone keeps the original's document id, which is what lets the card be found.
 */

import { MODULE_ID } from "../const";
import { logger } from "../log";
import { cfg, cv, g } from "../fvtt";
import { canSee } from "../data/audience";
import { readPin } from "../data/PinData";
import * as api from "../api";
import { hidePinHUD, showPinHUD } from "../apps/PinHUD";
import { repositionReader } from "../apps/ReaderOverlay";
import { drawsAsDom } from "./PropManager";
import { followDomProp, setDomPropControlled } from "./DomPropTier";
import { centreOf, rotatedBounds, tileRect } from "./transform";
import type { DpPinFlags } from "../types/dp";

const log = logger("tile");

let installed = false;

/** Chain our subclass onto whatever `CONFIG.Tile.objectClass` currently is. */
export function definePinnedTile(): boolean {
  if (installed) return true;

  const config = cfg();
  const Base = config?.Tile?.objectClass;
  if (!Base) return false;

  config.Tile.objectClass = class PinnedTile extends Base {
    /**
     * Set between a drop and the update it commits, on every controlled pin.
     *
     * The clones are gone the moment the drop happens and the originals have not moved
     * yet, so a refresh of an original in that window would pull its card back to where
     * the drag started for one server round trip. `_onUpdate` clears it; so does a
     * release, and the next LOD pass re-places the card from the real document anyway.
     */
    _dpDropPending = false;

    /** Whether this preview's mesh carries a page borrowed from the original. */
    #borrowedPage = false;

    /** The validated payload, or null when this tile is an ordinary tile. */
    get pin(): DpPinFlags | null {
      return readPin(this.document);
    }

    /**
     * The single visibility predicate for the whole module.
     *
     * Delegates to the pure `canSee`, with line of sight injected rather than computed
     * inside it — the rule stays testable under Node and the expensive part stays here
     * where it can be skipped for the three audience kinds that do not need it.
     */
    get isVisible(): boolean {
      const pin = this.pin;
      if (!pin) return super.isVisible;

      const user = g()?.user;
      return canSee(pin.audience, {
        isGM: user?.isGM === true,
        userId: user?.id ?? "",
        hidden: this.document.hidden === true,
        hasLineOfSight: pin.audience.kind === "discovered" ? this.#hasLineOfSight() : undefined,
      });
    }

    /**
     * Whether this client's own vision reaches the pin.
     *
     * Evaluated locally on every client, never broadcast: each player's sight is their
     * own, and asking the GM's client what a player can see would be both wrong and a
     * round trip. `object: this` lets core account for the placeable's own footprint
     * rather than testing a bare point at its centre — which is the document's own point.
     */
    #hasLineOfSight(): boolean {
      const visibility = cv()?.visibility;
      if (!visibility?.testVisibility) return false;

      try {
        return (
          visibility.testVisibility(centreOf(this.document), { tolerance: 0, object: this }) ===
          true
        );
      } catch {
        return false;
      }
    }

    /** Core's drag clone of a prop: `_original` points at the real placeable. */
    #previewProp(): boolean {
      return !!(this.isPreview ?? this._original) && this.pin?.mode === "prop";
    }

    /**
     * Give the preview clone the right thing to show.
     *
     * DOM path: nothing. The card is the prop, it follows the clone, and the placeholder
     * book stretched to letter size under it is exactly the artefact the manager holds
     * the real mesh at zero to avoid. Canvas path: the page the original's mesh is showing
     * — a texture the manager bound, which a clone drawn from `_original.texture` never
     * gets. Re-applied after every core refresh that writes `document.alpha` back.
     */
    #dressPreview(): void {
      const mesh = this.mesh;
      const original = this._original;
      const pin = this.pin;
      if (!mesh || !original || !pin) return;

      if (drawsAsDom(pin)) {
        mesh.alpha = 0;
        return;
      }
      const page = original.mesh?.texture;
      if (page && page !== original.texture && mesh.texture !== page) {
        mesh.texture = page;
        this.#borrowedPage = true;
      }
    }

    /**
     * Hide the mesh explicitly when we say it is not visible.
     *
     * Only ever downward: see the note at the top of the file.
     */
    _refreshVisibility() {
      super._refreshVisibility?.();
      if (!this.pin) return;
      if (!this.isVisible && this.mesh) this.mesh.visible = false;
    }

    _refreshState() {
      super._refreshState?.();
      if (this.#previewProp()) this.#dressPreview();
    }

    _refreshMesh() {
      super._refreshMesh?.();
      if (this.#previewProp()) this.#dressPreview();
    }

    /** Players never select, drag or edit a pin. Only the GM controls the anchor. */
    _canControl(user: any, event?: any): boolean {
      if (!this.pin) return super._canControl(user, event);
      return user?.isGM === true;
    }

    /**
     * Hovering is what gives a player the cursor affordance that says "this opens".
     * It is therefore allowed exactly when the pin is both visible to them and
     * actually openable — an interactive-looking prop that does nothing is worse than
     * one that never looked interactive.
     */
    _canHover(user: any, event?: any): boolean {
      const pin = this.pin;
      if (!pin) return super._canHover(user, event);
      if (user?.isGM) return true;
      return this.isVisible && pin.interaction.open !== "never";
    }

    /** Double-click opens, for whichever side of the screen is doing it. */
    _onClickLeft2(event: any) {
      const pin = this.pin;
      if (!pin || pin.interaction.open === "never") return super._onClickLeft2?.(event);

      if (g()?.user?.isGM) {
        // A GM double-clicking wants to look at it, not to reveal it to the table.
        void api.openLocally(this.document);
        return;
      }
      if (pin.interaction.open === "double" || pin.interaction.open === "single") {
        void api.openLocally(this.document);
      }
    }

    _onClickLeft(event: any) {
      const pin = this.pin;
      if (pin && !g()?.user?.isGM && pin.interaction.open === "single") {
        void api.openLocally(this.document);
        return;
      }
      return super._onClickLeft?.(event);
    }

    /**
     * A pin gets OUR HUD, and core's own flow must survive it failing.
     *
     * `control()` sets `_controlled`, calls this, and only THEN sets the render flag that
     * draws the selection frame and the resize handles. Anything thrown in here therefore
     * leaves a placeable that is selected but has no frame and cannot be dragged or
     * resized — which is exactly what a getter-only `BasePlaceableHUD#object` did. Module
     * code has no business breaking core's control flow, so it cannot.
     *
     * The DOM card is told too: core's frame and handle are drawn under the card, which
     * is opaque, so the card draws its own copy of both.
     */
    _onControl(options?: any) {
      const result = super._onControl?.(options);
      try {
        if (this.pin) {
          setDomPropControlled(this.document.id, true);
          showPinHUD(this);
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | pin HUD failed to open`, error);
      }
      return result;
    }

    _onRelease(options?: any) {
      this._dpDropPending = false;
      try {
        if (this.pin) {
          setDomPropControlled(this.document.id, false);
          hidePinHUD();
        }
      } catch (error) {
        console.warn(`${MODULE_ID} | pin HUD failed to close`, error);
      }
      return super._onRelease?.(options);
    }

    /**
     * Core moves the clones; the cards follow them, synchronously, under the originals'
     * ids. No hook is relied on for this — `refreshTile` fires for the clone on most
     * builds and `onTileRefreshed` handles it when it does, but the drag must not depend
     * on it.
     */
    _onDragLeftMove(event: any) {
      const result = super._onDragLeftMove?.(event);
      for (const clone of previewPropsOf(this, event)) {
        followDomProp(clone.document, clone._original?.document?.id ?? clone.document?.id);
      }
      return result;
    }

    _onDragLeftDrop(event: any) {
      for (const object of this.layer?.controlled ?? [this]) {
        if (readPin(object?.document)) object._dpDropPending = true;
      }
      return super._onDragLeftDrop?.(event);
    }

    /** The clones are gone and nothing was committed: every card goes back to its tile. */
    _onDragLeftCancel(event: any) {
      const result = super._onDragLeftCancel?.(event);
      for (const object of this.layer?.controlled ?? [this]) {
        if (!object?.document) continue;
        object._dpDropPending = false;
        if (readPin(object.document)?.mode === "prop") followDomProp(object.document);
      }
      return result;
    }

    _onUpdate(changed: any, options: any, userId: string) {
      this._dpDropPending = false;
      return super._onUpdate?.(changed, options, userId);
    }

    /**
     * A drawn pin tells the manager, so the texture it captured to restore later is
     * fresh. A drawn PREVIEW tells nobody: it carries the original's id, and reporting it
     * would null the original's binding and capture the clone's throw-away mesh as the
     * texture to restore onto the real one.
     */
    async _draw(options?: any) {
      await super._draw(options);
      if (!this.pin) return;
      if (this.#previewProp()) this.#dressPreview();
      else Hooks.callAll(`${MODULE_ID}.tileDrawn`, this);
    }

    _destroy(options?: any) {
      if (this.#previewProp()) {
        // A borrowed page belongs to the original's mesh and to the texture cache; the
        // clone goes without it, whatever core's teardown does to a mesh's texture.
        if (this.#borrowedPage && this.mesh) {
          this.mesh.texture =
            this._original?.texture ??
            (globalThis as any).PIXI?.Texture?.EMPTY ??
            this.mesh.texture;
          this.#borrowedPage = false;
        }
      } else if (this.pin) {
        Hooks.callAll(`${MODULE_ID}.tileDestroyed`, this);
      }
      return super._destroy?.(options);
    }
  };

  installed = true;
  return true;
}

/** The prop previews of a drag, wherever this build keeps them. */
function previewPropsOf(tile: any, event: any): any[] {
  const inLayer: any[] | undefined = tile?.layer?.preview?.children;
  const clones: any[] = inLayer?.length ? inLayer : (event?.interactionData?.clones ?? []);
  return clones.filter(
    (clone: any) =>
      clone && !!(clone.isPreview ?? clone._original) && readPin(clone.document)?.mode === "prop"
  );
}

/**
 * The `refreshTile` hook, made preview-aware.
 *
 * Core's resize handles mutate the document in memory on every tick of the drag and fire
 * this hook; the commit only arrives as `updateTile` on release. The DOM card and the
 * reader follow the handles live through two dirty-checked re-placers, so a refresh that
 * moved nothing costs a few compares.
 *
 * A preview clone speaks for its original: its document is the one being dragged, and
 * the card it moves is the original's. An original that HAS a preview, or whose drop is
 * on the wire, says nothing — its document is where the drag started, and following it
 * would pull the card back under the pointer for a round trip.
 */
export function onTileRefreshed(tile: any): void {
  const doc = tile?.document;
  if (readPin(doc)?.mode !== "prop") return;

  if (tile.isPreview ?? tile._original) {
    followDomProp(doc, tile._original?.document?.id ?? doc.id);
    return;
  }
  if ((tile.hasPreview ?? tile._preview) || tile._dpDropPending) return;

  followDomProp(doc);
  repositionReader();
}

/**
 * Ask the live canvas whether a TileDocument's point is still its centre.
 *
 * Every placement in the module rests on one measured fact — see `tileRect` — and the
 * type definitions shipped with the same generation of core say otherwise. Nothing the
 * module can read at build time will tell it when core changes its mind, so the first
 * drawn tile of every scene is compared with core's own `bounds`, and disagreement is
 * said out loud rather than shown as a prop half a card away from its frame. Any tile
 * will do: the convention is core's, not the module's.
 */
export function checkTileGeometry(): "agree" | "disagree" | "untested" {
  const tiles: any[] = (cv()?.tiles?.placeables ?? []).filter(
    (tile: any) => Number.isFinite(tile?.bounds?.x) && Number.isFinite(tile?.document?.x)
  );
  // An unrotated tile is the cleanest witness; a rotated one still answers.
  const tile = tiles.find((t) => !t.document.rotation) ?? tiles[0];
  if (!tile) return "untested";

  const doc = tile.document;
  const expected = rotatedBounds(tileRect(doc));
  const bounds = tile.bounds;
  const centre = tile.center;
  const off = (a: number, b: number) => Math.abs(a - b) > 0.5;
  const disagree =
    off(bounds.x, expected.x) ||
    off(bounds.y, expected.y) ||
    off(bounds.width, expected.width) ||
    off(bounds.height, expected.height) ||
    (centre && Number.isFinite(centre.x) && (off(centre.x, doc.x) || off(centre.y, doc.y)));

  if (disagree) {
    log.warn(
      "TileDocument x, y no longer means what transform.tileRect assumes; every prop, hit " +
        "area and reader will sit off its tile until the module is updated",
      {
        core: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, centre },
        assumed: expected,
        document: {
          x: doc.x,
          y: doc.y,
          width: doc.width,
          height: doc.height,
          rotation: doc.rotation,
        },
      }
    );
    return "disagree";
  }
  log.debug("tile geometry agrees with core: the document's point is its centre");
  return "agree";
}

/**
 * Redraw every pin on the canvas.
 *
 * Used when something outside a single document changes what pins should look like —
 * a user connecting, the effect level changing, a peek starting. Cheap: it sets render
 * flags and lets core's own batching decide when to actually draw.
 */
export function refreshAllPins(): void {
  for (const tile of cv()?.tiles?.placeables ?? []) {
    if (!readPin(tile.document)) continue;
    tile.renderFlags?.set?.({ refreshVisibility: true });
  }
}

declare const Hooks: any;
