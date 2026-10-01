/**
 * The stylesheets, as the CSS-policy tests read them: every `.css` file under `styles/`,
 * and their text with comments stripped.
 *
 * Comments are stripped always, and that is load-bearing: without it a property or a
 * selector passes a check on the strength of a comment saying it is dead, which is how
 * `data-dp-fx` once survived a rule describing it as matched by nothing.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dirname, "..", "..");

/** Every stylesheet under `dir`, depth first. */
export function cssFiles(dir = join(ROOT, "styles"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) cssFiles(full, out);
    else if (entry.endsWith(".css")) out.push(full);
  }
  return out;
}

export const decomment = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** Every stylesheet's text, joined, comments stripped. */
export function readStyles(): string {
  return decomment(
    cssFiles()
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
  );
}

/** The innermost `selector { body }` rules of `css` — what the cascade checks walk. */
export function cssRules(css = readStyles()): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }));
}
