# Documents Pinner — Design

**Status:** Pre-release hardening complete; §11's manual column still unverified
**Target:** Foundry VTT v14, `compatibility: { minimum: "14", verified: "14.365" }`
**Last updated:** 2026-08-27

---

## 1. Goal and scope

A GM takes a document — a letter, a rumour, a warrant, a hand-drawn map scrap — and puts
it **on the map**, not in a window. Two shapes:

- **Pin** — a small icon on the scene; players click to open the document.
- **Prop** — the document lies on the map at full size and is readable in place.

Three requirements shape everything downstream:

1. **Visibility is the GM's to control and trivial to change mid-session.**
2. **Subtle, immersive per-pin effects.**
3. A stack capable of carrying those effects.

### 1.1 Out of scope

- Editing document content from the map. Props are a view; the sheet is the editor.
- Replacing core Map Notes. Native drag-to-canvas keeps making a plain `Note`; we add a
  modified gesture and a one-click "adopt this note" path instead.
- Player-authored pins. Players read; only the GM places and reveals.
- Rolling a pinned RollTable from the map. That needs OWNER, which we never grant.
- Animated video content inside a prop.
- Guaranteeing secrecy beyond what core Foundry itself guarantees. See §3.

---

## 2. Anchor decision — one `TileDocument` per pin, both modes

Modules cannot define new embedded Document types in a Scene, so every placeable must
piggyback on an existing type plus flags. Three candidates were considered seriously.

| | `Note` | `Drawing` | **`Tile`** |
|---|---|---|---|
| width / height / rotation / alpha | ✘ | partial | **✔** |
| `hidden` (GM-only, core-enforced) | **✘** | ✔ | **✔** |
| `locked`, `elevation`, `sort`, `texture` | partial | ✔ | **✔** |
| HUD + config sheet + v14 shape handles | ✘ | ✔ | **✔** |
| visibility coupled to journal ownership | **✔ (fatal)** | ✘ | ✘ |
| already a `PrimarySpriteMesh` in `canvas.primary` | ✘ | ✘ | **✔** |

**`Tile` wins on the two requirements the product is actually about:**

1. **Lossless mode switching.** Switching pin ↔ prop is one atomic `Tile#update`. A
   split Note/Tile design would need delete + create: non-atomic, changes the `_id` and
   every UUID referencing it, and breaks core undo.
2. **Visibility decoupled from ownership.** `Note#isVisible` / `_canView` consult the
   linked journal's permissions, so a Note literally cannot be shown to a player who
   lacks ownership. `Tile` has no such coupling, which is what makes §3 possible.

Two costs, both cheap to pay:

- **The Tiles layer is GM-only**, so players cannot hover or click a Tile. Solved by a
  module-owned `CanvasLayer` in group `interface` carrying invisible hit areas.
- **Native sidebar drag makes a `Note`.** We do not hijack it; see §5.1.

---

## 3. Security model

| Concern | Mechanism | Enforced |
|---|---|---|
| Pin hidden from all players | core `TileDocument#hidden` | client (core parity) |
| Pin visible to a subset | our `audience.canSee` via `PinnedTile#isVisible` | client (core parity) |
| Prop content reaching a player | each client enriches from its own copy | client |
| GM secrets inside a page | `enrichHTML({ secrets: page.isOwner })` + post-filter | **content removed** |
| Document appears in the sidebar | ownership ledger (§4) | **server** |
| Writing a pin's configuration | GM only; players never write | **server** |

**Stated plainly, and repeated in the README:** visibility is enforced *at parity with
core Foundry, not above it*. Core enforces `Tile#hidden` and `Note#global` on the
client too. A determined player with a browser console can see a hidden pin's existence
in exactly the same way they can today for any hidden tile.

The one thing that is genuinely removed rather than hidden is a page's `secret`
sections, because `enrichHTML` strips them for non-owners before the HTML exists.

### 3.1 Why reveal does not require ownership

`Journal.show(doc, { force, users })` displays a document "regardless of normal
permission", and `Journal._showEntry(uuid, force)` takes only a UUID and resolves it on
the receiving client. That is only possible if clients already hold world-document data.

