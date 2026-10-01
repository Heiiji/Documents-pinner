/**
 * @vitest-environment jsdom
 *
 * The two `<form>` windows, and what core does with a form's `change`.
 *
 * Core merges `DEFAULT_OPTIONS` down the class chain (foundry.mjs 30428-30475) and, on a
 * form's `change`, submits it when `form.submitOnChange` is set (32148). The HUD inherited
 * BasePlaceableHUD's `submitOnChange: true` and its handler (97788-97801), so every slider
 * and checkbox commit ran `_onSubmit` (98041), which updates the tile with the named
 * fields that changed — the HUD has none, so `update({})` — and every module's
 * `preUpdateTile` with it. Pin Studio asked for `submitOnChange` with no handler, which
 * built a `FormDataExtended` of the whole form on every change and did nothing with it.
 *
 * Both stay forms: a button inside a `<form>` is a field to core's keyboard (`hasFocus`,
 * 133689), so a key on it is not also a core binding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import {
  contentOf,
  fakeBasePlaceableHUD,
  fakeTile,
  installWorld,
  uninstallWorld,
} from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

/** ApplicationV2's own `form` default (foundry.mjs 30079-30083). */
const APPLICATION_V2 = {
  form: { handler: undefined, submitOnChange: false, closeOnSubmit: false },
};

/** BasePlaceableHUD's options (foundry.mjs 97788-97801), its handler `_onSubmit`'s gist. */
function baseHudOptions() {
  return {
    id: "placeable-hud-{id}",
    classes: ["placeable-hud"],
    tag: "form",
    window: { frame: false, positioned: true },
    form: {
      handler(this: any) {
        // `_onSubmit` keeps only the changed field's name; the HUD's controls have none.
        return this.object.document.update({});
      },
      submitOnChange: true,
      closeOnSubmit: false,
    },
  };
}

/** A value as `foundry.utils.deepClone` copies it: plain objects and arrays, the rest kept. */
function clone(value: any): any {
  if (Array.isArray(value)) return value.map(clone);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clone(v)]));
  }
  return value;
}

/** `ApplicationV2#_initializeApplicationOptions`' merge, down the class chain. */
function coreOptions(cls: any): any {
  const order: any[] = [APPLICATION_V2];
  const chain: any[] = [];
  for (let at = cls; at && at !== Function.prototype; at = Object.getPrototypeOf(at)) {
    if (Object.hasOwn(at, "DEFAULT_OPTIONS")) chain.unshift(at.DEFAULT_OPTIONS);
  }
  order.push(...chain);
  const merge = (into: any, from: any) => {
    for (const [key, value] of Object.entries(from)) {
      const copy = clone(value);
      if (!(key in into)) into[key] = copy;
      else if (Array.isArray(into[key])) into[key].push(...copy);
      else if (into[key] && Object.getPrototypeOf(into[key]) === Object.prototype) {
        merge(into[key], copy);
      } else into[key] = copy;
    }
  };
  const options: any = {};
  for (const opts of order) merge(options, opts);
  return options;
}

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="hud"></div>';
});

afterEach(() => uninstallWorld());

describe("the Pin HUD's form", () => {
  async function hudOver(tile: any) {
    installWorld({ isGM: true, tiles: [tile] });
    // Core's HUD base, with its options, where `definePinHUD` looks for it.
    (globalThis as any).foundry.applications.hud.BasePlaceableHUD = class BasePlaceableHUD extends (
      fakeBasePlaceableHUD()
    ) {
      static DEFAULT_OPTIONS = baseHudOptions();
    };
    const { definePinHUD } = await import("../src/apps/PinHUD");
    const PinHUD = definePinHUD();
    const hud = new PinHUD();
    document.body.appendChild(contentOf(hud));
    await hud.bind(tile.object);
    return { hud, options: coreOptions(PinHUD) };
  }

  function pinnedTile() {
    const tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1" });
    tile.flags = {
      "documents-pinner": {
        pin: {
          ...defaultPin(),
          mode: "prop",
          audience: { ...defaultPin().audience, kind: "everyone" },
        },
      },
    };
    return tile;
  }

  it("stays a form, keeps core's handler, and does not submit on change", async () => {
    const { options } = await hudOver(pinnedTile());
    expect(options.tag).toBe("form");
    expect(typeof options.form.handler).toBe("function");
    expect(options.form.submitOnChange).toBe(false);
  });

  it("moves its intensity without an empty update of the tile", async () => {
    const tile = pinnedTile();
    const { hud, options } = await hudOver(tile);
    const update = vi.spyOn(tile, "update");
    // Core's own form listener (foundry.mjs 31888, 32148), as the real HUD has it.
    contentOf(hud).addEventListener("change", (event) => {
      if (options.form.submitOnChange) options.form.handler.call(hud, event);
    });

    const slider = contentOf(hud).querySelector<HTMLInputElement>('[data-action="setIntensity"]')!;
    slider.value = "40";
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(update).toHaveBeenCalled());

    const empty = update.mock.calls.filter(([changes]) => !Object.keys(changes ?? {}).length);
    expect(empty).toEqual([]);
  });
});

describe("Pin Studio's form", () => {
  it("stays a form that does not close on submit, and does not submit on change", async () => {
    installWorld({ isGM: true });
    const { definePinStudio } = await import("../src/apps/PinStudio");
    const options = coreOptions(definePinStudio());
    expect(options.tag).toBe("form");
    expect(options.form.closeOnSubmit).toBe(false);
    expect(options.form.submitOnChange).toBe(false);
  });
});
