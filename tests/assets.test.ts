import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "module.json"), "utf8"));

/** Every TypeScript source file, which is where all of this module's markup lives. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

describe("module.json", () => {
  it("declares the id the code uses", async () => {
    const { MODULE_ID } = await import("../src/const");
    expect(manifest.id).toBe(MODULE_ID);
  });

  it("targets v14 or later with no upper bound", () => {
    expect(Number(manifest.compatibility.minimum)).toBeGreaterThanOrEqual(14);
    expect(manifest.compatibility.maximum).toBeUndefined();
  });

  it("references stylesheets and language files that exist", () => {
    for (const path of [...manifest.styles, ...manifest.languages.map((l: any) => l.path)]) {
      expect(existsSync(join(ROOT, path)), path).toBe(true);
    }
  });

  it("points its esmodule at the build output", () => {
    expect(manifest.esmodules).toEqual(["dist/documents-pinner.mjs"]);
  });
});

describe("stylesheets", () => {
  const files = cssFiles(join(ROOT, "styles"));

  it("resolve every @import to a real file", () => {
    // These imports are followed by the browser at runtime, not by a bundler, so a
    // typo here fails silently in Foundry with no build error to catch it.
    const broken: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, "utf8");
      for (const m of css.matchAll(/@import\s+url\(\s*["']([^"']+)["']\s*\)/g)) {
        const target = resolve(dirname(file), m[1]);
        if (!existsSync(target)) broken.push(`${file.slice(ROOT.length + 1)} -> ${m[1]}`);
      }
    }
    expect(broken, `unresolved @import:\n${broken.join("\n")}`).toEqual([]);
  });

  it("give every @import an explicit layer so cascade order cannot depend on load order", () => {
    const entry = readFileSync(
      join(ROOT, "styles", manifest.styles[0].replace(/^styles\//, "")),
      "utf8"
    );
    for (const m of entry.matchAll(/@import[^;]+;/g)) {
      expect(m[0], m[0]).toMatch(/layer\(/);
    }
  });

  it("declare the layer order before any @import", () => {
    const entry = readFileSync(join(ROOT, manifest.styles[0]), "utf8");
    const layerAt = entry.indexOf("@layer");
    const importAt = entry.indexOf("@import");
    expect(layerAt).toBeGreaterThanOrEqual(0);
    expect(layerAt).toBeLessThan(importAt);
  });

  // Two accepted namespaces: the `dp-` prefix for everything inside the module, and
  // the full module id for the single overlay root, where an unambiguous name is worth
  // more in someone else's devtools than brevity.
  it("keep every module selector namespaced so nothing leaks into Foundry's UI", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const css = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        // @keyframes blocks are stripped whole: their contents are timeline offsets
        // ("50%", "from"), not selectors, and they cannot leak anywhere. Their NAMES
        // are global, and are checked separately below.
        .replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "")
        .replace(/@(?:import|layer|property|media|supports)[^;{]*[;{]/g, "");
      for (const m of css.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
        for (const sel of m[2].split(",")) {
          const s = sel.trim();
          if (!s || s.startsWith("&") || s === "to" || s === "from") continue;
          if (!/(^|\s|>|~|\+)[.#](?:dp-|documents-pinner)|^:root|^\[data-dp-/.test(s))
            offenders.push(`${file.slice(ROOT.length + 1)}: ${s}`);
        }
      }
    }
    expect(offenders, `un-namespaced selectors:\n${offenders.join("\n")}`).toEqual([]);
  });

  // Keyframe names live in a single global namespace shared with Foundry and every
  // other module, so a generic name like `fade` would be a silent collision that only
  // shows up as someone else's animation behaving strangely.
  it("prefix every @keyframes name, which shares one global namespace", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const m of readFileSync(file, "utf8").matchAll(/@keyframes\s+([\w-]+)/g)) {
        if (!m[1].startsWith("dp-")) offenders.push(`${file.slice(ROOT.length + 1)}: ${m[1]}`);
      }
    }
    expect(offenders, `un-prefixed keyframes:\n${offenders.join("\n")}`).toEqual([]);
  });
});

/**
 * Rules for elements that do not exist.
 *
 * `[data-dp-fx="reduced"] .dp-pin` could never match — `data-dp-fx` holds a preset id,
 * the level lives in `data-dp-level`, and `.dp-pin` was emitted by no source file — so
 * the pure-CSS accessibility guard its own comment described was absent, and the whole
 * `dp.theme` layer resolved to nothing. Nobody noticed because the JS path was carrying
 * `reduced` on its own.
 *
 * Dead CSS is worse than missing CSS: it makes a reviewer believe a mechanism is in place.
 */
describe("CSS selectors match markup the module actually emits", () => {
  const CSS_FILES = cssFiles(join(ROOT, "styles"));

  /** Every `.dp-*` class name any stylesheet targets. */
  function styledClasses(): Map<string, string> {
    const found = new Map<string, string>();
    for (const file of CSS_FILES) {
      const css = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const m of css.matchAll(/\.(dp-[a-z0-9_-]+)/gi)) {
        if (!found.has(m[1])) found.set(m[1], file.slice(ROOT.length + 1));
      }
    }
    return found;
  }

  it("emits every class the stylesheets style", () => {
    const source = sourceFiles(join(ROOT, "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    const dead: string[] = [];
    for (const [className, file] of styledClasses()) {
      // The class has to appear literally somewhere in the source; every surface in this
      // module builds its markup as string literals, so anything absent is unreachable.
      if (!source.includes(className)) dead.push(`${file}: .${className}`);
    }
    expect(dead, `styled but never emitted:\n${dead.join("\n")}`).toEqual([]);
  });

  it("keys the reduced-motion guard off the attribute that carries the level", () => {
    // Comments stripped: the file explains the old selector, and quoting it in prose
    // must not read as still using it.
    const props = readFileSync(join(ROOT, "styles", "fx", "_props.css"), "utf8").replace(
      /\/\*[\s\S]*?\*\//g,
      ""
    );
    expect(props).toContain('[data-dp-level="reduced"]');
    // `data-dp-fx` carries a preset ID, so a level value can never appear in it.
    expect(props).not.toContain('[data-dp-fx="reduced"]');
  });
});