Consequence: **ownership sync is a convenience, not a security necessity.** It exists so
a revealed journal also lands in the player's sidebar and persists after the session. It
is optional, and with it off the module opens its own read-only viewer instead.

---

## 4. The ownership ledger

Raising ownership is a destructive edit to data the GM owns, so it must be exactly
reversible. `src/data/ownership-plan.ts` is pure and fully unit-tested.

Stored on the **source** document at `flags["documents-pinner"].grants`:

```jsonc
{
  "v": 1,
  "baseline": { "default": 0, "aliUserId": null },   // null = key was absent
  "granted":  { "aliUserId": 2 },                     // what WE wrote
  "holders":  { "aliUserId": { "Scene.s1.Tile.t1": 2 } },
  "overridden": []
}
```

Three invariants, in order of importance:

1. **Never lower a level that was already higher.** `value = max(baseline, maxHolder)`.
2. **A deliberate GM edit always wins.** On release, restore the baseline *only if* the
   value we wrote is still the value present. Otherwise leave it, drop our bookkeeping,
   and notify. `planRebase` folds manual edits in as they happen.
3. **Releasing every holder restores the exact prior state**, deleting a key that did
   not exist before rather than writing a spurious `NONE`.

A reconciliation sweep on `ready` (acting GM) repairs module-disabled-then-re-enabled,
deleted scenes, and any crash mid-write.

Required level is **OBSERVER (2)** for both modes: at LIMITED a text page will not open
and is not even listed in the journal sheet. LIMITED is exposed as a deliberate "tease".

---

## 5. Interaction

### 5.1 Entry points

Native drag-to-canvas is **not** hijacked — it is the most established journal gesture
in Foundry and other modules build on it. `dropCanvasData` acts only with a modifier.

| Rank | Entry point | Hook |
|---|---|---|
| 1 | **Alt-drag** journal/page from the sidebar | `dropCanvasData` + `isModifierActive("Alt")` |
| 2 | Journal sheet header button | `getHeaderControlsApplicationV2` |
| 3 | Two tools in `controls.notes.tools` | `getSceneControlButtons` |
| 4 | Sidebar and page context menus | `get*ContextOptions` |
| 5 | Keybindings | `game.keybindings.register` |

No new top-level scene-control group: the rail is contested, and pins belong with Notes.

### 5.2 Placement — ghost, not modal

A modal cannot answer the only questions that matter at placement time (*how big is it
here, does the effect read against this map, is it covering the door*) and costs two
extra clicks per pin. A ghost of the real prop follows the cursor with a legend chip:
wheel rotates, `Alt+wheel` scales, `Space` toggles mode, `E` cycles effect, `V` cycles
audience, `Shift+click` places and stays armed, `Esc` cancels.

### 5.3 Changing visibility — two surfaces

The **Pin HUD** answers *this one, right now*; the **Pinboard** answers *the whole
scene*. Both use the same avatar-chip widget: filled = can see, hollow = cannot, and a
**key glyph** when presence and content access disagree. That mismatch is exactly the
bug a GM ships to their table and only discovers when a player says "I can see it but it
won't open."

Live-play constraints the Pinboard is optimised for: one-handed keyboard operation, no
confirmation dialogs on reversible actions, first-class bulk selection, and a hand-sorted
row order that doubles as the reveal order.

---

## 6. Rendering

Prop content is rasterised **on each client** (enriched HTML → SVG `foreignObject` →
`OffscreenCanvas` → `PIXI.Texture`) and bound to the Tile's own `PrimarySpriteMesh`.

Living in `canvas.primary` buys, for free: darkness tinting, per-light illumination, the
vision/fog mask, roof occlusion, and correct z-order against tokens. A DOM card floating
unlit over a dark dungeon is the single most immersion-breaking artefact this module
could ship, and no amount of CSS can fix it — per-light illumination is a fragment-shader
operation over the primary group.

Per-client rasterisation also means `enrichHTML({ secrets: page.isOwner })` produces
per-user content, so GM secrets stay secret. That is impossible with a shared image.

