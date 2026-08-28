# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.1.8] — unreleased

### Fixed

- **The whole scene stopped drawing on Safari, leaving a flat background colour.** A
  regression from 0.1.7. `PIXI.Texture.from(canvas)` does not upload — the upload happens
  during the next render — so a tainted source throws `SecurityError` from inside PIXI's
  own loop, where nothing can catch it, and a renderer that throws mid-frame stops drawing
  entirely. Browsers disagree about what taints: Chromium keeps a canvas clean when the
  generated `feTurbulence` effect layers are drawn onto it, WebKit does not. Baking
  effects onto a PDF page therefore worked in Chromium and destroyed the canvas in Safari.

  Three changes, so this class of failure cannot recur: a canvas is asked whether it is
  still readable before PIXI ever sees it, the upload is forced inside our own `try`, and
  a PDF whose effects cannot be baked on this browser falls back to the page exactly as
  pdf.js drew it — unadorned, but drawn.

## [0.1.7] — unreleased

### Added

- **Effects apply to a pinned PDF after all**, painted rather than styled. A PDF has no
  card for CSS to reach, so the static half of the preset — tint, stains, grain,
  scanlines, frame, blur and the torn edge silhouette — is composited onto the page with
  Canvas2D before it becomes a texture. Safe for the same reason the HTML path is not:
  there is no `foreignObject` anywhere in it, only fills and plain SVG images, and a plain
  SVG image was measured uploading to WebGL without complaint.

  Only what genuinely cannot apply is still disabled for a PDF: the paper stock and the
  padding, which describe a card it does not have, and anything that moves, because a
  texture cannot animate.

### Fixed

- **A generated texture that never decoded hung the whole scene.** The bake awaits inside
  the concurrency-1 generation queue, so one undecodable stain would have stopped every
  prop from ever drawing, silently. There is now a decode timeout: a missing layer is a
  cosmetic loss, a stuck queue is not.

## [0.1.6] — unreleased

Re-releases the z-index fix, which shipped inside a re-pushed `v0.1.5` tag and so was
never offered as an update to anyone who had already installed that version. Sorry —
moving a published tag was a mistake.

### Fixed

- **Props painted over the interface.** See 0.1.5 below; this is the version that can
  actually be installed over it.
- **The Pin Studio's effect names overlapped their cost labels.** The swatch grid declares
  a `name` area and the name span was never assigned to it, so it was auto-placed on top of
  the cost and every swatch read as two strings on top of each other.
- **`effect.speed` and `effect.motion` did nothing.** Both were written by the Studio,
  validated by the schema and stored on every pin, and read by nothing at all — the
  preset's own motion and frequencies decided everything. Speed now scales every duration
  the preset emits, and `none` stops motion outright.

### Changed

- **The `onReveal` animation choice is gone.** Nothing implemented a play-once animation
  and the renderer treated it exactly as `loop`, so it was a third option that behaved like
  the first.
- **A PDF pin's appearance controls are disabled, and say why.** A PDF page is painted
  straight into a texture by pdf.js, so it has no card: paper, padding, effect, intensity,
  speed and animation cannot apply to it. Leaving them live meant a GM moving sliders that
  could never do anything.

## [0.1.5] — unreleased

### Fixed

- **Props painted over the entire interface.** The overlay sat at `z-index: 90`, chosen
  against an assumption about core's HUD that is not true in v14: `#board` is `z-index: 0`,
  `#hud` is 1, and the interface's `#ui-left` / `#ui-right` are 30 inside a `z-index: auto`
  parent, so those compete in the root stacking context. A prop card therefore covered the
  sidebar, the chat log, the scene controls and the hotbar — a hard blocker, and correctly
  reported as one. The overlay now sits at the canvas's own level, mounted immediately
  after it, and re-seats itself if it was created before Foundry built the canvas.

- **A pin could not be moved, resized or rotated from the Notes layer**, which is the layer
  the module's own tools leave you on. Pins are Tiles, and core only lets a Tile be
  selected while the Tiles layer is active — `control()` returns `false` otherwise, with no
  error, no notification and no cursor change to explain it. Measured on a live world:
  `false` on Notes, `true` on Tiles. The Notes controls now carry a **Move and resize pins**
  button, the Pinboard's locate action switches layer and selects the pin it just found,
  and both READMEs say so.

## [0.1.4] — unreleased

### Added

- **PDFs render, and they render on the CANVAS.** A pinned PDF page is drawn by pdf.js —
  which Foundry already ships — and pdf.js paints with Canvas2D rather than through an SVG
  `foreignObject`, so its canvas is not tainted and uploads to WebGL. That makes a pinned
  PDF the one prop type that genuinely *is* lit by torches, hidden by fog, occluded by
  roofs and sorted behind tokens: the thing the whole primary-group architecture was chosen
  for, reachable for exactly one source type. Verified end to end in a live world before it
  was built. It falls back to the DOM tier like everything else when the GM asks for DOM.

### Fixed

