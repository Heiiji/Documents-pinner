/**
 * @vitest-environment jsdom
 *
 * The reveal sound: "the wax seal cracks as the letter appears".
 *
 * `playRevealSound` existed and ran on every reveal, and every preset was silent, so it
 * had never played anything. Giving it a source — the preset's, or the prop's own — makes
 * three things real at once, and these tests hold each of them:
 *
 * - **A path is a stranger's string.** A preset is pasted in from anywhere (DESIGN §7), and
 *   a sound fetched from someone else's server on every reveal would report the table's
 *   play to them. One rule, `normalise.soundPath`, refuses anything that is not a path on
 *   this server — at import, in a pin's payload, and again at the moment of play.
 * - **It is heard as the players' ambience.** The `environment` channel with no volume of
 *   its own, so each player's slider decides; nothing while their browser is still locked.
 * - **Once per pass.** A bulk reveal of seven sealed letters is one seal cracking.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPin, validatePin } from "../src/data/pin-schema";
import { soundPath } from "../src/normalise";
import { validatePreset } from "../src/effects/preset-schema";
import type { DpNotice } from "../src/types/dp";
import { fakeTile, installWorld, playedSounds, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/render/ContentResolver", () => ({
  resolveCard: vi.fn(async () => ({
    html: '<div class="dp-card">letter</div>',
    title: "Letter",
    readable: true,
    contentHash: "h",
    missing: false,
  })),
}));

vi.mock("../src/render/Rasterizer", () => ({
  loadCardCss: vi.fn(async () => ""),
  rasterise: vi.fn(async () => ({
    texture: { id: "tex", destroy: vi.fn() },
    width: 256,
    height: 256,
    bytes: 1024,
  })),
  rasterisationAvailable: () => true,
  releaseTexture: vi.fn(),
}));

vi.mock("../src/render/AssetInliner", () => ({
  inlineFonts: vi.fn(async () => ""),
  inlineImages: vi.fn(async (html: string) => html),
  registeredFontFamilies: () => [],
}));

/** Every way out of "a path on this server", each different. */
const REFUSED = [
  "https://evil.example/beacon.ogg",
  "http://evil.example/beacon.ogg",
  "HTTPS://evil.example/beacon.ogg",
  "data:audio/ogg;base64,T2dnUw==",
  "javascript:alert(1)",
  "//evil.example/beacon.ogg",
  "\\\\evil.example\\beacon.ogg",
  "/\\evil.example/beacon.ogg",
  // The URL parser strips tabs and newlines; so does the rule, before it looks.
  "java\tscript:alert(1)",
  "/\n/evil.example/beacon.ogg",
  "x".repeat(1025),
];

const ACCEPTED = [
  "worlds/keep/sounds/seal-crack.ogg",
  "sounds/lock.wav",
  "/worlds/keep/sounds/seal.ogg",
  "modules/my-sounds/Thunder clap.mp3",
];

describe("soundPath — the one same-origin rule", () => {
  const read = (value: unknown) => {
    const warnings: DpNotice[] = [];
    const path = soundPath(value, warnings, "reveal.sound", "DP.preset.warn.badSound");
    return { path, warnings };
  };

  it.each(ACCEPTED)("keeps the path %s", (value) => {
    expect(read(value)).toEqual({ path: value, warnings: [] });
  });

  it("trims a pasted path and strips the characters a URL parser would", () => {
    expect(read("  sounds/lock.wav\n").path).toBe("sounds/lock.wav");
  });

  it("reads nothing as 'no sound', silently", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(read(value)).toEqual({ path: null, warnings: [] });
    }
  });

  it.each(REFUSED)("refuses %j with a warning", (value) => {
    const { path, warnings } = read(value);
    expect(path).toBeNull();
    expect(warnings).toEqual([
      {
        key: "DP.preset.warn.badSound",
        data: { path: "reveal.sound", value: String(value).slice(0, 64) },
      },
    ]);
  });

  it("refuses what is not a string at all", () => {
    for (const value of [42, true, { src: "sounds/lock.wav" }, ["sounds/lock.wav"]]) {
      expect(read(value).path).toBeNull();
      expect(read(value).warnings).toHaveLength(1);
    }
  });
});