The **DOM is the focus tier only**: clicking a prop dims the mesh and fades in a live
HTML reader with selectable text, working `@UUID` links and live inline rolls. This
bounds DOM cost to 1–3 elements and turns the out-of-focus preset from a gimmick into
the module's signature affordance.

### 6.1 LOD ladder

| Tier | Condition | Texture | Effect | DOM |
|---|---|---|---|---|
| L0 culled | off-viewport / hidden / not in audience | released after 5 s | — | — |
| L1 silhouette | apparent width < 48 px | shared tinted paper | — | — |
| L2a coarse | 48–320 px | 512 px long edge | ½ intensity, ≤3 taps | — |
| L2b full | ≥ 320 px | `min(2048, nextPow2(px·dpr))` | full shader | — |
| L3 reader | focused, ≥ 480 px, readable | unchanged | eases into focus | live HTML |

### 6.2 Hard performance rules

- **Never `backdrop-filter`** — over a WebGL canvas it forces a per-frame readback.
- **Never animate SVG `feTurbulence` `baseFrequency`/`seed`** — full CPU re-evaluation
  every frame. Static use only.
- Any `PIXI.Filter` must set `filter.resolution` explicitly, or filtered props render
  visibly softer than unfiltered ones.
- One ticker callback for the whole module; one shared `PIXI.UniformGroup`.
- Transform sync is guarded by a dirty check on the six matrix components, **not** by
  the `canvasPan` hook — that hook fires every tick during an animated pan.
- Texture generation is a concurrency-1 priority queue; resolution tiers snap to powers
  of two so a slow zoom cannot thrash.
- `PIXI.Texture.from(canvas)` caches by the canvas's internal id: always
  `texture.destroy(true)` on eviction, or GPU memory leaks.

---

## 7. Effects

Ten shipped presets, each a closed declarative parameter object. There is deliberately
**no free-form CSS field**: presets are meant to be exported and pasted in from
strangers, so a preset must have no injection surface. `safeUrl()` is the single place a
preset string reaches CSS, and it rejects anything that could end a `url()` token.

`cost` is **derived** by `estimateCost()`, never authored, so a parameter edit cannot
leave an expensive effect labelled cheap.

Implementation preference order — **baked > shader > CSS**. Baked effects cost nothing
per frame and survive a future PIXI major version untouched.

Accessibility: client setting `effectsLevel: auto | full | reduced | off`. `reduced`
**keeps static identity** (tint, frame, texture, edge shape) and drops only motion and
per-pixel work. If reduced motion turned every prop into a grey box, GMs would tell
their players to switch it off — so `preset-css.test.ts` asserts that no shipped preset
collapses to a blank card under `reduced`.

---

## 8. Stack

- **Vite + TypeScript**, single unminified ESM output with sourcemaps, so user bug
  reports quote real file names and line numbers.
- **Type-checking is decoupled from the build.** Foundry v14 type definitions are
  immature — no stable release exists for any Foundry generation. esbuild strips types
  without checking them, so `npm run typecheck` is a separate, advisory CI job. A types
  regression can never block a release.
- **Plain CSS, no preprocessor.** Chromium 144 supports `@layer`, `@import … layer()`,
  native nesting, `@property`, `:has()`, `color-mix()` and `@container` natively.
- **Pure/impure split.** Pure modules never touch a Foundry global, at import time or
  inside a function body, so they are unit-testable under Node. Validators return i18n
  **keys**, never prose.
- **No sockets.** Content is enriched per-client from local data, so there is nothing to
  broadcast. `canvas.ping()` already displays on all clients for the flash action.

---

## 9. V14 API notes

**Verified:**

- v14 is GA; 14.365 is v14 Stable 7 (July 2026).
- `Journal.show(doc, { force, users })` displays "regardless of normal permission";
  `Journal._showEntry(uuid, force)` takes only a UUID and resolves it client-side.
- `getSceneControlButtons(controls)` receives a **Record** keyed by control name, not an
  array. Tools are also a record. A tool with neither `onChange` nor `onClick` throws.
