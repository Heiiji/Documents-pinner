import js from "@eslint/js";
import tseslint from "typescript-eslint";

/** Foundry globals we touch. Declared, never imported. */
const foundryGlobals = Object.fromEntries(
  [
    "game", "canvas", "ui", "foundry", "CONFIG", "CONST", "Hooks", "PIXI",
    "Actor", "Item", "JournalEntry", "JournalEntryPage", "Scene", "RollTable",
    "TileDocument", "NoteDocument", "fromUuid", "fromUuidSync", "ROUTE_PREFIX",
  ].map((k) => [k, "readonly"])
);

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: { ...foundryGlobals },
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      // Foundry modules conventionally log a boot line at init/ready; that is how a
      // user's console tells them the module actually loaded.
      // `info` and `debug` join the list because the module now routes everything
      // through `src/log.ts`, where the level decides which of the four is used.
      "no-console": ["warn", { allow: ["log", "warn", "error", "info", "debug"] }],
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  }
);
