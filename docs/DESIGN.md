# Documents Pinner — Design

**Status:** Beta. §11 criteria 2, 3 and 4 are UNREACHABLE — see amendment A10
**Target:** Foundry VTT v14, `compatibility: { minimum: "14", verified: "14.365" }`
**Last updated:** 2026-09-02

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
| L3 reader | focused, type ≥ 9 px apparent, readable | unchanged | eases into focus | live HTML |

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
- **Plain CSS, no preprocessor.** The stated baseline is Chrome 120 and Firefox 129, held
  by `tests/css-baseline.test.ts` — the two numbers being unprefixed `mask-image` and
  `@starting-style`, which are the newest things the stylesheets actually use. Registering
  a property with `@property` gives it a type and an initial value; nothing currently
  interpolates one, so the cross-fade §7 once described here does not exist yet. See A21.
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
13. A pin on a whole journal whose FIRST page is a PDF shows a placeholder card rather
    than the page. `pdfSourceOf` asks the resolved source's type and that is the entry;
    making the null default fall through would desync four call sites that agree by
    construction today — `isPdfPin`, `PropManager.drawsAsDom`, `migrations.drawnAsCard`
    and `resolveCard` all read `resolveSourceSync`. Choosing the page explicitly is one
    click and produces exactly the right result.

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
  const.ts  i18n.ts  api.ts  settings.ts  motion*
  data/       PinData  PinStore  audience*  ownership-plan*  migrations*  pin-schema*
  canvas/     PinnedTile  PropRecord  PropManager  PropHitLayer  DomPropTier  transform*  lod*
  render/     ContentResolver  enrich  CardTemplate*  AssetInliner  Rasterizer  TextureCache
              measure
  effects/    EffectRegistry  preset-schema*  preset-css*  presets/*  shaders/*
  apps/       DocumentPicker  PlacementGhost  PinStudio  Pinboard  PinHUD
              PresetStudio  ReaderOverlay  PropTooltip  OverlayRoot  pinboard-model*
  ui/         controls  keybindings  onboarding
styles/       documents-pinner.css (entry) + base, theme, fx/*, ui/* (focus.css last)
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

### A10 — The canvas tier cannot work. Found by running it. (2026-08-27)

A9 ended by saying the value of that pass was that §11's manual table could now be run at
all. It was run, in a live v14 world on Chromium 144, and the first criterion killed the
design's central mechanism.

#### The finding

**An SVG image containing a `foreignObject` taints the canvas it is drawn into, and a
tainted canvas cannot be uploaded to WebGL.** Measured in the world, not reasoned about:

| | |
|---|---|
| plain SVG → canvas → `texImage2D` | **OK** |
| SVG with `foreignObject` → canvas → `getImageData` | `SecurityError: tainted by cross-origin data` |
| SVG with `foreignObject` → canvas → `texImage2D` | `SecurityError: Tainted canvases may not be loaded` |
| `createImageBitmap(svgBlob)` | `InvalidStateError: source image could not be decoded` |

The control matters: the *same* pipeline with a plain `<rect>` SVG uploads fine. It is the
`foreignObject` — the one thing the whole approach depends on — that taints, and there is
no route around it along this path.

**A2 read this as a WebKit quirk.** It is not. It is what every current browser does, and
the probe was right to fail; it simply had no idea it would be failing everywhere. The
comment in `Rasterizer.probeRasterisation` claiming the readback "fails in exactly the same
circumstances the WebGL upload does" turned out to be exactly true, which is why the
fallback worked — but the fallback is now the only tier, not the compatibility path.

#### What this costs

§6 chose the Tile anchor substantially so props would live in `canvas.primary` and get
darkness tinting, per-light illumination, the fog mask, roof occlusion and correct z-order
against tokens **for free**. None of that is reachable. Acceptance criteria 2, 3 and 4
cannot be met by this architecture in any browser tested, and the README and CHANGELOG now
say so at the top rather than promising it.

**The Tile anchor itself is still right**, for every reason in §2 that is not about
rendering: lossless mode switching, `hidden` enforced by core, visibility decoupled from
journal ownership, a real placeable other tooling can act on. Only the rendering premise
was wrong.

#### The honest route forward, not taken here

The only way to get a journal page into a WebGL texture without `foreignObject` is to stop
using HTML: lay the card out with Canvas2D primitives — measured text runs, rects,
gradients — and upload *that* canvas, which is never tainted. That is a real renderer, it
loses arbitrary journal HTML and every CSS-based effect, and it is a larger project than
this module has so far been. It is not attempted here, and nothing pretends it is.

#### Four defects the same session found

The DOM tier had never been seen either, and it was invisible for reasons that had nothing
to do with the above. All four were found by reading live DOM state, and all four are the
kind that only a running world shows.

1. **`OverlayRoot.write()` kept ONE callback per element**, so any two callers writing
   different properties of the same element in the same frame lost the first. `canvasReady`
   calls `alignToBoard()` then `syncTransform()` back to back — the overlay's size write was
   replaced by its transform write, leaving it **0×0 with `overflow: hidden`, which hides the
   entire DOM tier**: every prop, the placement ghost and the focus reader. The same
   clobbering made `DomPropTier.place()`'s geometry lose to `setDomPropAlpha()`'s opacity, so
   each card carried `style="opacity: 0.25"` and nothing else.
2. **The overlay was sized to the renderer's SCREEN while its children are positioned in
   SCENE coordinates.** Two different spaces, one box: with `overflow: hidden`, every prop
   past the screen's width on the map was clipped away. Now sized to `canvas.dimensions`.
3. **The Pinboard's first-render focus was a no-op.** ApplicationV2 builds the content and
   attaches the window afterwards, and `focus()` on a detached element does nothing — so the
   board opened with the row correctly marked `tabindex="0"` and the focus still on `<body>`,
   which is the exact state A9's fix was written to prevent. Deferred by a frame.
4. **`adoptNote` threw on a Note that did not exist yet.** `renderNoteConfig` also fires for
   the preview document Foundry opens when a journal is dropped on the map; it has `id: null`,
   so `delete()` raised `undefined id [null] does not exist in the EmbeddedCollection` as an
   unhandled rejection — after an anchor had already been created, leaving the GM with both a
   pin and the note it was meant to replace. Observed in the wild before it was reproduced.

#### The lesson, again

A9 said the pattern mattered more than any individual defect: tests over pure functions and
markup strings, none over the seams. A10 says the same thing one level out. **The seam
tests were right and still could not have found any of this**, because the questions here
were "what does this browser actually permit" and "what is the computed size of that
element" — and there is no substitute for putting the thing on a screen.

### A11 — Three more that only a live world shows (2026-08-27)

A10 said there is no substitute for putting the thing on a screen. A second live session,
prompted by "still just an icon and I can't even move or resize them", found three more.

**A pin could not be selected.** `showPinHUD` assigned `hudInstance.object = tile`, and
`BasePlaceableHUD#object` is a **getter with no setter** — `bind()` is what sets it. The
assignment threw from inside `PlaceableObject#control()`, which sets `_controlled` and only
*afterwards* sets the render flag that draws the selection frame and the resize handles. So
the pin ended up flagged as controlled, with no frame, no handles and no HUD:

```
TypeError: Cannot set property object of #<BasePlaceableHUD> which has only a getter
    at showPinHUD -> PinnedTile._onControl -> PlaceableObject.control
```

The line predates this pass. Every HUD test passed over it because the test double let
`object` be assigned — **a fake that is more permissive than the real thing tests nothing
at the point where it differs.** The double now models the getter, and `_onControl` can no
longer let module code break core's control flow.

**Adoption ignored the default mode.** `adoptNote` hardcoded `mode: "pin"` and `adoptTile`
inferred it from width, so a GM whose default is "prop" converted a note and got a small
icon with nothing to say anything had happened. That was the whole of "I try to have the
actual document displayed": the pins were *correctly* rendering as pins, because adoption
had made them pins.

**The write queue died in a background tab.** `requestAnimationFrame` does not fire while
the document is hidden — measured, with PIXI's own ticker still reporting 60 fps beside it —
so a client that loaded a scene while not in front queued the overlay's size and every
prop's geometry and applied none of it, permanently. A Foundry window on a second monitor
or behind another app is completely ordinary. There is now a timeout floor under the frame.

#### On PDFs, since it came up

Foundry ships pdf.js (`scripts/pdfjs/build/pdf.mjs`, confirmed 200, and it opened a
32-page document from this world). That matters more than it looks: **pdf.js paints with
Canvas2D primitives, not `foreignObject`** — so unlike an HTML journal page, a PDF page
rendered by pdf.js should produce an origin-clean canvas that CAN be uploaded to WebGL.

If so, a pinned PDF could be the one prop type that genuinely *is* lit, fogged, occluded
and correctly z-ordered, by the exact route A10 ruled out for everything else.

**It was checked, and it holds.** See A12.

### A12 — PDFs reach the canvas tier (2026-08-27)

A11 left this as a lead. It is now measured, on a live v14.365 server against a real
32-page document, and it is the best news this design has had:

| | |
|---|---|
| pdf.js → canvas → `getImageData` | **clean**, 561 697 painted pixels |
| pdf.js → canvas → `texImage2D` | **OK** |
| that texture bound to a prop's mesh | **drew the page on the map** |

Compare A10's table for HTML, where the same two calls both throw `SecurityError`. The
difference is the whole story: **pdf.js paints with ordinary Canvas2D calls and never goes
near a `foreignObject`**, so its output canvas is origin-clean and the WebGL upload is
permitted. A10's finding was never about SVG or about canvases; it was about
`foreignObject` specifically, and nothing else the module draws uses one.

So §6's premise is not dead — it is **alive for exactly one source type**. A pinned PDF is
a real object in `canvas.primary`: darkened by scene darkness, lit by torches, masked by
fog, occluded by roofs, and correctly sorted against tokens. Acceptance criteria 2, 3 and 4
are reachable for PDFs and remain unreachable for journal HTML.

`render/PdfPage.ts` holds it, with three decisions worth keeping:

- **`intent: "print"`, not `"display"`.** A display render drives itself through
  `requestAnimationFrame`, which never fires while the document is hidden — a Foundry
  window behind another app would hang mid-render forever. Observed exactly that while
  testing; the print intent renders on promises and produces the same pixels.
- **Cached per (file, page, size tier)**, because a LOD change asks again, and **one
  in-flight parse per file**, because eight props of one document must not parse it eight
  times.
- **The library is injected for tests.** It is fetched by URL out of Foundry's own
  `scripts/` directory, which no test environment can resolve, so the seam is explicit
  rather than mocked at the import — which keeps the intent, the tiering and the caching
  testable without pretending the pixels were.

`PropManager` therefore decides the tier **per prop** rather than per client: a PDF takes
the canvas path even where `rasterisationAvailable()` is false, because that latch is
about HTML. A GM who deliberately chooses DOM rendering still gets DOM for everything.

**The route this opens.** If the goal is a journal page that is genuinely lit and occluded,
the answer is now visibly shaped: lay the card out with drawing primitives rather than
HTML. pdf.js is an existence proof that a complex, text-heavy, image-bearing document can
be painted to an uploadable canvas — it just does not happen to be reading our HTML. That
remains a larger project than this module has been, and it is still not attempted here.

### A13 — §5.1 and §2 disagreed, and the GM paid (2026-08-27)

"There is no way for me to resize or move the document." Measured on the pin in question,
in the live world, on the layer the GM was actually standing on:

```
Notes layer   control() -> false   controlled: false
Tiles layer   control() -> true    controlled: true
```

Nothing was broken. Two correct decisions simply did not know about each other:

- **§2** anchors every pin on a `TileDocument`, for lossless mode switching and for
  visibility decoupled from journal ownership. Both still right.
- **§5.1** puts the module's tools under **Notes**, because the control rail is contested
  and pins belong beside map notes. Also still right.

But core only lets a Tile be selected while the **Tiles** layer is active, and it refuses
by returning `false` — no exception, no notification, no cursor change. So the module
placed a pin from Notes, left the GM on Notes, and every attempt to drag it did precisely
nothing, with nothing anywhere to explain why. §2 lists "the Tiles layer is GM-only" as one
of the two costs of the Tile anchor and solves it *for players* with `PropHitLayer`. It
never noticed the same wall stands in front of the **GM**.

Three exits, all cheap: a **Move and resize pins** tool beside the two that create the
problem, `locate` switching layer and selecting the pin it just found, and both READMEs
saying it outright.

**The pattern worth keeping.** A9 was tests that never touched the seams. A10 and A11 were
things only a browser could tell us. A13 is neither: every fact was in the design document
the whole time, in two sections that were each individually correct. Nothing catches that
except using the thing the way a user does — which is what "I feel like there is no way to
move it" was, and why it was worth more than another reading of the code.

### A14 — z-index 90 was a guess, and it cost the whole interface (2026-08-27)

`OverlayRoot`'s comment read: *"It sits at `z-index: 90`, below core's HUD at 100."* That
number came from ApplicationV2's default `position.zIndex`, and it is not what governs
here. Read off a live v14.365 client, the body is flat:

```
#interface   position: relative   z-index: auto    (its #ui-left / #ui-right are z 30)
#hud                              z-index: 1
#board       position: absolute   z-index: 0       <- the canvas
```

`#ui-left` and `#ui-right` carry z 30 inside a **z-auto** parent, which creates no stacking
context — so they compete in the ROOT one. An overlay at 90 therefore painted above the
sidebar, the chat log, the scene controls and the hotbar. Pointer events still passed
through, so nothing was *unclickable*; it was simply invisible underneath a parchment card,
which is worse in practice and was reported as a hard blocker. It is one.

The fix uses Foundry's own numbers instead of a guess: **the same stacking level as the
canvas, mounted immediately after it.** Above `#board` by DOM order, below `#hud` and far
below the interface by their own z-index — and it stays correct if core renumbers, because
it no longer asserts a number of its own.

Two things fell out of the same investigation:

- **`mountPoint()` believed `#board`'s parent was a positioned container** that also held
  `#hud`. In v14 `#board` is a direct child of `<body>`, so the "fallback" to body was in
  fact the normal path, and the overlay was appended at the END of the body — after
  `#pause` and `#tooltip`. Order matters now, so it is inserted, not appended.
- **The overlay was only ever seated once.** `overlay()` returned early whenever the
  element was still connected, so an overlay created before Foundry built its canvas stayed
  wherever it first landed for the rest of the session. It re-seats on every call.

**The pattern.** A13 was two correct design decisions that never met. A14 is one number
carried from a true statement about a different thing — ApplicationV2 windows really do sit
at 100 — into a place where it governed nothing. Both are invisible to a test suite and
obvious within one second of looking at the running application.

### A15 — Controls that could not be honoured (2026-08-28)

*"We should not offer options we are not able to honor."* That is the rule this document
already reached twice from the inside — `interaction.tooltip` in A9, the `discovered`
audience in A9 — and a user reached it from the outside, holding a slider that did nothing.

Three of them, found by asking what actually reads each stored field:

- **`effect.speed` and `effect.motion`** were written by the Studio, validated by the
  schema and stored on every pin. Nothing read either. `presetToCssVars` takes its motion
  from the PRESET's `motion` and its durations from the preset's own frequencies, so both
  controls moved and nothing changed. Speed now scales every `-dur` the preset emits, and
  `none` freezes exactly as a reduced-motion client does.
- **`onReveal`** was a third motion choice that the renderer treated identically to `loop`.
  Removed rather than faked.
- **Every appearance control, for a PDF pin.** A PDF is painted by pdf.js straight into a
  texture (A12), so it has no card at all: no paper stock, no padding, no effect layers, no
  edge mask. The whole Appearance tab was inert for one, silently. It is now disabled with
  the reason stated in the tab.

That last one is the interesting one, because it is a **consequence of A12 that A12 did not
notice**. Giving PDFs the canvas tier bought lighting, fog and occlusion — and paid for it
by leaving behind the card, which is where every visual effect in this module lives. The
tradeoff is real and probably the right one, but it was made silently, and a GM discovered
it by moving sliders.

**And a process failure worth writing down.** The z-index fix in A14 was folded into an
already-published `v0.1.5` by force-moving the tag. Foundry compares version strings, so
anyone who installed v0.1.5 in the window between the two pushes could never be offered the
fix — which is exactly what happened, and cost a round trip to diagnose against a client
running code that no longer existed anywhere. **A published tag is immutable.** The fix for
a bad release is the next number, every time.

### A16 — The effects come back, painted (2026-08-28)

A15 disabled a PDF pin's appearance controls because a PDF has no card for CSS to reach.
That was honest and it was also giving up too early, as the user pointed out: *"I think we
should be able to do some visual process on the pdf too … but maybe you need to filter what
we can do."* Both halves of that are right.

**What can be painted.** A10's finding was about `foreignObject` specifically — and there
is none in an effect layer. The tint is a `fillRect`, the stains and grain are plain
`feTurbulence` SVGs, and a plain SVG image was already measured uploading to WebGL without
complaint. So the static rendition composites onto the pdf.js page with ordinary Canvas2D,
and the result is still origin-clean:

| Layer | How |
|---|---|
| tint | `fillRect` under the preset's own blend mode |
| stains, grain | `drawImage` / `createPattern` of the generated SVGs |
| scanlines | stroked directly — the CSS value is a gradient, not an image |
| frame | `roundRect` + `stroke` |
| blur | `ctx.filter` through a copy, since a canvas cannot filter itself in place |
| torn edge | `destination-in` with the mask, last, so it carves everything above it |

**What cannot, and is therefore not offered.** Everything that moves: flicker, jitter,
chromatic drift, warp, the scanline roll. A texture has no motion and faking a still frame
of a moving effect would be a worse lie than saying so. That is exactly the line
`dressing({ baked: true })` already drew for the rasterised HTML tier, which is why this
takes its variables from there rather than inventing a second policy. Paper stock and
padding stay disabled too: they describe a card the PDF does not have.

**The bug the tests found while writing it.** The bake awaits image decodes, and it runs
inside the concurrency-1 generation queue. An `Image` that neither loads nor errors leaves
its promise pending forever — so one undecodable stain would have stopped every prop on
the scene from drawing, with nothing anywhere to explain it. A decode timeout now bounds
it: a missing layer is cosmetic, a stuck queue is not.

**The pattern.** A15 was "do not offer what you cannot honour" — the right rule, applied by
removing. A16 is the same rule applied the other way: find out what you can honour first,
and only then decide what to remove. The first reading cost a working feature for a week;
the second was one user sentence away.

### A17 — A deferred upload is an uncatchable upload (2026-08-28)

A16 shipped effect baking for PDFs after checking, in Chromium, that a generated
`feTurbulence` SVG drawn onto a canvas leaves it origin-clean and uploads to WebGL. It
does. **WebKit does not agree**, and the consequence was not a missing effect — it was the
entire scene going blank on Safari, reported as "completely broken, full red background".

The mechanism is the part worth remembering. `PIXI.Texture.from(canvas)` **does not
upload**; it registers a resource and the upload happens on the next render. So:

1. `bakeEffects` draws an SVG layer → in WebKit the canvas is now tainted.
2. `textureFromCanvas` succeeds, because nothing has touched the GPU yet.
3. PIXI uploads during its render loop → `texImage2D` throws `SecurityError`.
4. That throw is **inside PIXI's loop**, where the module has no `try` — the frame dies,
   and the renderer paints only its clear colour, which Foundry sets from the scene's
   `backgroundColor`. `#25070d`. Flat red.

A10 had already measured this exact error text and reasoned about it correctly; what was
missed is that **where** an exception is thrown decides how much it costs. The same
`SecurityError` caught in our own code is one prop without stains; uncaught in the
renderer's loop it is the whole canvas.

Three rules now, in `Rasterizer`:

- **Ask the canvas.** `getImageData(0, 0, 1, 1)` in a `try` before PIXI is handed anything.
  Browsers disagree about what taints and will keep disagreeing, so the canvas is asked
  rather than a browser matrix being encoded and going stale.
- **Force the upload inside our own `try`.** `renderer.texture.bind` immediately after
  `Texture.from`, so any failure is ours to handle and never reaches a frame.
- **Fall back rather than fail.** A PDF whose effects cannot be baked here is drawn exactly
  as pdf.js produced it, which is known to upload. Latched per session.

**The pattern.** A15 was "do not offer what you cannot honour". A16 was "find out what you
can honour first". A17 is the one underneath both: **verify the failure MODE, not just the
failure.** Knowing that WebKit taints was not enough — what mattered was that the taint
surfaced somewhere the module could not catch it, and that was never checked because in
Chromium it never surfaced at all.

### A18 — The prop is a viewport, not a zoom (2026-09-01)

The observation, from the first person to use the module on a real map: resizing a prop
changed nothing about how much of the document it showed. The card was laid out at the
tile's width × height and its type size was derived from the short edge (`short / 26`,
`CardTemplate.baseFontSize`), so a 400×566 prop and an 800×1132 prop held exactly the
same words. Margins were a fraction of the short edge too. A resize was a zoom.

**What changed.** The type size is stored on the pin, in scene pixels (`display.typeSize`),
and margins are stored in em of it (`display.margin`). The card carries no size of its
own: it is `100%` of whatever box it is put in — a `.dp-prop`, the reader, or the SVG's
sized root — so growing the tile shows more lines and shrinking it shows fewer, and the
DOM tier re-lays the card out by CSS alone with no resolve. `cardMetrics` is the one
choke point between the stored fields and every renderer.

**Why the fields are nullable.** A numeric default could not preserve appearance for any
payload that reaches a renderer *before* the migration has written it — a player client
that loads before the primary GM connects, a scene imported from a pack a year from now.
`null` means "derive exactly what the version-1 schema derived", so an unmigrated pin
renders byte-for-byte as it did; the migration's only job is to freeze the number each
prop is already drawn at (`freezeMetrics`), after which the next resize is a change of
window. `convertMode`, `adoptTile` and the Studio freeze on the way in for the same
reason, and a new anchor is born with its numbers in both modes.

**What it revealed.** `DomPropTier.contentKeyOf` omitted geometry on the stated premise
that "a resized prop is re-laid-out by CSS". It was not — the card's pixels were inline —
so a resized DOM prop kept its old card, clipped or short, until an LOD boundary happened
to be crossed. The premise is true now, and the comment finally describes the code. The
reader gate (§6.1 L3) moved from apparent width to apparent *type* size, because
legibility stopped being a property of the box: a small scrap with legible type is
exactly the prop whose clipped tail the reader exists to scroll.

**Overflow is legible.** CSS cannot ask whether its content fit, so the resolver measures
the card in a hidden probe at the width it will be drawn at (`render/measure.ts`) and
marks it; the same number is what "fit to content" writes as the tile's height. The fade
is paper-coloured rather than a transparent mask: at the coarse tier a mask lets the map
show through the card's foot and reads as a torn edge, while a paper gradient reads as
the sheet continuing under a fold. Content, not an effect — the level setting does not
touch it.

**Schema 2 also drops four fields** — `display.showLabel`, `display.labelPosition`,
`interaction.openPage`, `interaction.clickThrough` — that were stored, validated and read
by nothing; `clickThrough` was indistinguishable from `open: "never"` and becomes it, in
the normaliser rather than the migration, so an unmigrated payload already behaves as it
will after. They are dropped on read without a warning: a payload version 1 wrote is not a
stranger's typo.

**The pattern.** A15 was "do not offer what you cannot honour". A18 is its complement:
**do not derive at read time what the user will one day want to set.** A derived value is
a promise that it never needs to be stored; the moment the user wants to hold it still
while something else moves, that promise breaks, and the migration has to reconstruct a
number from the state that happened to be on screen.

### A19 — The GM's layer (2026-09-01)

A13 documented the cost: core only lets a Tile be selected while the Tiles layer is
active — `control()` returns false anywhere else, with no error, no notification and no
cursor change — and the module's own tools live on the Notes layer. A13's answer was a
sign: a toolbar button, a layer switch inside `locate`, and a README paragraph. Three code
paths compensating for one architectural choice, and the most-reported failure in the
changelog kept recurring, because a sign is read once and the failure happens every
session.

**What changed.** `PropHitLayer` builds hit areas for the GM too, on exactly one layer:
Notes. A press on a prop there switches to the Tiles layer and calls `control()` — the one
layer on which it says yes — so the selection frame and handles are core's and the next
press drags. A double click opens the document; a hover fires the tooltip hook, so the GM
can at last see the tooltip the Studio let them write. Nothing on Tiles, where the real
placeable is interactive and a hit area would shadow it; nothing on Tokens, where a
rubber-band select across a prop must keep selecting tokens; nothing while a placement is
armed, because the ghost owns the press then. The layer re-syncs when the scene controls
re-render, which is the signal core gives when the active layer changes. The toolbar
button is gone.

**What core still owns.** Moving and resizing are core's `MouseInteractionManager` on the
active Tiles layer, through core's own handles. This module does not reimplement a drag;
it removes the detour to the layer where core's drag works. A fully module-owned move and
resize on any layer remains possible and remains unbuilt: the press-selects-then-drag
gesture is one extra press, and one extra press is not a detour.

**Verified in the fake, to be watched live.** The hit-layer tests assert the layer rule and
the control call; the actual `activate()` → `control()` sequence on a v14 canvas is the
same one `api.locate` has used since A13, and is on the verification list rather than
assumed.

**The pattern.** A13 signposted a gap. A19 closes it. The difference is who pays: a sign
costs the GM one detour per session forever; closing the gap cost one afternoon once.

### A20 — The document's point is its centre (2026-09-01)

Measured in a live 14.365 world after 0.2.1 shipped: `tile.object.center` equals the
document's `x, y`; `tile.object.bounds` is `{x − w/2, y − h/2, w, h}`; the mesh is
anchored at (0.5, 0.5) at the point and rotates about it. The type definitions shipped
with 14.366 still document `TileDocument.x` as "the top-left corner". The module had
believed the types.

**What it cost.** Every corner the module ever derived from the point — the DOM card, the
reader, the tooltip, the hit polygons, the culling bounds, the token fade, the ping, the
pan target, the line-of-sight test and the `centred` placement in `pinAt` — was half a box
down and right of where core drew the tile. The DOM card and the hit polygon agreed with
each other, which is why 747 tests were green over it: both sides of the bug were tested
against their own inputs and never against a tile as core draws it. The GM saw it as "a
resize handle on a PDF and none on a text prop" (the handle was under the paper) and "a
white book trailing the paper I drag" (core's preview, at the tile's real place).

**What changed.** `tileRect(doc)` in `transform.ts` is the one function that knows; the
rect functions take a rect and say so in their signatures. `checkTileGeometry` asks the
first drawn tile of every scene whether core's `bounds` still agree, and warns if not: the
types were wrong once, and nothing readable at build time will say when the canvas moves
again. The fake tile models the live canvas, with a comment recording that the types
disagree, so every placement test now runs against what core draws.

**Resize keeps the corner.** With the point at the centre, a bare width and height grow a
prop about its middle and slide its first line up over whatever it lay against. The
store's `resize` — fit, reset, the Studio's fields — now moves the point so the local
top-left corner stays put: the way core's grip grows a tile, the way a page fills.
`convertMode` alone keeps the centre, because a pin becoming a prop is a swap of object,
not a growth of one.

**Existing pins move once, so that nothing moves.** A card was placed at the point as its
corner; its visual centre was therefore `(x + w/2, y + h/2)`, whatever the rotation, since
the card turned about its own centre. The version-3 sweep writes that centre back as the
point for every prop that was a card — everything but a PDF, since A10 established that
HTML never reaches a texture — so the paper stays exactly where the GM left it and core's
frame joins it there. A PDF was core's texture on core's mesh, at the point, and stays; so
does a pin-mode icon. The sweep says what it did, once, in a toast. A blanket shift was
rejected: no stored fact distinguishes a card from a texture, so the sweep asks the client
which tier draws each source, which is the same question the manager answers every pass.

**The preview and the frame.** Core's drag clone draws from `_original.texture`, the
placeholder, and the manager never sees a clone: it walks `canvas.tiles.placeables`, and a
preview is in neither that list nor the document collection. `PinnedTile` dresses the
clone — nothing on the DOM path, the original's bound page on the canvas path — and moves
the card with the clone from `_onDragLeftMove`, under the original's id, which the clone
keeps. A clone's draw and destroy are no longer reported to the manager as the original's,
which was a latent way to null the original's binding mid-drag. A controlled card draws
core's ring and grip on itself, in the rectangle core now shares with it; the card is
pointer-transparent, so the press still goes through to core's handle. What core still
owns is unchanged from A19: the drag and the resize are core's; this module only makes
sure the paper is where core thinks the tile is.

### A21 — Firefox was never on the list, and mostly did not need to be (2026-09-02)

§8 justifies having no build step by naming Chromium 144 and listing the features it
supports — one of which, `@container`, is used nowhere in the module. `vite.config.ts`
targets `chrome144`. `grep -i firefox` over the repository returned nothing. So the
module had no stated browser support at all, and the nearest thing to one was wrong.

**What was measured.** Firefox 155.0 and Chrome 152, on the same machine, against a
harness that mounts every shipped preset under the real stylesheet inside a real
scene-transformed overlay (`tests/harness/effects.html`).

| | Firefox 155 | Chrome 152 |
|---|---|---|
| `:has()`, `color-mix`, `allow-discrete`, `content-visibility`, `mask-image` | all supported | all supported |
| `@property` honoured (measured, not inferred) | yes | yes |
| cascade: an unlayered rule beats the module's | yes | yes |
| glow, resolved from `color-mix` in a `box-shadow` | `oklab(0.670948 0.0506901 -0.176063 / 0.55)` | `oklab(0.670934 0.0507187 -0.176046 / 0.55)` |
| torn mask, opaque pixels per row (40 rows of 400) | `0,16,374,371,373,…,362,19` | `0,21,373,371,372,…,364,21` |
| generated `feTurbulence` SVG taints a canvas | no | no |

The two rows that mattered most both came out clean. The glow's `color-mix` with a
`calc()` percentage inside a `box-shadow` colour — the shakiest construct in the
stylesheet — resolves to the same colour in both engines to four decimal places. And the
`feDisplacementMap` edge mask, ranked the likeliest real difference, tracks within about
one per cent per row: the same displacement field, differing only in antialiasing.

**So the support question was a footnote, and four of its rows were wrong.** The real
baseline is Chrome **120** and Firefox **129** — and the Chromium number is not
`@starting-style` as assumed but unprefixed `mask-image`, which is what a torn edge is
made of. `tests/css-baseline.test.ts` now holds both, and fails on any construct nobody
has priced.

**What the audit actually found was five Chromium bugs.** Three selectors were Sass
(`&--left`, `&--right`, `&--missing`) and had never applied in any engine — the HUD's
column layout worked only because the element between them is placed explicitly.
`--dp-motion` was read by no rule while three separate comments described it as the gate
every animation runs through, and the pure-CSS reduced-motion guard it stood for did not
exist. A PDF's inert controls were disabled by `pointer-events: none`, which no engine
applies to a keyboard. And the reader's settle and the HUD palette's fade were primed by a
single `requestAnimationFrame`, which is not a specified moment: the palette animated only
because the `focus()` call on the next line forced a style flush.

**The failure modes are worse than the feature list suggests**, and that is the part worth
carrying forward. `@import … layer()` failing to parse invalidates the whole `@import`, so
the symptom is *no module CSS at all*, not a cascade regression. A `transition` shorthand
is invalidated whole by one component the engine cannot read, so `allow-discrete` was
taking the opacity and the translate down with it. A missing `:has()` did not merely undim
the PDF controls, it re-offered them.

**One finding is left open, deliberately.** The `foreignObject` probe — the same one
`Rasterizer.probeRasterisation` runs — **passed in both engines**: the canvas drew and read
back clean. A10 measured the opposite on Chromium 144 and concluded "every current
browser". Nothing has been changed on the strength of it, and it must not be: this was an
8×8 probe at `file://`, and the real path also uploads through `texImage2D` inside PIXI's
own loop, where A17 showed that *where* an exception is thrown decides what it costs. What
it justifies is re-running the real pipeline in a real world — not switching the tier.

**The pattern.** A10 said there is no substitute for putting the thing on a screen. A21
says the second screen is worth as much as the first, and that most of what it shows you is
not about the second engine at all.

### A22 — A field that means two things is a field neither reader can trust (2026-09-02)

`source.pageId` was a `JournalEntryPage` id to `resolveSource` and a one-based PDF page to
`ContentResolver.pageOf`. The overload survived a year because **nothing ever wrote the
field**: every creation site hardcoded null, so a pinned journal always drew its first page
and a multi-page PDF always drew page 1, and no reader ever disagreed with another. The
moment a GM could set it, "page 4 of the Handouts journal, and that page is a PDF, show its
page 7" became a sentence one field cannot hold.

The fix is a split, and the placement of the legacy fold is the load-bearing decision: it
lives in the **normaliser**, not the migration. This is A18's rule a second time — an
unmigrated payload on a player's client must already behave as it will after — and the cost
of getting it wrong is specific. In the migration, a player who loaded before the primary
GM's sweep would read `pageId: "7"`, miss on `pages.get("7")`, fall back to the entry and
draw page 1, while the GM saw page 7.

The guard is a one-to-five-digit pattern, and that it cannot eat a real id was **measured
rather than assumed**: every `Note#pageId` in the live world is sixteen alphanumerics
(`gfZaflkG2i3TORYw`), which contains digits and is not all digits. That was the only
writer of the field this module did not control, so it was the only place the fold could
have taken something it should not.

**The grant stays on the entry, and that is now measured too.** `syncAnchor` raises
ownership on `source.uuid` — the journal — never on the chosen page, because granting on
the page alone would not put the document in the player's sidebar, which is what the
Studio's own hint promises. That only works if a page with `default: -1` inherits from its
entry, and `canUserOpen` tests the PAGE. In the live world: a page with
`ownership: {default: -1}` and no entry for the user, under an entry with `default: 2`,
answers `testUserPermission(user, "OBSERVER") === true`. It inherits. Had it not, the HUD
would have raised a false "can see it but cannot open it" glyph on every page-chosen pin —
the exact state that glyph exists to prevent.

**The new rule: a verb that RESETS is not the same verb as one that REDIRECTS.** The
picker's `adopt` path builds a fresh `defaultPin()`, and its name says so truthfully.
Wiring "change this pin's document" to it would have wiped the per-player audience — the
one thing §1 says the module exists to control — and silently un-revealed a pin mid-session,
through a code path doing exactly what it was named for. `retarget` moves the source and
the ownership grant that follows it, and nothing else.

Writing it exposed a repair `reconcile` could not make. Its orphan test was "the anchor no
longer exists", which was the same question as "this grant is stale" **only while a pin's
source was immutable**. A retargeted anchor is alive and points elsewhere: it passes the
liveness test, and the old document stays granted to a player forever with no pin anywhere
naming it. That fault class was unreachable before this verb existed, which is why it had
never been looked for — and it is the reason the repair ships in the same commit as the
verb rather than after it.

It also came within one line of a deadlock that nothing would have reported.
`PinStore.enqueue` registers a tracked promise derived from the task it is about to run, so
a task that enqueues on the same anchor id awaits its own completion: no error, no timeout,
the button simply never does anything. Only a test that puts work on the queue *first* can
see it, and there is now one.