- `CONFIG.Canvas.layers[name] = { layerClass, group }` is usable by modules.
- v14 added `PrimaryCanvasObject#inPrimary`, `PrimaryCanvasContainer#sortLayer`,
  elevation auto-propagation, FADE occlusion in containers, `Tile#name`, `Tile#levels`,
  and `ApplicationV2#detachWindow`.
- `BaseNote` has **no** `hidden`, `width`, `height` or `rotation`, and there is no
  `NoteHUD` in `foundry.applications.hud`.
- v14 deprecated the `-=` / `==` special operation keys in favour of `DataFieldOperator`.
  `-=` still works; it is isolated in `DELETE_PREFIX` for a one-line migration.

**Unverified — resolved by `docs/spike-0-probe.js` before the canvas tier is built:**

1. `PIXI.VERSION` in v14 (assumed 7; the v8 migration was deferred during v13).
2. `PrimarySpriteMesh#setShaderClass()` accepting a custom sampler shader while keeping
   `renderDepthData()` and occlusion intact. **Highest uncertainty.**
3. `dropCanvasData` returning `false` suppressing core's default Note creation.
4. `Tile#isVisible` overrides propagating to `mesh.visible`.

Derived at runtime, never hardcoded: the Tile placeable context hook name, the font
definitions API shape, whether `pixi-filters` is bundled, `_stats.compendiumSource`, and
whether a public HTML sanitiser exists (assume not — strip explicitly).

---

## 10. Known limitations

1. Prop text is rasterised: not selectable, no screen-reader access, no clickable links.
   The focus reader restores all of it, and the sheet is always one click away.
2. Rasterisation inlines fonts and images as `data:` URIs. Anything the SVG
   `foreignObject` context cannot resolve renders as a fallback; exotic CSS in journal
   HTML will not render.
3. WebKit `foreignObject` rasterisation is unreliable — probed at `ready`, falls back to
   the DOM tier.
4. No animated content in props; video renders as a single frame.
5. Source edits are debounced ~250 ms, not per-keystroke.
6. The focus reader is always on top: not occluded, not lit. Intentional — it is a UI
   affordance, not a scene object.
7. In a multi-level scene a prop belongs to the level its `elevation` falls in.
8. Anchors are real Tiles and appear in `scene.tiles` to other modules.
9. Deleting the source leaves the anchor showing a placeholder. It is never auto-deleted;
   that would be destructive and unrecoverable.
10. Compendium pack ownership is role-based and pack-wide, so there is no per-user grant.
11. Scene padding changes do not move props — core does not reposition placeables either.
12. A future PIXI 8 migration requires rewriting all GLSL. Shaders are isolated under
    `src/effects/shaders/`, and every preset has a bake or CSS rendition that survives.

---

## 11. Acceptance criteria

Test world: one scene at darkness 0.8, two lights, a roof tile, three tokens, four players.

| # | Criterion | Covered by |
|---|---|---|
| 1 | Alt-drag places a pin; wheel rotates; `Space` switches mode; `Ctrl+Z` undoes | manual |
| 2 | A prop is darkened by scene darkness and lit by a torch | manual |
| 3 | A prop is hidden by unexplored fog and occluded by a roof tile | manual |
| 4 | A token standing on a prop renders in front of it | manual |
| 5 | Toggling one avatar chip changes visibility for exactly that player, live | manual |
| 6 | GM secrets are absent from a player's prop (check their DOM, not the picture) | manual |
| 7 | Reveal → un-reveal restores ownership byte-for-byte | `ownership-plan.test.ts` |
| 8 | A manual GM permission edit survives un-reveal and raises the badge | `ownership-plan.test.ts` |
| 9 | Mode switch keeps the same `_id`, all flags, and the Pinboard row | manual |
| 10 | 50 props hold 60 fps; auto-degrade toasts once; VRAM stays under budget | manual |
| 11 | `prefers-reduced-motion` stops animation but presets keep their identity | `preset-css.test.ts` |
| 12 | No shipped preset collapses to a blank card under `reduced` | `preset-css.test.ts` |
| 13 | A hostile preset cannot inject CSS through a texture path | `preset-css.test.ts` |
| 14 | Deleting the source shows a placeholder with no console errors | manual |
| 15 | Disable → re-enable repairs the ledger with no orphan grants | manual |
| 16 | The Pinboard is fully operable one-handed from the keyboard | manual |
| 17 | With ownership sync off, a player without permission still opens the viewer | manual |
| 18 | Scene→screen maths is correct under pan, zoom and a rotated stage | `transform.test.ts` |
| 19 | `en.json` and `fr.json` stay key-for-key parallel with matching placeholders | `i18n.test.ts` |

