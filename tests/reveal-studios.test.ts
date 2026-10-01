/**
 * @vitest-environment jsdom
 *
 * The reveal, editable. The schema had an animation, a duration and a sound on every
 * preset, the runtime played all three, and neither Studio had a control for any of them:
 * a duplicated preset arrived exactly as its ancestor did, forever, and "this one letter
 * should arrive with a thunderclap" was a decision a GM could not make.
 *
 * Driven through the real windows — the change listener, the action handlers, the file
 * browser's callback — and asserted on what is stored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin, validatePin } from "../src/data/pin-schema";
import { presetStudioMarkup } from "../src/apps/PresetStudio";
import { studioMarkup } from "../src/apps/PinStudio";
import { validatePreset } from "../src/effects/preset-schema";
import { CORE_PRESETS } from "../src/effects/presets/core-presets";
import {
  contentOf,
  fakeTile,
  filePickers,
  installWorld,
  playedSounds,
  uninstallWorld,
} from "./helpers/fake-foundry";
import { getCorePreset } from "./helpers/presets";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

const HOSTILE = "https://evil.example/beacon.ogg";

let world: ReturnType<typeof installWorld>;

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '<div id="board"></div>';
});

afterEach(() => uninstallWorld());

/** A world-authored preset, as the library stores one. */
const mine = (reveal: Record<string, unknown> = {}) =>
  validatePreset({
    ...getCorePreset("aged-parchment")!,
    id: "mine",
    label: "Mine",
    author: "user",
    reveal: { animation: "fade", durationMs: 400, sound: null, ...reveal },
  }).preset!;