- **Props were invisible after a fresh scene load.** The rasterisation probe is
  asynchronous, so the first LOD pass usually ran while the answer was still unknown — read
  as "canvas is fine", which held every prop's mesh at zero waiting for a texture that would
  never arrive and mounted no DOM card either. They stayed invisible until something
  unrelated happened to trigger another pass. The probe now recomputes when it resolves.
- **A prop whose card can never be drawn no longer hides itself.** Holding the mesh
  invisible is right while a texture is still coming; once the key is known to have failed
  it just means an invisible prop with nothing to explain it, so the placeholder comes
  back.

## [0.1.3] — unreleased

### Fixed

- **A pin could not be selected, moved or resized.** `showPinHUD` assigned
  `hudInstance.object`, and `BasePlaceableHUD#object` is a getter with no setter — so
  clicking a pin threw `TypeError: Cannot set property object` from inside
  `PlaceableObject#control()`. Core sets `_controlled` and only *then* sets the render flag
  that draws the selection frame and the resize handles, so the throw left the pin selected
  with neither. `bind()` now owns the object, and `_onControl`/`_onRelease` can no longer
  let module code break core's control flow at all.
- **Adopting a note or a tile always produced a pin**, ignoring the world's default mode.
  A GM whose default is "prop" converted a map note and got another small icon, with
  nothing to indicate anything had happened. Both adopt paths honour the setting now.
- **Queued style writes were lost whenever the tab was hidden.** The write queue was
  scheduled on `requestAnimationFrame`, which does not fire in a background tab, so a
  client that loaded a scene while not in front never sized its overlay or positioned a
  single prop — and never recovered. There is now a timeout floor under the frame.

## [0.1.2] — unreleased

First release tested in a live Foundry world. Four defects that only a running world could
show, and one finding that changes what the module claims to be.

### Fixed

- **Nothing in the DOM tier was visible at all** — no props, no placement ghost, no focus
  reader. `OverlayRoot.write()` kept one queued callback per element, so `canvasReady`'s
  `syncTransform()` silently discarded `alignToBoard()`'s size write and the overlay stayed
  0×0 with `overflow: hidden`. The same clobbering left every prop card with an opacity and
  no position or size.
- **The overlay was sized to the screen while its contents are positioned in scene
  coordinates**, so even once sized it clipped away every prop past the screen's width on
  the map. It is now sized to the scene.
- **The Pinboard's first-render focus did nothing**: ApplicationV2 attaches the window
  after building its content, and `focus()` on a detached element is a no-op.
- **Converting a map note threw and left the note behind.** The note config also opens for
  the unsaved preview document Foundry creates when a journal is dropped on the map; it has
  no id, so the delete raised an unhandled rejection after the pin had already been made.

### Changed

- **Props are not lit, fogged, occluded or sorted behind tokens, and cannot be.** An SVG
  containing a `foreignObject` taints the canvas in every current browser, so the WebGL
  upload the canvas path depends on is refused — verified on Chromium 144, not just Safari,
  with a plain-SVG control that uploads fine. The module already detected this and fell
  back to drawing props as an HTML layer; what has changed is that the README, the settings
  copy and `docs/DESIGN.md` now say so plainly instead of promising the opposite. See
  amendment A10.

## [0.1.1] — unreleased

### Fixed

Six defects an adversarial re-read of the hardening diff turned up, each reproduced with a
failing test first.

- **Searching the Pinboard stranded the keyboard.** `focusedId` was re-seeded only when it
  was null, so a search that excluded the focused row left no row tabbable — and ArrowDown
  out of the search box, the branch written for exactly that case, had nothing to land on.
- **The Pin HUD stole focus back.** It kept the last focused selector even when the focus
  had moved outside, so a GM who clicked a chip and then typed in chat had the caret pulled
  out from under them by the next tile update. Its remembered palette also carried across
  to a different pin, since one HUD instance serves them all.
- **A VRAM eviction showed the placeholder at full alpha** — a book icon stretched across a
  letter — because `applyAlpha` ran before `#trim`, and nothing re-applied it afterwards.
- **The reveal animated the placeholder in.** At the moment a reveal fires the prop's own
  texture has by definition not been drawn, so the animation faded the placeholder up and
  left it there, overriding the hold that exists to prevent exactly that. On the DOM path
  it appeared under the card.
- **Two inputs still produced ill-formed XML**: a namespace declaration written by the page
  itself came out twice on one element, and a vertical tab or form feed is a character XML
  forbids outright. Either made the prop permanently invisible, because the failure latch
  remembers the key until the content changes.

Also documents plainly, at the call site, that the focus reader opening without OBSERVER
is the module's deliberate position rather than an oversight — the pin's audience is the
authority, and ownership sync is a convenience on top of it.

## [0.1.0] — unreleased

First public beta. Pin any journal, page or image onto the map as a small icon or as a
full-size readable prop, with per-pin visibility the GM controls in one click.

Numbered 0.1.0 rather than 1.0.0 deliberately: the canvas behaviours have never been
watched working on a real scene, and a 1.0 that has not been run at a table is a promise
this project has not earned yet.

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

[Unreleased]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Heiiji/Documents-pinner/releases/tag/v0.1.0
