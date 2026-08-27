# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [1.0.0] — unreleased

First release. Pin any journal, page or image onto the map as a small icon or as a
full-size readable prop, with per-pin visibility the GM controls in one click.

> Feature-complete and covered by 500+ tests, but not yet verified in a live session. The
> canvas behaviours in particular — lighting, fog, occlusion, frame rate under load — are
> argued for in `docs/DESIGN.md` and tested where a test can reach them, but have not been
> watched working on a real scene.

### Pre-release hardening

A review pass before this release found that several headline features had never
executed, because the 403 tests behind them covered pure functions and markup strings and
never the integration seams. Everything below was found, reproduced with a failing test,
and fixed; see `docs/DESIGN.md` amendment A9 for the full account.

- **No prop had ever rendered on any client.** The SVG the rasteriser builds is parsed by
  the XML parser, and three producers were emitting HTML into it — the natively-nested
  stylesheet, the sanitiser's `innerHTML`, and the asset inliner's. Anchors were also
  created with no texture, so core built no mesh to bind a result to.
- **`rendering: "dom"` and the WebKit fallback drew nothing at all.** There was no DOM
  prop renderer on the other side of either. There is now.
- **Players could not click a pin**, the Pinboard's bulk and global reveal buttons were
  dead, every window re-attached its listeners on every render, the HUD's audience palette
  closed itself after every chip click, the Pinboard could never receive a keystroke, and
  user-authored presets could never render.
- **A `<noscript>` mutation-XSS bypassed both the sanitiser and the secret filter.**
- **The ownership ledger could never remove a key**, so flipping a pin's audience left a
  phantom holder that made every later release report an override that never happened;
  deleting a pin from the Tiles layer orphaned its grant entirely; and a manual permission
  raise was reverted — or deleted outright — by the next release.
- Async rasterisation gained a liveness check, `invalidate` stopped destroying textures
  still bound to live meshes, the cache key gained a content signal, and the tile-update
  fan-out was coalesced.

### Added

#### Placing and shaping

- **Two modes on one anchor.** A pin is a small icon; a prop is the document laid out
  full size and readable in place. Switching between them is one atomic update, so the
  `_id` survives and nothing referring to the pin breaks.
- **Placement by ghost, not by dialog.** The real prop at real size follows the cursor —
  wheel rotates, `Alt+wheel` scales, `Space` switches shape, `E`/`V` cycle effect and
  audience, `Shift+click` places and stays armed for a run of markers. A legend beside
  the ghost teaches the gestures, which is the only place a GM will read them mid-prep.
- **Six entry points**, none of which changes what dragging a journal onto the canvas
  already does: Alt-drag, a journal sheet header button, two Notes controls, sidebar
  context menus, keybindings, and `/pin <name>`.

#### Visibility

- **Per-pin audiences** — hidden, everyone, or specific players —
  deliberately decoupled from document ownership, because core ties map-note visibility
  to journal *permissions*, which is the wrong coupling for "reveal it when they find it".
- **Avatar chips**, identical in the HUD, the Pinboard and Pin Studio: filled means they
  can see it, hollow means they cannot, and a key glyph means presence and content access
  disagree. That last state is the bug a GM otherwise ships to their table and only hears
  about when a player says "I can see it but it won't open".
- **A Pinboard** built for live play: one-handed from the keyboard, bulk reveal in a
  single scene write, no confirmation on anything reversible, and a hand-sorted row order
  that doubles as a reveal script.
- **A reversible ownership ledger.** Revealing can also raise the document's ownership so
  it lands in the player's sidebar; un-revealing restores the previous permissions
  exactly, including deleting a key that did not exist before. A manual GM edit in between
  always wins, and is reported rather than reverted.

#### Rendering

- **Props render into `canvas.primary`**, so they are darkened by scene darkness, lit by
  torches, masked by fog and occluded by roofs, and tokens standing on them draw in front.
  None of that is reproducible with DOM over a WebGL canvas.
- **Content is enriched per client**, never rendered once and broadcast. `secrets` is
  computed from the viewing user, so a GM's secret sections are stripped before a player's
  HTML exists.
- **A focus reader** — click a prop and it sharpens into live HTML with selectable text,
  working `@UUID` links and live inline rolls. One element, not fifty.
- **A five-rung LOD ladder** with power-of-two texture tiers, concurrency-1 generation
  ordered by distance from the viewport centre, a VRAM budget with least-recently-seen
  eviction, and an auto-degrade guard that lowers every prop one rung and says so once.

#### Effects

- Ten presets with an intensity slider each, a `reduced` rendition that keeps every
  preset's static identity, and a Preset Studio for authoring your own — with preview
  backdrops, because an effect authored against a light panel is invisible on a dark map.
- Surfaces, grain and torn edges are generated procedurally as `data:` URIs from the pin's
  stored seed, so every client sees the same tear in the same place and the module ships
  no binary assets.
- Motion stops under `prefers-reduced-motion` and under Foundry's photosensitive mode,
  which is treated as a hazard rather than a performance signal.

#### Everything else

- English and French, kept key-for-key parallel by a test that also fails on a key the
  source references but no table defines.
- Client settings for rendering mode, effect level, texture budget, auto-degrade and the
  drag modifier; world settings for the default shape, default visibility and whether
  revealing grants access.
- A public API on `game.modules.get("documents-pinner").api` and a `documents-pinner.*`
  hook family, so other modules — Sequencer among them — can target a pin.

### Security

- Enriched content is scrubbed by parsing a real tree and walking it, never by running
  regexes over HTML. Any tag name a well-formed parse could not have produced is removed,
  and the scrub round-trips until the serialised output stops changing — which closes an
  mXSS hole the module's own tests found while it was being written.
- Texture cache keys include the viewing user, so a GM's texture can never be served to a
  player on the same client.
- Presets have no free-form CSS field by design, so a preset pasted in from a stranger has
  no injection surface.

### Known limitations

Pin visibility is enforced **at parity with core Foundry, not above it** — a determined
player with a browser console can detect a hidden pin exactly as they can any hidden tile
today. The one thing genuinely *removed* rather than hidden is a page's secret sections.

WebKit refuses to rasterise an SVG `foreignObject` without tainting the canvas, so Safari
clients fall back to DOM rendering: props still work, but they are not lit, fogged or
occluded. The module detects this at startup rather than failing visibly.

The full list is in the README and in `docs/DESIGN.md` §10.

[Unreleased]: https://github.com/Heiiji/Documents-pinner/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Heiiji/Documents-pinner/releases/tag/v1.0.0