---

## 12. Repository layout

```
src/
  main.ts            hook registration only, no logic
  const.ts  i18n.ts  api.ts  settings.ts
  data/       PinData  PinStore  audience*  ownership-plan*  migrations*
  canvas/     PinnedTile  PropRecord  PropManager  PropHitLayer  DomPropTier  transform*
  render/     ContentResolver  enrich  CardTemplate  AssetInliner  Rasterizer  TextureCache
  effects/    EffectRegistry  preset-schema*  preset-css*  presets/*  shaders/*
  apps/       DocumentPicker  PlacementGhost  PinStudio  Pinboard  PinHUD
              PresetStudio  ReaderOverlay  PropTooltip  OverlayRoot
  ui/         controls  keybindings
styles/       documents-pinner.css (entry) + base, theme, fx/*, ui/*
templates/  lang/  assets/  tests/  docs/  .github/workflows/
```

`*` marks a **pure** module: no Foundry globals, unit-tested under Node.

`styles/card.css` is both loaded normally (for the focus reader) and fetched and inlined
into the SVG by the rasteriser, so the two rendering tiers cannot drift.

---

## 13. Amendments

Appended rather than folded into the sections above, so the reasoning that led to a
decision stays readable next to the observation that changed it.

### A1 — Spike 0 results (2026-08-27)

Run on 14.365. The three facts that mattered most all came back favourable:

| # | Assumed | Found |
|---|---|---|
| 1 | PIXI 7 | **7.4.3.** GLSL stays ES 1.0; no shader rewrite. |
| 2 | `setShaderClass` usable — highest project risk | **Present**, with `PrimaryBaseSamplerShader` and `renderDepthData`. The risk is retired. |
| — | — | `CONFIG.Canvas.layers` already carried a third-party `knight` layer, so §9's claim is confirmed in the field, not just in the docs. |
| — | — | `MAX_TEXTURE_SIZE` 16384, so the 2048 top rung has ample headroom. |
| — | — | `core.photosensitiveMode`, `_stats.compendiumSource`, both font APIs, `Journal.show`/`_showEntry`, `BasePlaceableHUD`, `detachWindow` and `testVisibility` all present. |

**Two findings changed the plan.**

**`pixi-filters` is NOT bundled** — `GlowFilter`, `OutlineFilter`, `DropShadowFilter` and
`AdjustmentFilter` are all absent. §7's "baked > shader > CSS" preference becomes a
requirement for glow, outline and drop-shadow: there is no filter to fall back to.

**`PIXI.Filter.defaultResolution` is `null` and the renderer runs at `resolution: 1`**
even on a Retina display, because Foundry exposes its own pixel-ratio setting. §6.1's
`min(2048, nextPow2(px·dpr))` is therefore **amended to use
`canvas.app.renderer.resolution`, not `window.devicePixelRatio`** — sizing from the
display's ratio would allocate four times the VRAM for pixels Foundry never draws.
Implemented as `fvtt.rendererResolution()`.

### A2 — The probe was run in Safari, and that turned out to be useful

`requestIdleCallback: false`, `deviceMemory: n/a` and the error text *"The operation is
insecure."* are all WebKit signatures. So the run doubles as the WebKit compatibility
baseline, and three things follow:

- **`foreignObject` rasterisation taints the canvas there**, exactly as §10.3 predicted.
  Both the readback and the WebGL upload fail. `Rasterizer.probeRasterisation` detects it
  at `ready` by counting painted pixels and the client falls back to DOM rendering.
