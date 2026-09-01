/**
 * The canvas tier animates through CanvasAnimation and cannot read a stylesheet; the
 * DOM tier animates through CSS and cannot read `motion.ts`. This is what keeps the two
 * on one clock.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EASE, MOTION, curveFor } from "../src/motion";

const THEME = readFileSync(join(import.meta.dirname, "..", "styles", "theme.css"), "utf8");

function token(name: string): string {
  const match = THEME.match(new RegExp(`--dp-${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`theme.css does not declare --dp-${name}`);
  return match[1].trim();
}

describe("the motion tokens", () => {
  it("declare the same durations in the stylesheet as in motion.ts", () => {
    expect(token("dur-state")).toBe(`${MOTION.state}ms`);
    expect(token("dur-enter")).toBe(`${MOTION.enter}ms`);
    expect(token("dur-exit")).toBe(`${MOTION.exit}ms`);
    expect(token("dur-reveal")).toBe(`${MOTION.reveal}ms`);
    expect(token("dur-emphasis")).toBe(`${MOTION.emphasis}ms`);
  });

  it("declare the same curves", () => {
    expect(token("ease-out")).toBe(EASE.out);
    expect(token("ease-in")).toBe(EASE.in);
    expect(token("ease-resolve")).toBe(EASE.resolve);
  });

  it("keep exits shorter than entries", () => {
    expect(MOTION.exit).toBeLessThan(MOTION.enter);
  });

  it("map a preset's reveal to the curve the canvas tier uses for it", () => {
    expect(curveFor("materialise")).toBe(EASE.resolve);
    expect(curveFor("fade")).toBe("linear");
    expect(curveFor(undefined)).toBe("linear");
  });

  it("are scoped to the overlay as well as the windows, whose children carry neither class", () => {
    expect(THEME).toMatch(/\.dp-scope,\s*#documents-pinner-overlay\s*\{[^}]*--dp-dur-state/);
  });
});
