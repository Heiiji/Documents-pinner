import { defineConfig } from "vite";

/**
 * The repository root IS the Foundry module folder (symlink it into Data/modules).
 * Vite therefore builds ONLY the TypeScript in src/ into dist/; lang and styles are
 * served by Foundry straight from the repo, unprocessed. There is no templates or
 * assets directory: markup is built in TypeScript and every texture is generated
 * procedurally as a data: URI, so the module ships no binary assets.
 *
 * CSS is deliberately NOT part of the build: styles/documents-pinner.css uses a
 * native `@layer` statement plus `@import ... layer()` so the cascade order is
 * fixed at runtime. Chromium 144 supports all of it — Foundry 14.368 itself requires 146
 * (Electron 41) — and keeping CSS out of the bundle means style edits need no rebuild.
 */
export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Foundry serves the module directory, so sourcemaps resolve in user devtools.
    sourcemap: true,
    // Unminified on purpose: user bug reports quote real file names and line numbers.
    minify: false,
    target: "chrome144",
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: () => "documents-pinner.mjs",
    },
    rollupOptions: {
      output: {
        entryFileNames: "documents-pinner.mjs",
        // Foundry loads exactly one esmodule entry - never code-split.
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
});
