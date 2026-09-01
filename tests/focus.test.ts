/**
 * One focus treatment for the whole module, declared once and never taken away.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const UI = join(import.meta.dirname, "..", "styles", "ui");
const ENTRY = readFileSync(join(import.meta.dirname, "..", "styles", "documents-pinner.css"), "utf8");

describe("focus rings", () => {
  it("are never removed by a surface's own stylesheet", () => {
    const offenders = readdirSync(UI)
      .filter((f) => f.endsWith(".css"))
      .filter((f) => /outline:\s*none/.test(readFileSync(join(UI, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("are declared once, in focus.css, imported last in the ui layer", () => {
    const imports = [...ENTRY.matchAll(/@import url\("\.\/ui\/([^"]+)"\) layer\(dp\.ui\);/g)].map(
      (m) => m[1]
    );
    expect(imports[imports.length - 1]).toBe("focus.css");
    const focus = readFileSync(join(UI, "focus.css"), "utf8");
    expect(focus).toMatch(/:focus-visible\s*\{[^}]*outline: 2px solid/);
  });

  it("are the only :focus-visible outline rules in the ui stylesheets", () => {
    const others = readdirSync(UI)
      .filter((f) => f.endsWith(".css") && f !== "focus.css")
      .filter((f) => /:focus-visible[^{]*\{[^}]*outline:/.test(readFileSync(join(UI, f), "utf8")));
    expect(others).toEqual([]);
  });
});
