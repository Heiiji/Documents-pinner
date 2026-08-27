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
 */

import { MODULE_ID } from "../const";
import { cfg, cv, g } from "../fvtt";
import { canSee } from "../data/audience";
import { readPin } from "../data/PinData";
import * as api from "../api";
import { hidePinHUD, showPinHUD } from "../apps/PinHUD";
import type { DpPinFlags } from "../types/dp";

let installed = false;

/** Chain our subclass onto whatever `CONFIG.Tile.objectClass` currently is. */
export function definePinnedTile(): boolean {
  if (installed) return true;

  const config = cfg();
  const Base = config?.Tile?.objectClass;
  if (!Base) return false;

  config.Tile.objectClass = class PinnedTile extends Base {
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
     * rather than testing a bare point at its centre.
     */
    #hasLineOfSight(): boolean {
      const visibility = cv()?.visibility;
      if (!visibility?.testVisibility) return false;

      const centre = {
        x: this.document.x + this.document.width / 2,
        y: this.document.y + this.document.height / 2,
      };
      try {
        return visibility.testVisibility(centre, { tolerance: 0, object: this }) === true;
      } catch {
        return false;
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
     * A pin gets OUR HUD, not core's TileHUD.
     *
     * Core's answers "where and how big is this tile"; ours answers "who can see this
     * and what does it look like", which is the whole product. Falling through to
     * `super` for an ordinary tile keeps the Tiles layer working exactly as before.
     */
    /**
     * A pin gets OUR HUD, and core's own flow must survive it failing.
     *
     * `control()` sets `_controlled`, calls this, and only THEN sets the render flag that
     * draws the selection frame and the resize handles. Anything thrown in here therefore
     * leaves a placeable that is selected but has no frame and cannot be dragged or
     * resized — which is exactly what a getter-only `BasePlaceableHUD#object` did. Module
     * code has no business breaking core's control flow, so it cannot.
     */
    _onControl(options?: any) {
      const result = super._onControl?.(options);
      try {
        if (this.pin) showPinHUD(this);
      } catch (error) {
        console.warn(`${MODULE_ID} | pin HUD failed to open`, error);
      }
      return result;
    }

    _onRelease(options?: any) {
      try {
        if (this.pin) hidePinHUD();
      } catch (error) {
        console.warn(`${MODULE_ID} | pin HUD failed to close`, error);
      }
      return super._onRelease?.(options);
    }

    async _draw(options?: any) {
      await super._draw(options);
      if (this.pin) Hooks.callAll(`${MODULE_ID}.tileDrawn`, this);
    }

    _destroy(options?: any) {
      if (this.pin) Hooks.callAll(`${MODULE_ID}.tileDestroyed`, this);
      return super._destroy?.(options);
    }
  };

  installed = true;
  return true;
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
