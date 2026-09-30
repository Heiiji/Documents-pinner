/**
 * @vitest-environment jsdom
 *
 * Reveal & spotlight, and the flash that shares its door.
 *
 * The GM reveals the map scrap and every player's view glides to it — when the scrap is
 * for everyone. A core ping reaches every connected client whoever the pin is for, so
 * pulling the table to a note for the rogue walks the others to where it lies (K1): a
 * narrower audience is revealed, pointed at on the GM's screen, and nobody is moved.
 *
 * The canvas here pings as core does, reading Shift as "pull" for any option it is not
 * given — so a held Shift, which the Pinboard's Shift+Space is, can be asserted to pull
 * nobody.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FLAGS, MODULE_ID } from "../src/const";
import { defaultPin } from "../src/data/pin-schema";
import type { DpAudience } from "../src/types/dp";
import {
  contentOf,
  fakeTile,
  holdModifier,
  installWorld,
  recordedPings,
  uninstallWorld,
} from "./helpers/fake-foundry";

vi.mock("../src/data/ownership-sync", () => ({
  syncAnchor: vi.fn(async () => {}),
  releaseAnchor: vi.fn(async () => {}),
  onSourceOwnershipEdited: vi.fn(async () => {}),
  reconcile: vi.fn(async () => 0),
}));

const ALI: Partial<DpAudience> = { kind: "hidden", restore: { kind: "selected", users: ["ali"] } };
const HIDDEN: Partial<DpAudience> = { kind: "hidden" };
const EVERYONE: Partial<DpAudience> = { kind: "everyone" };

function pinnedTile(audience: Partial<DpAudience>, id = "t1") {
  const tile = fakeTile({
    id,
    uuid: `Scene.s1.Tile.${id}`,
    x: 600,
    y: 400,
    hidden: (audience.kind ?? "hidden") === "hidden",
  });
  tile.flags = {
    [MODULE_ID]: {
      [FLAGS.PIN]: {
        ...defaultPin(),
        mode: "prop",
        display: { ...defaultPin().display, label: `Pin ${id}` },
        audience: { ...defaultPin().audience, ...audience },
      },
    },
  };
  return tile;
}

const stored = (tile: any): DpAudience => tile.flags[MODULE_ID][FLAGS.PIN].audience;
const kinds = () => recordedPings().map((ping) => ping.kind);

let world: ReturnType<typeof installWorld>;
let tile: any;
let api: typeof import("../src/api");

async function setup(audience: Partial<DpAudience>, isGM = true) {
  vi.resetModules();
  document.body.innerHTML = '<div id="hud"></div>';
  tile = pinnedTile(audience);
  world = installWorld({ isGM, tiles: [tile] });
  world.canvas.scene.id = "s1";
  tile.parent = world.canvas.scene;
  api = await import("../src/api");
}

afterEach(() => uninstallWorld());

describe("api.spotlight", () => {
  it("reveals a hidden pin for everyone, then pulls every view to it", async () => {
    await setup(HIDDEN);
    expect(await api.spotlight(tile)).toEqual({ revealed: true, pulled: true });

    expect(stored(tile).kind).toBe("everyone");
    expect(kinds()).toEqual(["broadcast", "pan", "local"]);
    expect(recordedPings()[0]).toMatchObject({
      origin: { x: 600, y: 400 },
      data: { scene: "s1", pull: true, style: "chevron" },
    });
    expect(world.notifications).toEqual([]);
  });

  it("writes the reveal before it points, so a player pulled there finds it", async () => {
    await setup(HIDDEN);
    const order: string[] = [];
    const update = tile.update;
    tile.update = async (...args: any[]) => {
      const result = await update(...args);
      order.push(`written, hidden=${tile.hidden}`);
      return result;
    };
    const ping = world.canvas.ping;
    world.canvas.ping = (...args: any[]) => {
      order.push("pinged");
      return ping(...args);
    };
    await api.spotlight(tile);
    expect(order).toEqual(["written, hidden=false", "pinged"]);
  });

  it("reveals a pin for Ali to Ali, points at it for the GM alone, and says why", async () => {
    await setup(ALI);
    expect(await api.spotlight(tile)).toEqual({ revealed: true, pulled: false });

    expect(stored(tile)).toMatchObject({ kind: "selected", users: ["ali"] });
    // No broadcast of any kind: not a pull, not a pulse.
    expect(kinds()).toEqual(["local"]);
    expect(recordedPings()[0].data).toEqual({ scene: "s1", style: "pulse" });
    expect(world.notifications).toEqual([{ type: "info", message: "DP.notice.spotlightNarrow" }]);
  });

  it("points again at a pin already showing, and hides nothing", async () => {
    await setup(EVERYONE);
    expect(await api.spotlight(tile)).toEqual({ revealed: false, pulled: true });
    expect(await api.spotlight(tile)).toEqual({ revealed: false, pulled: true });
    expect(tile.updates).toEqual([]);
    expect(stored(tile).kind).toBe("everyone");
  });

  it("pulls nobody for a pin shown to some players, whatever the keyboard holds", async () => {
    await setup({ kind: "selected", users: ["ali", "ben"] });
    holdModifier("Shift");
    await api.spotlight(tile);
    expect(kinds()).toEqual(["local"]);
  });

  it("reveals a pin on another scene but points at nothing on this one", async () => {
    await setup(HIDDEN);
    tile.parent = { id: "elsewhere" };
    expect(await api.spotlight(tile)).toEqual({ revealed: true, pulled: false });
    expect(stored(tile).kind).toBe("everyone");
    expect(recordedPings()).toEqual([]);
    expect(world.notifications.map((n) => n.message)).toEqual(["DP.notice.spotlightElsewhere"]);
  });

  it("pulses the GM's own card, which covers the ping on the DOM tier", async () => {
    await setup(EVERYONE);
    await api.spotlight(tile);
    expect(world.hooks).toContainEqual({ name: `${MODULE_ID}.flash`, args: [tile] });
  });

  it("does nothing for a player", async () => {
    await setup(HIDDEN, false);
    expect(await api.spotlight(tile)).toEqual({ revealed: false, pulled: false });
    expect(tile.updates).toEqual([]);
    expect(recordedPings()).toEqual([]);
  });
});

/** K11: flash keeps its reach, and joins the same door. */
describe("flash", () => {
  it("never pulls, even with Shift held", async () => {
    await setup(EVERYONE);
    holdModifier("Shift");
    api.flash(tile);
    expect(kinds()).toEqual(["broadcast", "local"]);
    expect(recordedPings()[0].data).toMatchObject({ pull: false, style: "pulse" });
  });

  it("keeps its documented reach: a visible pin for one player still pulses everywhere", async () => {
    await setup({ kind: "selected", users: ["ali"] });
    api.flash(tile);
    expect(kinds()).toEqual(["broadcast", "local"]);
  });

  it("draws a hidden pin's flash on the GM's screen, with the scene core needs", async () => {
    await setup(HIDDEN);
    api.flash(tile);
    expect(kinds()).toEqual(["local"]);
    expect(recordedPings()[0].data).toEqual({ scene: "s1", style: "pulse" });
  });

  // The fake this suite pings against must refuse the very call the flash used to make:
  // `{}` drew nothing on a real canvas, whose scene always has an id, while a test scene
  // with none let `undefined === undefined` draw it.
  it("is checked against a canvas that draws nothing for a local ping with no scene", async () => {
    await setup(HIDDEN);
    delete world.canvas.scene.id;
    const drawn = await world.canvas.controls.handlePing(world.game.user, { x: 1, y: 1 }, {});
    expect(drawn).toBe(false);
    expect(recordedPings()).toEqual([]);
  });

  it("does not ping this map for a pin on another scene", async () => {
    await setup(EVERYONE);
    tile.parent = { id: "elsewhere" };
    api.flash(tile);
    expect(recordedPings()).toEqual([]);
  });
});

