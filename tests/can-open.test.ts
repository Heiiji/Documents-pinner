/**
 * @vitest-environment jsdom
 *
 * The key glyph, for pins that read in place.
 *
 * `canUserOpen` asked for OBSERVER whatever the pin was. A prop opens in the module's own
 * reader for anyone in its audience — `openReader` is deliberately not gated on
 * ownership — so a prop revealed with access sync off put a key on every chip, and the
 * Pinboard listed it under "Won't open", for players reading it perfectly well.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import { chipState } from "../src/apps/chips";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
}));

let permitted: Set<string>;

function pinned(
  mode: "pin" | "prop",
  over: { kind?: string; users?: string[]; open?: string } = {}
) {
  const t = fakeTile({ id: "t1", uuid: "Scene.s1.Tile.t1", width: 400, height: 560 });
  t.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode,
        source: {
          kind: "document",
          uuid: "JournalEntry.j",
          src: null,
          pageId: null,
          pdfPage: null,
          followName: true,
        },
        interaction: { ...defaultPin().interaction, open: over.open ?? "double" },
        audience: {
          ...defaultPin().audience,
          kind: over.kind ?? "everyone",
          users: over.users ?? [],
          ownershipSync: { enabled: false, level: 2 },
        },
      },
    },
  };
  return t;
}

async function chipsFor(tile: any) {
  installWorld({ isGM: true, tiles: [tile] });
  const source = {
    name: "The Duke's Letter",
    documentName: "JournalEntry",
    testUserPermission: (user: any) => permitted.has(user?.id),
  };
  (globalThis as any).fromUuidSync = () => source;
  const { chipUsersFor } = await import("../src/apps/PinHUD");
  return Object.fromEntries(chipUsersFor(tile).map((user) => [user.id, chipState(user)]));
}

beforeEach(() => {
  vi.resetModules();
  permitted = new Set();
});

afterEach(() => {
  delete (globalThis as any).fromUuidSync;
  uninstallWorld();
});

describe("a prop revealed without granting access", () => {
  it("raises no key: every player who sees it can read it", async () => {
    expect(await chipsFor(pinned("prop"))).toEqual({ ali: "visible", ben: "visible" });
  });

  it("still flags a player who holds the journal while the prop is hidden from them", async () => {
    permitted.add("ben");
    const tile = pinned("prop", { kind: "selected", users: ["ali"] });
    expect(await chipsFor(tile)).toEqual({ ali: "visible", ben: "opensButCannotSee" });
  });
});

describe("a pin", () => {
  it("still raises the key when it opens the sheet and the sheet would refuse", async () => {
    expect(await chipsFor(pinned("pin"))).toEqual({
      ali: "seesButCannotOpen",
      ben: "seesButCannotOpen",
    });
  });

  it("raises none when it is set to read in place, which opens the same reader", async () => {
    expect(await chipsFor(pinned("pin", { open: "readInPlace" }))).toEqual({
      ali: "visible",
      ben: "visible",
    });
  });

  it("raises it for a prop the GM made non-interactive, which really does not open", async () => {
    expect(await chipsFor(pinned("prop", { open: "never" }))).toEqual({
      ali: "seesButCannotOpen",
      ben: "seesButCannotOpen",
    });
  });
});

describe("the Pinboard's count", () => {
  it("does not list a prop revealed without access under Won't open", async () => {
    const tile = pinned("prop");
    installWorld({ isGM: true, tiles: [tile] });
    (globalThis as any).fromUuidSync = () => ({
      name: "The Duke's Letter",
      documentName: "JournalEntry",
      testUserPermission: () => false,
    });
    const { rowsFor } = await import("../src/apps/Pinboard");
    const { summarise } = await import("../src/apps/pinboard-model");

    expect(summarise(rowsFor((globalThis as any).canvas.scene)).mismatched).toBe(0);
  });
});