- **`requestIdleCallback` does not exist**, so `fvtt.onIdle` shims it with a timeout.
- **`navigator.deviceMemory` does not exist**, so `resolveAutoLevel` must treat an absent
  signal as "capable" rather than "small" — assuming the worst would permanently reduce
  effects for every Safari user.

Two probe verdicts were **not** real failures and must not be read as such:

- Probe 4 reported `mesh.visible undefined -> undefined` because the probe created its
  test tile with `{ render: false }`, so no placeable was ever drawn. Fixed in the probe;
  **still unresolved**, and `PinnedTile` therefore hides the mesh explicitly in
  `_refreshVisibility` *as well as* through `isVisible`. The safeguard only ever hides,
  never shows, so it cannot fight core's own occlusion and culling.
- Probe 3 (`dropCanvasData` cancellation) is **still unresolved**. The drop handler both
  returns `false` and sweeps away any Note created from the same drop within 250 ms. If
  cancellation works the sweep finds nothing and costs nothing.

Probe 13 was inconclusive — `#board`'s parent carries no id — so `OverlayRoot` derives its
mount point by reference rather than by name, falling back to `#interface` and `body`.

### A3 — "Baked" means rasterised CSS, not a shader

A prop's pixels are produced by drawing HTML, so tint, grain, stains, edge shape, frame,
shadow and static scanlines are simply CSS applied at rasterisation time. That costs
nothing per frame, needs no shader at all, and survives a future PIXI major untouched —
which is exactly what §7 asked "baked" to mean, arrived at by a route the design did not
anticipate. With `pixi-filters` absent (A1) this is now the primary path rather than the
preferred one.

Only genuine motion needs anything else, and only the one focused reader ever runs it.
GLSL under `src/effects/shaders/` is therefore **not shipped in v1**: it could not be
verified without a live world, and shipping unverifiable shader code would have been
worse than shipping none. The `setShaderClass` finding in A1 means the door is open.

### A4 — Shipped presets no longer reference texture files

Three presets pointed at `papers/*.webp`, which the module does not ship. Worse than
missing: a real file would load in the DOM reader and draw *nothing* in the rasteriser,
because an SVG rendered as an image cannot fetch — the two tiers would have disagreed
about what a prop looks like, silently. `effects/textures.ts` generates grain, stains and
edge masks from static `feTurbulence` as `data:` URIs instead: deterministic from the
pin's stored seed, identical in both tiers, and no binary assets in the repository.

### A5 — `DpGeometry` added to the payload

Lossless pin↔prop switching (§2) needs each mode's size remembered, or switching back
silently resizes a prop the GM had sized by hand. One group added to `DpPinFlags`;
`naturalSize` in `pin-schema.ts` is the single definition both the store and the
placement ghost use, so a pin cannot change size depending on which code path made it.

### A6 — The sanitiser had an mXSS hole, found by its own tests

Testing the scrub against a real parser rather than through its own string output caught
it: `<scr<script>` parses into an element whose tag *name* contains `<script`, which
survives a name-based deny-list and re-parses into a live script the next time the string
meets a parser. Two fixes, both in `render/enrich.ts`: any tag name a well-formed parse
could not have produced is removed on sight, and the scrub round-trips until the
serialised output stops changing. §3's claim about secrets was already sound; this was
the other half of the same call site.

### A7 — Rendering mode is a real setting, not just a fallback

§8 treats DOM rendering as a compatibility path. A2 makes it the *only* path on WebKit,
so it is exposed as a client setting (`Prop rendering: Canvas / DOM`) rather than left
implicit, and the README says plainly what is lost: on the DOM path props are not lit,
fogged or occluded, because that is a property of being drawn *into* the scene.

### A8 — What is still unverified

Everything in §11's acceptance table marked "manual" remains manual, and none of it has
been watched working on a real scene. Specifically: darkness and torch lighting on a prop,
fog and roof occlusion, token z-order, the live audience toggle, secret absence in a
player's own texture, the ownership round-trip with a manual edit in between, mode
switching, fifty props at 60 fps, and one-handed Pinboard operation. The README says so
too.

