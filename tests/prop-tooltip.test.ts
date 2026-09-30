/**
 * @vitest-environment jsdom
 *
 * The tooltip used to be created on every show and removed on every hide, with its
 * class added in the same frame as the mount — so the fade-in never played and there
 * was nothing left to fade out. One element, shown and hidden by a class.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultPin } from "../src/data/pin-schema";
import { hidePropTooltip, setPropHover, tooltipHint, tooltipText } from "../src/apps/PropTooltip";
import { fakeTile, installWorld, uninstallWorld } from "./helpers/fake-foundry";

const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

function pinned(id: string, tooltip: string) {
  const tile = fakeTile({
    id,
    uuid: `Scene.s1.Tile.${id}`,
    x: 100,
    y: 200,
    width: 400,
    height: 560,
  });
  tile.flags = {
    "documents-pinner": {
      pin: { ...defaultPin(), interaction: { ...defaultPin().interaction, tooltip } },
    },
  };
  return tile;
}

beforeEach(() => {
  document.body.innerHTML = '<div id="board"></div>';
  installWorld({});
});

afterEach(() => {
  hidePropTooltip();
  uninstallWorld();
});

const node = () => document.querySelector<HTMLElement>(".dp-tooltip");

describe("the tooltip", () => {
  it("is one element across two hovers", async () => {
    setPropHover(pinned("a", "A letter"), true);
    await frame();
    const first = node();
    hidePropTooltip();
    await frame();
    setPropHover(pinned("b", "A warrant"), true);
    await frame();

    expect(node()).toBe(first);
    expect(document.querySelectorAll(".dp-tooltip")).toHaveLength(1);
    expect(tooltipText()).toBe("A warrant");
  });

  it("hides by dropping the class, leaving the node to fade", async () => {
    setPropHover(pinned("a", "A letter"), true);
    await frame();
    expect(node()!.classList.contains("dp-tooltip--in")).toBe(true);

    hidePropTooltip();
    expect(tooltipText()).toBeNull();
    await frame();
    expect(node()).not.toBeNull();
    expect(node()!.classList.contains("dp-tooltip--in")).toBe(false);
  });

  it("sits above the prop as it actually lies, not at its unrotated top", async () => {
    // 400x560 at (100,200), turned on its side.
    // The point (100,200) is the CENTRE: the bounds are 560x400 about it, top at 0.
    const tile = pinned("a", "A letter");
    tile.rotation = 90;
    setPropHover(tile, true);
    await frame();
    expect(node()!.style.top).toBe("0px");
    expect(node()!.style.left).toBe("100px");
  });

  it("shows nothing to the GM for a titled prop with no tooltip", async () => {
    uninstallWorld();
    installWorld({ isGM: true });
    setPropHover(pinned("a", "   "), true);
    await frame();
    expect(tooltipText()).toBeNull();
  });

  it("tells a player how to open a prop, which the pointer cursor alone did not", async () => {
    setPropHover(pinned("a", "   "), true);
    await frame();
    // A titled prop already shows its name on the paper; the hint is the whole tooltip.
    expect(tooltipText()).toBe("");
    expect(tooltipHint()).toBe("DP.tooltip.doubleRead");
  });

  it("names a pin icon when the GM wrote no tooltip, as a map note shows its label", async () => {
    const tile = pinned("a", "");
    tile.flags["documents-pinner"].pin.mode = "pin";
    tile.flags["documents-pinner"].pin.display.label = "The Duke's Letter";
    setPropHover(tile, true);
    await frame();
    expect(tooltipText()).toBe("The Duke's Letter");
    expect(tooltipHint()).toBe("DP.tooltip.doubleOpen");
  });

  it("offers no hint on a pin that does not open", async () => {
    const tile = pinned("a", "A seal");
    tile.flags["documents-pinner"].pin.interaction.open = "never";
    setPropHover(tile, true);
    await frame();
    expect(tooltipText()).toBe("A seal");
    expect(tooltipHint()).toBe("");
  });
});