describe("a preset's sound", () => {
  it.each(REFUSED.slice(0, 7))("is refused at validation when it is %j", (sound) => {
    const { preset, warnings } = validatePreset({ id: "gift", reveal: { sound } });
    expect(preset!.reveal.sound).toBeNull();
    expect(warnings.map((w) => w.key)).toContain("DP.preset.warn.badSound");
  });

  it("keeps a path on this server", () => {
    const { preset, warnings } = validatePreset({
      id: "mine",
      reveal: { sound: "worlds/keep/sounds/seal.ogg" },
    });
    expect(preset!.reveal.sound).toBe("worlds/keep/sounds/seal.ogg");
    expect(warnings).toEqual([]);
  });

  it("is refused on import, said to the GM, and never stored", async () => {
    const world = installWorld({ isGM: true, settings: { userPresets: [] } });
    try {
      const { importPreset } = await import("../src/effects/preset-library");
      const imported = await importPreset(
        JSON.stringify({
          id: "gift",
          label: "Gift",
          reveal: { sound: "https://evil.example/b.ogg" },
        })
      );
      expect(imported!.reveal.sound).toBeNull();
      expect(world.notifications).toContainEqual({
        type: "warn",
        message: "DP.preset.warn.badSound",
      });
      const stored = (world.game.settings.get("", "userPresets") as any[])[0];
      expect(JSON.stringify(stored)).not.toContain("evil.example");
    } finally {
      uninstallWorld();
    }
  });
});