### A9 — Pre-release hardening: what A8 cost (2026-08-27)

A8 said plainly that nothing in §11's manual column had been watched working on a real
scene. A four-reviewer council then read the code against that admission, and found that
**several headline features had never executed at all** — not "behaved subtly wrong", but
never ran. This amendment records what that turned out to be, because the pattern matters
more than any individual defect.

**The pattern.** 403 tests, all green, over code where no prop had ever rendered. Every
one of them covered a pure function's return value or a markup string's contents, and
every blocking defect lived in the seam between two of those: an SVG string handed to an
XML parser, an ApplicationV2 action handler's `this`, a `Document#update` that merges, a
listener attached to an element that is not replaced. §12's pure/impure split is still the
right architecture — but it made the impure half look tested when the pure half was.

`tests/helpers/fake-foundry.ts` now provides the missing seam: the real ApplicationV2
render and action-dispatch contracts, Foundry's own document merge semantics, and enough
PIXI for the canvas layers. Every fix below is anchored by a test that failed before it.

#### What had never run

| | |
|---|---|
| **Nothing rendered, ever** | An SVG loaded through `Blob -> img.src` is parsed by the XML parser. `card.css` uses native nesting, so 13 bare `&` characters went into a `<style>` element XML gives no implicit CDATA — and the stylesheet is always inlined, so **every prop failed on every client**. `sanitise` and `inlineImages` both returned `body.innerHTML`, leaving void elements unclosed and `&nbsp;` undefined. 5 of 6 representative cards failed to parse. |
| **Nothing to bind to** | Document-backed anchors were written with `texture: { src: null }`. Core does not add a tile with no valid texture to `canvas.primary`, so there was no mesh, and `#bind` returned silently — indistinguishable from "still loading". |
| **The DOM tier did not exist** | `rendering: "dom"` and the WebKit fallback both bailed out of `#pump`, and `OverlayRoot.mount` had two callers, neither a prop. Every Safari user got invisible props while three documents said otherwise. |
| **Players could not click a pin** | `PropHitLayer.sync` filtered to prop mode. The Tiles layer is GM-only — that is §2's premise and this layer's whole reason to exist — so the brief's first promise was unreachable for everyone it was written for. |
| **The Pinboard's bulk buttons** | Four action handlers read the PointerEvent as the application. Two threw; the two global ones failed silently, because `store.all(event)` finds no tiles. |
| **The keyboard** | No row was ever focused, so DoD #12 was unmet on every path while `DP.board.help` advertised ten unreachable shortcuts. |
| **User presets** | The render pipeline and both galleries called `getCorePreset`, so the Preset Studio produced artefacts the module could not consume. |

#### Corrections to earlier amendments

**A6 was half right, and the half that was wrong could not have been caught by its own
method.** The tag-name fix genuinely works — `<scr<script>ipt>` is removed, verified. But
the round-trip cannot catch a `<noscript>` mutation by construction: `DOMParser` parses
with scripting *disabled*, so the scrub reaches a fixpoint of the **wrong parser** on the
first pass and then agrees with itself forever. Confirmed with parse5: the same string
yields `noscript p[title]` to the sanitiser and `noscript img[src,onerror] p` to the
browser, and the same trick resurrects a stripped `.secret` section. `noscript` is now
removed outright, `scrub` and `stripSecrets` descend into `<template>` content, and
`sanitise` **fails closed** rather than returning markup that never converged.

The lesson generalises past this one element: **testing a sanitiser against the parser it
uses tests it against its own assumptions.** The new tests re-parse with
`scriptingEnabled: true`.

**A7 described a setting that had nothing behind it.** The DOM path is now real:
`src/canvas/DomPropTier.ts`, pointer-transparent so `PropHitLayer` keeps owning
interaction on every tier, positioned in scene space so it costs no per-frame write. A7's
statement of what is lost there — not lit, not fogged, not occluded — is now accurate
rather than aspirational.