describe("the surfaces", () => {
  it("puts the spotlight on the HUD, and the HUD's button spotlights", async () => {
    await setup(HIDDEN);
    const { definePinHUD } = await import("../src/apps/PinHUD");
    const hud = new (definePinHUD())();
    await hud.bind(tile.object);
    expect(contentOf(hud).querySelector('[data-action="spotlight"]')).not.toBeNull();

    hud.dispatch("spotlight");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stored(tile).kind).toBe("everyone");
    expect(recordedPings()[0].data.pull).toBe(true);
  });

  async function board() {
    const { definePinboard } = await import("../src/apps/Pinboard");
    const app = new (definePinboard())();
    document.body.appendChild(contentOf(app));
    await app.render();
    return app;
  }

  it("spotlights on Shift+Space in the Pinboard, where Space alone would have hidden it", async () => {
    await setup(EVERYONE);
    const app = await board();
    holdModifier("Shift");
    contentOf(app)
      .querySelector(".dp-board")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored(tile).kind).toBe("everyone");
    expect(tile.updates).toEqual([]);
    expect(recordedPings()[0].data).toMatchObject({ pull: true, style: "chevron" });
  });

  it("holds Shift on a pin for Ali without pulling anyone", async () => {
    await setup(ALI);
    const app = await board();
    holdModifier("Shift");
    contentOf(app)
      .querySelector(".dp-board")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: " ", shiftKey: true, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stored(tile)).toMatchObject({ kind: "selected", users: ["ali"] });
    expect(kinds()).toEqual(["local"]);
  });

  it("offers it in the row menu, beside reveal and hide", async () => {
    await setup(HIDDEN);
    const app = await board();
    app.menu = { id: "t1", kind: "actions", top: 0, right: 0 };
    await app.render();
    const items = [...contentOf(app).querySelectorAll<HTMLElement>(".dp-menu [data-dp-act]")];
    const acts = items.map((item) => item.dataset.dpAct);
    expect(acts.indexOf("spotlight")).toBe(acts.indexOf("visibility") + 1);

    await app.dispatch("menuAct", items[acts.indexOf("spotlight")]);
    expect(stored(tile).kind).toBe("everyone");
    expect(recordedPings()[0].data.pull).toBe(true);
  });
});