function change(root: HTMLElement, name: string, value: string) {
  const input = root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;
  input.value = value;
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("the Preset Studio's Reveal group", () => {
  const group = (markup: string) => {
    const root = document.createElement("div");
    root.innerHTML = markup;
    return root.querySelector<HTMLElement>('[data-dp-group="reveal"]')!;
  };

  it("offers the animation, the duration and the sound, holding the preset's values", () => {
    const preset = mine({ animation: "materialise", durationMs: 900, sound: "sounds/lock.wav" });
    const reveal = group(presetStudioMarkup([preset], preset, "map", false, { canBrowse: true }));

    const animation = reveal.querySelector<HTMLSelectElement>('[name="reveal.animation"]')!;
    expect([...animation.options].map((o) => o.value)).toEqual(["none", "fade", "materialise"]);
    expect(animation.value).toBe("materialise");
    const duration = reveal.querySelector<HTMLInputElement>('[name="reveal.durationMs"]')!;
    expect([duration.type, duration.min, duration.max, duration.step, duration.value]).toEqual([
      "range",
      "0",
      "3000",
      "50",
      "900",
    ]);
    expect(reveal.querySelector<HTMLInputElement>('[name="reveal.sound"]')!.value).toBe(
      "sounds/lock.wav"
    );
    const button = (root: HTMLElement, action: string) =>
      root.querySelector<HTMLButtonElement>(`[data-action="${action}"]`);
    for (const action of ["browseRevealSound", "previewRevealSound", "clearRevealSound"]) {
      expect(button(reveal, action)?.disabled, action).toBe(false);
    }

    // Silent, with no file browser: nothing to play or clear, and no browse.
    const silent = group(presetStudioMarkup([mine()], mine(), "map", false));
    expect(button(silent, "previewRevealSound")!.disabled).toBe(true);
    expect(button(silent, "clearRevealSound")!.disabled).toBe(true);
    expect(button(silent, "browseRevealSound")).toBeNull();
  });

  it("locks a shipped preset's reveal, but still lets the GM hear its sound", () => {
    const shipped = {
      ...getCorePreset("sealed-and-wax")!,
      reveal: { animation: "materialise" as const, durationMs: 700, sound: "sounds/lock.wav" },
    };
    const reveal = group(
      presetStudioMarkup(CORE_PRESETS, shipped, "map", false, { canBrowse: true })
    );
    for (const name of ["reveal.animation", "reveal.durationMs", "reveal.sound"]) {
      expect(reveal.querySelector<HTMLInputElement>(`[name="${name}"]`)!.disabled, name).toBe(true);
    }
    const disabled = (action: string) =>
      reveal.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!.disabled;
    expect(disabled("browseRevealSound")).toBe(true);
    expect(disabled("clearRevealSound")).toBe(true);
    expect(disabled("previewRevealSound")).toBe(false);
  });

  describe("driven through the window", () => {
    async function studio(preset = mine()) {
      world = installWorld({ isGM: true, settings: { userPresets: [preset] } });
      const { definePresetStudio } = await import("../src/apps/PresetStudio");
      const app = new (definePresetStudio())();
      app.selectedId = preset.id;
      await app.render();
      return app;
    }
    const stored = () =>
      (world.game.settings.get("", "userPresets") as any[]).find((p) => p.id === "mine").reveal;

    it("writes all three fields", async () => {
      const app = await studio();
      change(contentOf(app), "reveal.animation", "materialise");
      await vi.waitFor(() => expect(stored().animation).toBe("materialise"));
      change(contentOf(app), "reveal.durationMs", "1250");
      await vi.waitFor(() => expect(stored().durationMs).toBe(1250));
      change(contentOf(app), "reveal.sound", "worlds/keep/seal.ogg");
      await vi.waitFor(() => expect(stored().sound).toBe("worlds/keep/seal.ogg"));
    });

    // Typed or picked — an S3 bucket's, say — a sound is stored through the one `setReveal`.
    it("refuses a typed web address, says so, and keeps what was there", async () => {
      const app = await studio(mine({ sound: "sounds/lock.wav" }));
      change(contentOf(app), "reveal.sound", HOSTILE);
      await vi.waitFor(() =>
        expect(world.notifications).toContainEqual({
          type: "warn",
          message: "DP.preset.warn.badSound",
        })
      );
      expect(stored().sound).toBe("sounds/lock.wav");
      await vi.waitFor(() =>
        expect(contentOf(app).querySelector<HTMLInputElement>('[name="reveal.sound"]')!.value).toBe(
          "sounds/lock.wav"
        )
      );
    });

    it("browses audio only, and stores the pick on the preset it was opened for", async () => {
      const app = await studio();
      await app.dispatch("browseRevealSound");
      const [picker] = filePickers();
      expect(picker.options.type).toBe("audio");
      expect(picker.rendered).toEqual([{ force: true }]);

      // The GM selects another preset while the browser is still open.
      app.selectedId = "aged-parchment";
      picker.options.callback!("worlds/keep/thunder.ogg");
      await vi.waitFor(() => expect(stored().sound).toBe("worlds/keep/thunder.ogg"));
    });

    it("plays ▶ even before the browser has unlocked audio, and clears to silence", async () => {
      const app = await studio(mine({ sound: "sounds/lock.wav" }));
      world.game.audio.locked = true;
      await app.dispatch("previewRevealSound");
      expect(playedSounds().map((s) => s.data)).toEqual([
        { src: "sounds/lock.wav", channel: "environment" },
      ]);

      await app.dispatch("clearRevealSound");
      await vi.waitFor(() => expect(stored().sound).toBeNull());
    });
  });
});

describe("the Pin Studio's reveal sound", () => {
  const doc = { id: "t1", elevation: 0, rotation: 0, locked: false, width: 400, height: 560 };
  const pin = (over: Record<string, any> = {}) =>
    validatePin({
      ...defaultPin(),
      ...over,
      effect: { ...defaultPin().effect, ...(over.effect ?? {}) },
    }).pin;
  const field = (markup: string) => {
    const root = document.createElement("div");
    root.innerHTML = markup;
    return root.querySelector<HTMLElement>(".dp-studio__sound")!;
  };

  it("offers a prop its own sound, over the effect's, and nothing to play or clear with none", () => {
    const sound = field(
      studioMarkup(
        doc,
        pin({ mode: "prop", effect: { revealSound: "worlds/keep/seal.ogg" } }),
        "appearance",
        { canBrowse: true }
      )
    );
    expect(sound.querySelector("input")!.value).toBe("worlds/keep/seal.ogg");
    expect(sound.querySelector("input")!.readOnly).toBe(true);
    for (const action of ["browseRevealSound", "previewRevealSound", "clearRevealSound"]) {
      expect(
        sound.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.disabled,
        action
      ).toBe(false);
    }

    const silent = field(
      studioMarkup(doc, pin({ mode: "prop" }), "appearance", { canBrowse: true })
    );
    expect(silent.querySelector("input")!.placeholder).toBe("DP.studio.revealSoundSilent");
    expect(silent.querySelector('[data-action="previewRevealSound"]')).toBeNull();
    expect(silent.querySelector('[data-action="clearRevealSound"]')).toBeNull();
  });

  it("is disabled, with the reason, for an icon — which has no arrival to sound", () => {
    const markup = studioMarkup(
      doc,
      pin({ mode: "pin", effect: { revealSound: "worlds/keep/seal.ogg" } }),
      "appearance",
      { canBrowse: true }
    );
    const sound = field(markup);
    for (const control of sound.querySelectorAll<HTMLInputElement>("input, button")) {
      expect(control.disabled).toBe(true);
    }
    expect(markup).toContain("DP.studio.revealSoundIcon");
  });

  describe("driven through the window", () => {
    let tile: any;

    async function studio(effect: Record<string, unknown> = {}) {
      tile = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
      tile.flags = {
        [MODULE_ID]: {
          [FLAGS.PIN]: {
            ...defaultPin(),
            mode: "prop",
            effect: { ...defaultPin().effect, ...effect },
            audience: { ...defaultPin().audience, kind: "everyone" },
          },
        },
      };
      world = installWorld({ isGM: true, tiles: [tile] });
      const { definePinStudio } = await import("../src/apps/PinStudio");
      const app = new (definePinStudio())();
      app.doc = tile;
      app.tab = "appearance";
      await app.render();
      return app;
    }
    const stored = () => tile.flags[MODULE_ID][FLAGS.PIN].effect.revealSound;

    it("browses audio only and stores the pick as this prop's own", async () => {
      const app = await studio();
      expect(contentOf(app).querySelector('[data-action="browseRevealSound"]')).not.toBeNull();
      await app.dispatch("browseRevealSound");
      const [picker] = filePickers();
      expect(picker.options.type).toBe("audio");
      expect(picker.rendered).toEqual([{ force: true }]);

      picker.options.callback!("worlds/keep/thunder.ogg");
      await vi.waitFor(() => expect(stored()).toBe("worlds/keep/thunder.ogg"));
    });

    it("refuses a web address, says so, and leaves the prop's sound as it was", async () => {
      const app = await studio({ revealSound: "sounds/lock.wav" });
      await app.dispatch("browseRevealSound");
      filePickers()[0].options.callback!(HOSTILE);
      await vi.waitFor(() =>
        expect(world.notifications).toContainEqual({
          type: "warn",
          message: "DP.pin.warn.badSound",
        })
      );
      expect(stored()).toBe("sounds/lock.wav");
      expect(tile.updates).toEqual([]);
    });

    it("plays what the players will hear, and clears back to the effect's", async () => {
      const app = await studio({ revealSound: "worlds/keep/seal.ogg" });
      world.game.audio.locked = true;
      await app.dispatch("previewRevealSound");
      expect(playedSounds().map((s) => s.data.src)).toEqual(["worlds/keep/seal.ogg"]);

      await app.dispatch("clearRevealSound");
      await vi.waitFor(() => expect(stored()).toBeNull());
    });
  });
});