describe("a prop's own sound", () => {
  const withSound = (revealSound: unknown) =>
    validatePin({ ...defaultPin(), effect: { ...defaultPin().effect, revealSound } });

  it("is stored when it is a path on this server", () => {
    expect(withSound("worlds/keep/thunder.ogg").pin.effect.revealSound).toBe(
      "worlds/keep/thunder.ogg"
    );
  });

  it.each(REFUSED.slice(0, 7))("is refused in the payload when it is %j", (value) => {
    const { pin, warnings } = withSound(value);
    expect(pin.effect.revealSound).toBeNull();
    expect(warnings.map((w) => w.key)).toContain("DP.pin.warn.badSound");
  });

  it("is 'the preset's' on a version 4 payload that never had one", () => {
    const v4: any = { ...defaultPin(), v: 4, effect: { ...defaultPin().effect } };
    delete v4.effect.revealSound;
    const { pin, warnings } = validatePin(v4);
    expect(pin.effect.revealSound).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe("playing it", () => {
  let world: ReturnType<typeof installWorld>;

  beforeEach(() => {
    vi.resetModules();
    world = installWorld({ isGM: false });
  });

  afterEach(() => uninstallWorld());

  const play = async (src: string | null, options?: { preview?: boolean }) => {
    const { playRevealSound } = await import("../src/canvas/PropManager");
    return playRevealSound(src, options);
  };

  it("plays on the environment channel, with no volume of its own and no broadcast", async () => {
    expect(await play("worlds/keep/seal.ogg")).toBe(true);
    expect(playedSounds()).toEqual([
      { data: { src: "worlds/keep/seal.ogg", channel: "environment" }, socket: false },
    ]);
  });

  it("re-checks the path at the moment of play, whatever reached it", async () => {
    for (const src of REFUSED) expect(await play(src), src).toBe(false);
    expect(playedSounds()).toEqual([]);
  });

  it("waits out a browser that has not unlocked audio, except for the GM's own ▶", async () => {
    world.game.audio.locked = true;
    expect(await play("worlds/keep/seal.ogg")).toBe(false);
    expect(playedSounds()).toEqual([]);

    expect(await play("worlds/keep/seal.ogg", { preview: true })).toBe(true);
    expect(playedSounds()).toHaveLength(1);
  });

  it("leaves the channel to core where core has no environment channel", async () => {
    delete (globalThis as any).foundry.CONST;
    delete (globalThis as any).CONST;
    await play("worlds/keep/seal.ogg");
    expect(playedSounds()[0].data).toEqual({ src: "worlds/keep/seal.ogg" });
  });

  it("never throws into the LOD pass: no helper, a helper that throws, or one that rejects", async () => {
    const helper = (globalThis as any).foundry.audio;
    helper.AudioHelper = {
      play: () => {
        throw new Error("decode");
      },
    };
    expect(await play("worlds/keep/seal.ogg")).toBe(false);

    const rejected = vi.fn();
    process.on("unhandledRejection", rejected);
    helper.AudioHelper = { play: () => Promise.reject(new Error("404")) };
    expect(await play("worlds/keep/seal.ogg")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", rejected);
    expect(rejected).not.toHaveBeenCalled();

    delete helper.AudioHelper;
    expect(await play("worlds/keep/seal.ogg")).toBe(false);
  });
});

/**
 * Through the manager's own pass, which is where a reveal is noticed: a prop this client
 * could not see becomes visible. A player's client, since the GM's never sees one arrive.
 */
describe("a reveal pass", () => {
  let tiles: any[];
  let manager: any;
  const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

  function propTile(id: string, effect: Record<string, unknown> = {}) {
    const tile = fakeTile({ id, uuid: `Scene.s1.Tile.${id}`, width: 400, height: 560 });
    tile.flags = {
      "documents-pinner": {
        pin: {
          ...defaultPin(),
          mode: "prop",
          source: { ...defaultPin().source, uuid: `JournalEntry.${id}` },
          effect: { ...defaultPin().effect, ...effect },
          audience: { ...defaultPin().audience, kind: "everyone" },
        },
      },
    };
    return tile;
  }

  /** The preset a GM authored with a sound, in the world's own library. */
  const THUNDER = {
    id: "thunder",
    label: "Thunder",
    author: "user",
    reveal: { animation: "fade", durationMs: 400, sound: "worlds/keep/thunder.ogg" },
  };

  async function sceneWith(...placed: any[]) {
    vi.resetModules();
    tiles = placed;
    installWorld({
      isGM: false,
      tiles,
      settings: {
        rendering: "canvas",
        autoDegrade: false,
        effectsLevel: "full",
        userPresets: [THUNDER],
      },
    });
    const { propManager } = await import("../src/canvas/PropManager");
    manager = propManager();
    manager.refresh();
    await settle();
  }

  async function reveal(...ids: string[]) {
    for (const tile of tiles) if (ids.includes(tile.id)) tile.object.isVisible = false;
    manager.refresh();
    await settle();
    for (const tile of tiles) if (ids.includes(tile.id)) tile.object.isVisible = true;
    manager.refresh();
    await settle();
  }

  afterEach(() => {
    manager?.stop();
    uninstallWorld();
  });

  it("plays nothing for props already on screen when the scene loads", async () => {
    await sceneWith(propTile("a", { id: "thunder" }));
    expect(playedSounds()).toEqual([]);
  });

  it("plays the preset's sound once when two props wearing it arrive together", async () => {
    await sceneWith(propTile("a", { id: "thunder" }), propTile("b", { id: "thunder" }));
    await reveal("a", "b");
    expect(playedSounds()).toEqual([
      { data: { src: "worlds/keep/thunder.ogg", channel: "environment" }, socket: false },
    ]);
  });

  it("plays the prop's own sound over its preset's", async () => {
    await sceneWith(propTile("a", { id: "thunder", revealSound: "worlds/keep/seal.ogg" }));
    await reveal("a");
    expect(playedSounds().map((s) => s.data.src)).toEqual(["worlds/keep/seal.ogg"]);
  });

  it("plays each different sound once in the same pass", async () => {
    await sceneWith(
      propTile("a", { id: "thunder" }),
      propTile("b", { id: "none", revealSound: "worlds/keep/seal.ogg" }),
      propTile("c", { id: "thunder" })
    );
    await reveal("a", "b", "c");
    expect(
      playedSounds()
        .map((s) => s.data.src)
        .sort()
    ).toEqual(["worlds/keep/seal.ogg", "worlds/keep/thunder.ogg"]);
  });

  it("plays again on the next reveal — once per pass, not once ever", async () => {
    await sceneWith(propTile("a", { id: "thunder" }));
    await reveal("a");
    await reveal("a");
    expect(playedSounds()).toHaveLength(2);
  });
});
