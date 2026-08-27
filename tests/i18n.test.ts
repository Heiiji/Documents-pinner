import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const LANGS = ["en", "fr"] as const;

function load(lang: string): Record<string, string> {
  return JSON.parse(readFileSync(join(ROOT, "lang", `${lang}.json`), "utf8"));
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|hbs)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** Every `DP.foo.bar` literal appearing anywhere in the source or the templates. */
function referencedKeys(): Map<string, string> {
  const found = new Map<string, string>();
  const dirs = [join(ROOT, "src"), join(ROOT, "templates")];
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = sourceFiles(dir);
    } catch {
      continue; // directory may not exist yet
    }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/["'`](DP\.[A-Za-z0-9_.]+)["'`]/g)) {
        if (!found.has(m[1])) found.set(m[1], file.slice(ROOT.length + 1));
      }
    }
  }
  return found;
}

describe("localisation files", () => {
  const tables = Object.fromEntries(LANGS.map((l) => [l, load(l)])) as Record<string, Record<string, string>>;

  it("are key-for-key parallel across every language", () => {
    const reference = Object.keys(tables.en).sort();
    for (const lang of LANGS) {
      expect(Object.keys(tables[lang]).sort(), lang).toEqual(reference);
    }
  });

  it("use the flat dotted DP.* convention with no nesting", () => {
    for (const lang of LANGS) {
      for (const [key, value] of Object.entries(tables[lang])) {
        expect(key, `${lang} ${key}`).toMatch(/^DP\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)+$/);
        expect(typeof value, `${lang} ${key}`).toBe("string");
        expect(value.trim(), `${lang} ${key}`).not.toBe("");
      }
    }
  });

  it("use the same interpolation placeholders in every language", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(tables.en)) {
      const expected = placeholders(tables.en[key]);
      for (const lang of LANGS) {
        expect(placeholders(tables[lang][key]), `${lang} ${key}`).toEqual(expected);
      }
    }
  });

  it("define every DP.* key the source and templates reference", () => {
    const missing: string[] = [];
    for (const [key, file] of referencedKeys()) {
      if (!(key in tables.en)) missing.push(`${key}  (${file})`);
    }
    expect(missing, `undefined i18n keys:\n${missing.join("\n")}`).toEqual([]);
  });
});
