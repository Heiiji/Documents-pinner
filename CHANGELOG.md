# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Project scaffolding: Vite + TypeScript build, ESLint 9 flat config, Prettier, vitest,
  CI and release workflows.
- `audience` — the pure visibility model (`hidden` / `everyone` / `selected` /
  `discovered`), deliberately decoupled from document ownership so a GM can reveal a
  pin without granting permissions.
- `ownership-plan` — the reversible, reference-counted ownership ledger that lets
  "reveal to players" also put the document in their sidebar, and lets un-revealing
  restore the previous permissions exactly. A manual GM edit always wins.
- `transform` — scene/screen matrix maths derived from `canvas.stage.worldTransform`,
  correct under pan, zoom and a rotated stage.
- `preset-schema`, `preset-css` and the ten shipped effect presets, with a closed
  declarative parameter schema (no free-form CSS, so shared presets have no injection
  surface) and a `reduced` rendition that keeps each preset's static identity.
- Layered stylesheet architecture (`@layer dp.*` + `@property`), which makes it
  structurally impossible for the module to outrank core Foundry UI.
- `docs/spike-0-probe.js` — an in-world probe resolving the four load-bearing v14 API
  facts the canvas architecture depends on.
- 116 unit tests over the pure modules, the manifest and the stylesheet architecture.

[Unreleased]: https://github.com/Heiiji/Documents-pinner/commits/main
