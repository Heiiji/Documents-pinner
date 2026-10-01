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

  it("keeps a path on this server, trimmed, and reads nothing as 'no sound' — silently", () => {
    for (const value of ACCEPTED) expect(read(value), value).toEqual({ path: value, warnings: [] });
    // A pasted path, and the characters a URL parser would strip.
    expect(read("  sounds/lock.wav\n")).toEqual({ path: "sounds/lock.wav", warnings: [] });
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

/**
 * The rule's callers, each proved to call it with its own warning; the rule's cases are
 * the table above. A preset's path that IS on this server is played in "a reveal pass"
 * below, from a library that reads its presets through the same validation.
 */
describe("the rule's callers", () => {
  const withSound = (revealSound: unknown) =>
    validatePin({ ...defaultPin(), effect: { ...defaultPin().effect, revealSound } });

  it("refuses a preset's sound on import, says so to the GM, and never stores it", async () => {
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

  it("stores a prop's own sound on this server, and refuses any other with the pin's warning", () => {
    expect(withSound("worlds/keep/thunder.ogg").pin.effect.revealSound).toBe(
      "worlds/keep/thunder.ogg"
    );
    const { pin, warnings } = withSound("https://evil.example/beacon.ogg");
    expect(pin.effect.revealSound).toBeNull();
    expect(warnings.map((w) => w.key)).toContain("DP.pin.warn.badSound");
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

  it("plays nothing when the scene loads, and on every reveal after — once a pass, not once ever", async () => {
    // Props already on screen when the scene loads have not arrived.
    await sceneWith(propTile("a", { id: "thunder" }));
    expect(playedSounds()).toEqual([]);

    await reveal("a");
    await reveal("a");
    expect(playedSounds()).toHaveLength(2);
  });

  it("plays each prop's own sound over its preset's, and each different sound once a pass", async () => {
    await sceneWith(
      propTile("a", { id: "thunder" }),
      // Wearing the thunder preset too, with a sound of its own: its own wins.
      propTile("b", { id: "thunder", revealSound: "worlds/keep/seal.ogg" }),
      propTile("c", { id: "thunder" })
    );
    await reveal("a", "b", "c");
    // Three arrivals, two sounds: the two thunders are one clap.
    expect(
      [...playedSounds()].sort((x, y) => String(x.data.src).localeCompare(String(y.data.src)))
    ).toEqual([
      { data: { src: "worlds/keep/seal.ogg", channel: "environment" }, socket: false },
      { data: { src: "worlds/keep/thunder.ogg", channel: "environment" }, socket: false },
    ]);
  });
});