**§4's ledger was correct and unreachable.** `ownership-plan.ts` computes its deletions
exactly, and `applyPlan` wrote the whole ledger as a nested plain object, which
`Document#update` deep-merges — so no key could ever leave the stored ledger. The module
depends on that merge everywhere else, which is why the bug was invisible. The plan is
untouched; the layer around it now unsets and re-sets the flag in one update. Dotted paths
cannot express this, because `holders` sub-keys are anchor UUIDs and contain dots.

*Reasoned from Foundry's documented merge semantics and modelled in `fake-foundry.ts`, not
traced against Foundry's source. **Confirm in a live world.***

**§4's invariant 2 did not hold for a raise.** `planRebase` adopted a manual raise into
`granted` but left `baseline` behind, so the next release saw no override and restored the
old value — and when the baseline was `null` because the key had not existed before us, it
emitted `-=key` and **deleted the player's ownership outright**. The baseline now moves
with the raise. `tests/ownership-plan.test.ts` previously locked in the old behaviour with
a non-null baseline, where the damage was a silent revert rather than a deletion.

#### Amendments to §6.2 and §11

**The auto-degrade guard measured the wrong thing.** It timed one counter increment, a
matrix read and six float compares — microseconds against a 4 ms budget — because every
real cost in this module is deliberately off the ticker, which is exactly what §6.2 asked
for. The guard could never fire and acceptance criterion 10 could never be observed. It
now reads `sampledFps()`, the same rolling rate the effects level already trusts.

**Ghost-placed props broke acceptance criterion 4.** `foregroundElevation` is the scene's
foreground *threshold*, not an elevation to inherit: a tile at or above it is an overhead
tile and sorts above tokens. Every ghost-placed prop therefore rendered in front of a token
standing on it — one of the two visual claims the primary-group architecture was chosen
for. Now placed at 0.

**Async work had no liveness check.** Five awaits separated the decision to draw from the
write, with nothing verifying the record, the tile, the scene or the tier still existed. A
monotonic epoch now guards every await. This is the missing half of §6.2's frame
discipline: the frame path was careful and the *off*-frame path was not.

#### Deferred, deliberately

Two Group 4 items are **not** fixed, for the same reason A3 gave for not shipping GLSL:
shipping code that cannot be verified is worse than shipping none.

1. **`PIXI.Texture.from(canvas)` retains the `OffscreenCanvas`**, so every prop carries its
   pixels twice — a 2048² prop is ~22 MB of VRAM plus ~16 MB of system memory, and at the
   256 MB default the true footprint approached half a gigabyte. The real fix is
   `createImageBitmap` and releasing the canvas, which means handing PIXI a different
   resource type and could not be verified against a live v14 renderer here. Instead
   `textureBytes` now counts **both sides**, so the budget means total memory and the
   accounting is honest while the retention stands.
2. **`readPin` runs full schema validation on every read**, including from
   `PinnedTile.isVisible`, a hot getter. Memoising on the raw flag object's identity is the
   obvious fix and is **unsafe**: Foundry's `mergeObject` may mutate a nested flag object in
   place rather than replacing it, and a memo that served a stale audience payload would be
   exactly the failure class this pass exists to remove. Left as it is until the identity
   question is settled against Foundry's source.

#### Removed rather than left looking finished

**The `discovered` audience is no longer offered by the Pin Studio.** Its visibility half
works — every client evaluates its own line of sight — but the sticky half needs a
*player's* discovery to be persisted, and §3 says players never write pin configuration
while §8 says the module ships no socket. So `discovered` stayed permanently `[]`,
`grantKeysFor` returned nothing, and ownership sync could never fire: a permanent "visible
but won't open" for an audience kind the UI was advertising. `shouldRecordDiscovery` and
`canSee`'s handling remain, because the route in is real — a GM-side sweep over each
player's own tokens' vision polygons, which needs no socket — but it is future work, not a
shipped feature.

#### §11 is still the open question

Everything above was found by reading and proved by executing. **None of it replaces the
manual acceptance table**, which remains exactly as unverified as A8 said. The value of
this pass is that the table can now be run at all: before it, nine of the nineteen criteria
were untestable because no prop had ever appeared on a scene.
