# Documents Pinner — Design

**Status:** Beta. §11 criteria 2, 3 and 4 are UNREACHABLE — see amendment A10
**Target:** Foundry VTT v14, `compatibility: { minimum: "14", verified: "14.365" }`
**Last updated:** 2026-10-01

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

What can be pinned, from the world or from a compendium:

- **A journal, or one of its pages** — the card is the page: text, an image, a PDF page.
- **An Actor** — a wanted poster: its portrait, its name, and one text of its system data
  the GM chooses (a public biography, by default). A reveal grants it Limited at most.
- **An Item** — a found object: its picture, its name and its description.
- **An image file** with no document behind it — a map scrap.

Each kind of document answers for itself through a source adapter (`src/sources/`): how it
is found, what its card holds, which sheet opens it and at what level, where a reveal's
grant lands, which edits redraw it. Handing an item over, or what a Limited actor sheet
shows, stays the game system's business.

### 1.1 Out of scope

- Editing document content from the map. Props are a view; the sheet is the editor.
- Replacing core Map Notes. Native drag-to-canvas keeps making a plain `Note`; we add a
  modified gesture and a one-click "adopt this note" path instead.
- Player-authored pins. Players read; only the GM places and reveals.
- Pinning a RollTable, a Scene or a Macro. Rolling a table from the map needs OWNER,
  which we never grant; a scene and a macro have nothing a card could show.
- Pinning an item an actor owns, or a token's own actor. Their ownership is their
  parent's, so a grant would land on the wrong document; they are refused with a notice.
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
| GM secrets inside a page, or an actor's or item's text | `enrichHTML({ secrets: doc.isOwner })` + post-filter | **content removed** |
| Document appears in the sidebar | ownership ledger (§4) | **server** |
| Writing a pin's configuration | GM only; players never write | **server** |

**Stated plainly, and repeated in the README:** visibility is enforced *at parity with
core Foundry, not above it*. Core enforces `Tile#hidden` and `Note#global` on the
client too. A determined player with a browser console can see a hidden pin's existence
in exactly the same way they can today for any hidden tile.

The one thing that is genuinely removed rather than hidden is a page's `secret`
sections — or an actor's or an item's, in the text its card shows (A28) — because
`enrichHTML` strips them for non-owners before the HTML exists.

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
Where the grant lands, and how high it may go, is the source's adapter's to say: a page
and LIMITED on its journal (A23), an Item at the level asked, an Actor at **LIMITED at
most** (A28). A compendium document grants nothing: its permissions are per role and
pack-wide (A27).

---

## 5. Interaction

### 5.1 Entry points

Native drag-to-canvas is **not** hijacked — it is the most established journal gesture
in Foundry and other modules build on it. `dropCanvasData` acts only with a modifier, and
an Actor's drag is left to core while that modifier is Alt or none: core's Alt-drop of an
actor places a hidden token (A28, D8).

| Rank | Entry point | Hook |
|---|---|---|
| 1 | **Alt-drag** a journal, page or item from the sidebar or a compendium; an actor only with Ctrl or Shift | `dropCanvasData` + `isModifierActive` |
| 2 | Header button on journal, actor and item sheets | `getHeaderControlsApplicationV2` |
| 3 | Two tools in `controls.notes.tools` | `getSceneControlButtons` |
| 4 | Context menus: the journal, actor and item sidebars, compendium windows, a journal sheet's pages | `get*ContextOptions` |
| 5 | *Pin a document* (journals, actors, items; world, then compendiums) and `/pin` | the picker; `chatMessage` |
| 6 | Keybindings | `game.keybindings.register` |

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

Thirteen shipped presets, each a closed declarative parameter object. There is deliberately
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

**Unverified — resolved by `docs/spike-2-sources-probe.js` (A27, A28):** what
`fromUuidSync` returns for a compendium document and page; whether a player can load a
document from a pack their role cannot read; pack permission for another user asked on the
GM's client; the drag payloads of actors and items, and core's Alt-drop of an actor; the
context-menu and header hook names for the actor and item directories and compendium
windows; what a LIMITED actor sheet shows; the `HTMLField` paths a system declares;
`_stats.compendiumSource` on an import. Each is feature-detected in code and listed, with
its guard and its probe section, in A27 and A28.

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
7. On a v14 scene with several Scene Levels, a pin shows on every level for now. Its
   anchor is created with no `levels` and at elevation 0, adopting a Note drops the Note's
   level, and the module's own layers — the DOM tier, the hit layer — are not
   level-aware, so the Pinboard's level filter groups pins by elevation. Making core's
   tile alone level-aware would hide its mesh while the module still drew the card and
   took the click, which is worse than a pin that shows everywhere. Deferred until it is
   checked live on a two-level scene.
8. Anchors are real Tiles and appear in `scene.tiles` to other modules.
9. Deleting the source leaves the anchor showing a placeholder. It is never auto-deleted;
   that would be destructive and unrecoverable.
10. A compendium document shows only to the players whose role can open its pack
    (Observer). Pack permissions are per role and pack-wide, so a reveal grants nothing and
    adds nothing to anyone's sidebar. A player whose role cannot open the pack sees a
    placeholder that says so, and the GM is warned at placement; *Import & pin* makes a
    world copy instead. A pack a player's client was never sent reads as locked there and
    as missing on the GM's screen (A27).
11. Scene padding changes do not move props — core does not reposition placeables either.
12. A future PIXI 8 migration requires rewriting no GLSL: there is none. Every effect is
    CSS applied at rasterisation time or a Canvas2D paint — see A3, where that decision
    was actually taken, and A21, which found three comments still describing shaders that
    were never written.
13. A pin on a whole journal whose FIRST page is a PDF shows a placeholder card rather
    than the page. The journal adapter's `pdf` asks the resolved source's type and that is
    the entry; making the null default fall through would desync four call sites that
    agree by construction today — `PropManager`'s draw, `drawsAsDom`, `migrations`'
    `drawnAsCard` and the Studio's Appearance tab all read `pdfSourceForPin`. Choosing the
    page explicitly is one click and produces exactly the right result.
14. A PDF page from a compendium is always drawn as a card, never into the scene: its
    document arrives asynchronously, and the four paths above must agree before it does.
15. A hidden pin on a compendium the players can open shows the key glyph on every chip
    and counts under the Pinboard's mismatch filter. That is true — they can read it in the
    compendium already — and with core's default pack ownership it is the common case.
16. An Actor is shared at LIMITED at most, and what a LIMITED sheet shows is the game
    system's choice. A new actor pin, or one pointed at an actor, starts with access off.
17. An item an actor owns and a token's own actor cannot be pinned: their ownership is
    their parent's. They are refused with a notice.
18. While the drag modifier is Alt (the default) or none, an actor dragged onto the map
    is core's token, not a pin.
19. A portrait hosted on another origin is dropped wherever a prop is drawn into the scene,
    like any image the inliner cannot fetch; the HTML tier shows it.
20. An actor's or an item's icon pin wears the shared book on the map until the GM gives
    it an icon in the Studio; the Pinboard row and the card show its picture.

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
  const.ts  i18n.ts  api.ts  settings.ts  motion*  fvtt  html*  log  normalise*
  api/        set-audience  ping  reveal-next          (cut out of api.ts, re-exported by it)
  data/       PinData  PinStore  access  audience*  ownership-plan*  ownership-sync
              core-hidden  migrations (planMigration*)  pin-schema*
  canvas/     PinnedTile  PropManager  PropHitLayer  DomPropTier  tile-hooks  user-hooks
              transform  lod*
  render/     ContentResolver  card-cache  enrich  CardTemplate*  AssetInliner  Rasterizer
              TextureCache  BakeEffects  PdfPage  measure
  effects/    EffectRegistry  preset-schema*  preset-css*  preset-library  level
              reveal-sound  typeface*  textures*  presets/*
  apps/       DocumentPicker  PlacementGhost + ghost-model
              PinStudio + pin-studio-markup + edit-holds
              Pinboard + pinboard-markup + pinboard-model*
              PinHUD  PresetStudio  ReaderOverlay  PropTooltip  OverlayRoot  CheatSheet
              chips*  focus-restore  keys
  ui/         controls  keybindings  onboarding  entry-points  cheatsheet*  modifiers
  sources/    index (the adapter registry)  journal  actor  item  portrait  fields
              describe  view  packs  uuid*  search  import  hooks
styles/       documents-pinner.css (entry) + base, card, theme, fx/*, ui/* (focus.css last)
lang/  scripts/  docs/  .github/workflows/
tests/        one file per behaviour; helpers/ holds the fake world (fake-foundry), the
              stylesheets as the CSS-policy tests read them (styles), preset fixtures
```

`*` marks a **pure** module: no Foundry globals, unit-tested under Node. Five are pure in
part, and say where:

- `canvas/transform`'s matrix and rect functions are pure; `stageMatrix`, `screenToScene` and
  `visibleSceneRect` read the canvas.
- `data/migrations` writes documents and asks the GM; its planner, `planMigration`, is pure.
- `sources/fields` has a pure core (the schema walk, the ranking, the field read) behind an
  impure cache.
- `apps/ghost-model` is pure but for one read: `E` steps through the preset library.
- `ui/modifiers` is pure apart from `platform()`, which reads `navigator`.

**An application and the files cut out of it.** `pin-studio-markup`, `edit-holds`,
`pinboard-markup` and `ghost-model` were split from the application written beside them.
The application re-exports every name that moved, so its callers and its tests import from
one place. `effects/reveal-sound` was split from `PropManager` the same way, and
`canvas/tile-hooks` and `canvas/user-hooks` from `main.ts`.

`api.ts` was cut the same way (A29), and is now the verbs and `publicApi()`. What a user may
do with a pin — `canUserSee`, `canUserOpen`, `isRevealed`, the questions the canvas asks of
every prop — is `data/access`: questions, no writes, so the canvas needs none of the verbs
to ask them. Under `api/`: the audience write every visibility verb ends in
(`set-audience`), the one door to a ping (`ping`), and the scene's script (`reveal-next`:
the Pinboard's row facts and Reveal next, a verb that runs with the board closed, which is
why it is not under `apps/`). `api` re-exports every name that moved, and the public API is
the same set of names.

**Nothing under `api/` imports `api.ts`.** `api.ts` re-exports what those files hold, so one
that reached a verb through `api` would close a runtime import cycle. What they need of the
verbs lives beside them: `reveal-next` reveals through `set-audience` and points through
`ping`, as the façade's own verbs do.

**The import rule of `sources/`.** `sources/*` imports nothing the suite mocks with a
partial factory: `api`, `data/ownership-sync`, `render/ContentResolver`, `apps/*` and
`canvas/*` (A28). `sources/view` holds what the module asks about a pin's source — the
source a drop makes, the document a pin shows, its page and field choices, what a reveal
shares, its label — and `api` re-exports it. `ContentResolver` reads it there, not through
`api`, so the module has no runtime import cycle.

**Layering edges kept on purpose.** `canvas/*` imports `apps/OverlayRoot` (canvas
infrastructure in all but its path, which two tests mock), `apps/PinHUD`,
`apps/ReaderOverlay` and `apps/PlacementGhost`. `data/PinStore` and `data/migrations`
import `canvas/transform` for its pure geometry, and `api/reveal-next` imports
`apps/pinboard-model` for the board's pure list logic, which Reveal next plays.

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

### A23 — The grant follows the page the pin shows (2026-09-30)

A22 kept the grant on the entry so that the journal would reach the player's sidebar, and
measured that a page inherits from it. Both halves were right, and together they were the
fault: **every page inherits**, so a pin showing page 3 of "Chapter 3 — GM notes" granted
the whole chapter, and the sidebar access outlives the pin by design. A GM revealing one
letter handed over the adventure.

`grantTargets` now decides where a grant lands, and every writer and the `ready` sweep ask
it. The page the pin shows gets the level its audience asks for; its journal gets
**LIMITED**, which lists the journal in the sidebar and lets its sheet open, and opens no
text page that inherits (§4). A pin on a whole journal still shares the whole journal, and
the Studio's Audience tab now says which of the two a reveal will do. A chosen page that
has since been deleted grants nothing, rather than falling back to the journal.

Three consequences worth stating:

- **A pin's grants span a family**, the journal and its pages, so releasing one walks the
  family, and a retarget passes the old uuid INTO the sync rather than releasing after it.
  Re-pointing a pin from a journal to one of its own pages puts both documents in one
  family, and a release after the sync took back the grant it had just made.
- **Choosing another page is an ownership change.** `patchAndSync` re-synced only on an
  audience patch, so the grant stayed on the page the pin no longer showed.
- **Worlds already hold the old grants.** `reconcile` narrows any holder recorded above
  the level its target now asks for, once, on the primary GM's `ready`, and says how many.

**Unverified, and the first thing to check in a live world:** that on 14.365 a player
with LIMITED on an entry and OBSERVER on one of its pages sees the entry in the sidebar and
can open that page from the sidebar and from a pin; and whether an IMAGE page inheriting
LIMITED is shown to them. §4 measured text pages only. If image pages show at LIMITED, the
journal's listing leaks its images and the entry needs NONE plus a different route to the
sidebar.

### A25 — A reveal cannot be taken back (2026-09-30)

§5.3 and the Pinboard's own header treated reveal and hide as "one keystroke to undo", so
neither asked. The audit's S3 shows where that led. Every bulk path wrote `everyone`, so a note
narrowed to the rogue, hidden for a beat and caught by "Reveal all", appeared to the whole
table. Hiding it again took the pin off the map. It did not take the letter out of the players'
heads.

**One reveal rule.** `audience.revealed` returns the audience the pin remembers, or everyone
when it remembers nobody usable. It is idempotent: an audience that is not hidden comes back
equal. The eye's toggle now calls it, and so does every other reveal: the bulk bar,
"Reveal all", Reveal next, spotlight and the Studio's resume. Each used to decide for itself,
and one of them decided wrong. The bulk paths still land as one scene write, and they now skip
the pins the gesture does not change.

**§5.3 is amended.** A row's reveal and hide still ask nothing, because a dialog in the middle
of a scene is worse than the slip it prevents. "Reveal all" has left the footer, where it sat
one button from "Hide all". It is now in the bulk bar and asks first when it would show more
than one pin to at least one player (`audience.wouldReveal`). It acts only on `=== true`. A
dialog closed with its ✕ resolves `null`, and a build with no DialogV2 refuses rather than act
unasked. It is greyed out when no row is hidden, the same fact Reveal next reads; the count that
decides whether it asks is still taken on the click. A write that fails is said
(`DP.board.revealAllFailed`) rather than left in the console while the table watches.

**The script plays.** The Pinboard has always called its order the reveal order, and nothing
read it. `pinboard-model.nextToReveal` picks the first **hidden** row under the board's filter,
search and level. That means hidden, not "not visible": a selection naming nobody is not visible
and not hidden either, so it is stepped past. Revealing it would reveal it to the same nobody,
and `N` would stop on it forever. The verb reveals with `revealed`, never with the eye's toggle,
because a toggle on a row that is already showing hides it, and pressing `N` twice would take
back the clue it had just given.

- `N` ignores a held key's repeats and any Ctrl, ⌘ or Alt, and stops the event there.
- The `revealNext` keybinding is registered restricted and **unbound**. It runs the open
  board's own path when the board is open, so the status line, the focus and the filter follow.
  With the board closed it runs over the whole scene.
- While one Reveal next is in flight, a second press joins it rather than racing it. Two presses
  can therefore reveal one clue and never two by accident. For an action that cannot be taken
  back, that is the right way to fail.

**A ping reaches every client, and the keyboard used to decide what it did.** Core's
`canvas.ping` merges the caller's options over a base it builds from the keyboard: a held Shift
means "pull every view here", a held Alt means "alert". The Pinboard's `Shift+Space` is exactly
a Shift held while pinging.

Every ping now goes through one door, `pingAt` in `api.ts`, and it always states `pull` and
`style`. It pings nothing for a pin on another scene, because those coordinates on the viewed
map point at nothing. It also applies core's scene-rect check.

The local path, `ControlsLayer#handlePing`, now passes the viewed scene's id. The 14.366 types
say core draws nothing without it. So the flash of a hidden pin, which passed `{}`, was very
likely a silent no-op on every v14 world.

What each verb does with a ping:

- **Spotlight** reveals, then pulls every view only for an audience of everyone.
- **A narrower audience** gets a pulse on the GM's screen and a notice saying why nobody moved:
  a pull reaches every player, and would walk the rest of the table to where the private clue
  lies.
- **Reveal next** never pulls, and pulses on the players' maps only for an everyone pin.
- **Flash** keeps its documented reach: a visible pin pulses on every client, as its label
  says, until a socket can narrow it. §8's "no sockets" still stands.

The test double's first `handlePing` checked the scene id loosely. With no id on either side it
drew anyway, which is precisely the bug it was there to catch; the tests caught it only because
they set an id by hand. It now refuses a missing id outright. This is A11's lesson again: a fake
more permissive than the real thing tests nothing at the point where it differs.

**The HUD keeps to the verbs of the moment.** The left column holds the eye, the audience and
spotlight. The right column holds effect, shape, open for me, flash and Pin Studio. Lock and Fit
were prep and layout verbs and have gone to the Studio's strip, where both already were; Fit is
still `Alt+Shift+F`. E2 added a ninth button, `?`, last in the right column and in the roving
order. It is the only extension of K10.

**The Studio says when the table is watching.** Every Studio control saves as it moves, so on a
revealed prop the players watched each paper and effect the GM tried. A banner above the tabs
now says "Visible to N player(s) — changes are live" and offers *Hide while I edit*.

The hold is `{anchor, world, restore}` in the client setting `editHolds`. It is written
**before** the hide. A reload between the two writes finds the pin still showing and drops the
hold. The other order could have left the pin hidden with nothing to bring it back.

The hold ends in three places — on close, on *Reveal again*, and in a `ready` sweep after a
reload — and each reveals the pin again through `audience.resumeAfterEdit`. A GM who never comes
back leaves the pin hidden with its `restore` intact: one `Space` from where it was.

**The resume rule was right about state and blind to history, and review found it.**
`resumeAfterEdit` reveals again only while the pin is hidden and still remembers the audience the
hold remembered. That is the right test for a pin the GM changed since. It misses a pin the GM
revealed and then hid again: hiding restores the same memory, so the state is identical to the
one the hold left. Closing the Studio then showed the letter to the players the GM had just
hidden it from.

The rule is now stronger. **Once the pin has been visible again since the hold, the hold is
dropped everywhere.** The Studio ends the hold on the first render that sees the pin showing, and
every audience change reaches an open Studio as a render. The setting's entry goes with it, so
neither the close nor the `ready` sweep can replay it. The general lesson: **a rule that compares
two states cannot see what happened between them.** When the history matters, something has to
be watching while it happens.

Accepted, and said here so nobody rediscovers them:

- A resumed pin replays its reveal moment on the players' screens — the arrival, and the sound
  if it has one. A quiet resume needs a channel to the players.
- "Hide all" over a pin that a Studio holds writes nothing, because the pin is already hidden,
  and closing that Studio still reveals it. The banner says *Hidden while you edit — Reveal
  again* for as long as that is true.

**E2 — the keys say themselves.** The three live surfaces had about twenty-five shortcuts between
them. The ghost's E, V, R and F and the board's L, O, M and F have no Configure Controls entry to
find them by. The only surface that taught itself was the ghost's legend, which a GM can switch
off, and R was not even on it.

`?` now puts up one popover for whichever surface asked: the ghost, the Pinboard or the HUD.

- **Where it lives.** It is a labelled dialog in `body`, so a Pinboard re-render cannot take it
  away. It sits one step below core's tooltip layer (`--z-index-tooltip`, falling back to
  10000), which puts it above every window while its ✕ can still show a tooltip.
- **Focus.** It takes the focus when it opens and gives it back when it closes.
- **Closing.** It closes on `?`, on its ✕, on a click anywhere else and on Escape. Escape takes
  the sheet down before the surface's own Escape runs, so the placement, the selection and the
  pin all survive the dismissal. That Escape is stopped as well as prevented — inside the sheet
  and on the board and the HUD that took it down — so core's window-level dismiss does not also
  see it. That core's listener sits where stopping it works is on the live list. The sheet also
  goes with its surface: the ghost's disarm, the Pinboard's close and the HUD's hide each take
  it down.
- **How it is opened.** The ghost's legend gains one entry, "? all keys", and the sheet answers
  `?` with the legend switched off too. The Pinboard's header and the HUD each gain a `?` button.
  Any `?` button is the toggle, not the one that opened it: both surfaces rebuild their markup on
  every render, and a sheet opened from the keyboard has no opener, so matching by identity made
  the press close the sheet and the click open it again.

**What a sheet lists is data.** Each surface has one pure table in `ui/cheatsheet.ts`, built
into markup by one pure builder. The handlers do not read the tables. `tests/cheatsheet.test.ts`
is what holds the two together. On all three surfaces it presses every key a table lists, and
every key a keyboard has with and without each modifier: the ghost through `stepKey`, the board
and the HUD through their real listeners. It fails when a table and its handler disagree in
either direction.

That was chosen over one source driving both. Each handler has its own conditions: the typing
guard, the repeat guard, a modifier the handler ignores. A shared source would have to turn all
of them into a dispatch language inside the table. A test that presses keys checks the behaviour
itself. The pointer rows (wheel, click, right-drag, the chips) are beyond its reach and are kept
by hand.

**How keys are named.** A surface's own keys go through `modifierGlyphs(platform())`, so a Mac
shows ⌘.

A Configure Controls action is listed by its action name only. Its keys are read from
`game.keybindings.get` as the sheet opens and named by `bindingName`.

- `bindingName` now lives beside the sheet in `apps/CheatSheet.ts` and is re-exported from
  `keybindings.ts`. Without the move there would be an import cycle: `keybindings.ts` imports
  the surfaces, and the surfaces import the sheet.
- A rebound key shows as rebound, and *Reveal next* shows as not set.
- A binding that cannot be read says "see Configure Controls". The sheet never prints a default
  the binding may no longer have. The read is guarded because core throws for an action it does
  not know.

Each action sits on the sheet of the surface it serves:

- the ghost: *Pin the last document used*;
- the Pinboard: *Open the Pinboard* and *Reveal next*;
- the HUD: the audience cycle, the shape, *Fit* and *Peek*.

`cancel` is the one action left off. It is the ghost's own Escape, and the ghost's sheet lists it
there as a key. A GM who also binds `cancel` to a second key will not see that key on the sheet.

**Text fields keep `?`.** A `?` typed into the chat box or the board's search stays text: the
ghost and the HUD now use the board's text-entry test, `isTextEntry`.

**The HUD's own Escape is unchanged.** With no sheet and no palette open, it releases the pin and
prevents nothing, as it did before E2.

**The fake follows core.** The test double's `game.keybindings` gains `get` and `set`, modelled
on core. `get` returns the registered `editable` until a rebind, and throws for an action nobody
registered. It throws because core is recalled to throw there, and a fake that answered
`undefined` would hide the guard's whole reason for existing.

**Follow-ups, not done:**

- A quiet resume, once a socket exists.
- The bulk path computes its audience patch before taking the write queue. This is
  pre-existing. `batchUpdate` should take a function of the current payload.
- `readPin` validates on every `canUserSee`, and the banner and chips call it per player.
- The armed ghost still takes E, V, R, F and Space from a focused text field. This is
  pre-existing: E2 guards only `?`. Every key but Escape should pass the `isTextEntry` test.
- The sheet does not show an extra key bound to `cancel`.

**Unverified, and on the live list below:**

- That `canvas.ping` honours `{ pull, style }` (the merge is recalled core, not typed).
- That a pull moves a player on the same scene and nobody on another.
- That `handlePing` draws with `scene` and not without it.
- That an unbound binding shows in Configure Controls with an empty slot.
- That DialogV2's ✕ resolves `null`.
- That v14 client settings are one store per browser across worlds, which the hold's `world`
  field assumes.
- That `ClientKeybindings#get` throws for an action it does not know. Core is recalled here; the
  types give only the return value.
- How `KeyboardManager.getKeycodeDisplayString` names a binding, modifiers included, on a Mac and
  elsewhere.
- That the sheet stays above every window, and that `--z-index-tooltip` exists in v14 (the
  fallback is 10000).
- That stopping Escape inside the sheet keeps core's dismiss from closing windows, releasing the
  pin or opening the main menu.

### A26 — The look reaches the table (2026-09-30)

§6 said a DOM card is not lit, not fogged and not occluded. A10 made the DOM tier the only one
HTML reaches, and it is still true of per-light illumination and fog, which are fragment-shader
work over the primary group. But the scene's **global** darkness is one number, and leaving it
out meant a sheet of bright paper floating over every night scene.

**A text prop darkens with the room.** `DomPropTier.syncSceneDim` reads
`canvas.environment.darknessLevel` on `canvasReady` and on `initializeCanvasEnvironment`. That
hook fires at the end of the environment's own initialisation, which is where core applies a
darkness change. The code never reads `canvas.darknessLevel`, which throws before
initialisation. `lightingRefresh` is not the signal: it fires on every light-carrying token step.

`sceneBrightness` maps the level to `1 − 0.65·d`, quantised to twentieths, with a floor of
`DARKEST_CARD` (0.35). A full transition therefore costs at most 21 property writes, whatever
the hook cadence. The value is written once per step as `--dp-scene-dim` on the overlay root,
with the memo reset whenever the overlay goes with its scene.

`.dp-prop` hands the value to its card as `--dp-card-dim`, and it is the last step of the card's
existing filter chain. It is deliberately kept off these places:

- **Not on `.dp-prop` itself.** The arrival animates that element's `filter`, and reduced motion
  clears it; either would erase the dimming.
- **Not on the reader, the ghost or the gallery swatches.** Those are interface.
- **Not in `card.css`.** The rasteriser inlines that file, and the canvas tier is lit by core.

**One stock opts out: `projection`.** It is emitted light, not paper, and a projected readout
does not dim with the room. Darkness is in no content key and no texture key: a darkness change
is one property on one element and re-resolves nothing.

The Audience tab now says, on every prop that is not a PDF and whatever its audience, that it
shows through unexplored fog: *reveal it when they reach it.* It says so before the reveal,
because that is when the advice can be used. It asks nothing of `drawsAsDom`, which answers for
the GM's client rather than the players'.

**A typeface and a reveal sound are strangers' strings.** §7 kept one place where a preset string
reaches CSS, `safeUrl`. These are two more, and each gets the same treatment: one way in, one way
out.

- **Typeface.** `typeface.fontFamily` validates the name in both normalisers. It accepts a
  generic family, or letters, digits, spaces and `_ . ' -`: nothing that can end a quoted CSS
  string. `fontStack` is the only formatter. It re-checks the name, quotes it and puts it in
  front of the house stack, so a face missing on one client falls back to Signika rather than to
  the browser's default serif.
- **Sound.** `normalise.soundPath` refuses any scheme, `https:` included: a shared preset must
  not be a beacon reporting the table's reveals to its author. It also refuses a leading `//` or
  `\\` (after stripping the control characters a URL parser would) and over-long paths. It runs
  in the preset normaliser, in the pin normaliser, and again at the moment of play.

**The typeface is not an effect.** The dressing drops every effect variable at effects level
`off` and at the silhouette rung. A face carried there would change a ransom note's lettering
when a player switched effects off, and re-flow the card as the GM zoomed out. So the card
carries the face on its own style, resolved as the pin's own, else the preset's, else the house
face. It joins both cache keys.

*Fit to content* now loads the face before it measures. `document.fonts.ready` waits only for
loads already in flight, and nothing starts one for a face nothing has used yet. The load is
bounded at 1.5 s — A16's decode lesson, since this runs inside `resolveCard`.

The six shipped presets that call for a face use **generic families only**: CRT Scanlines,
Projected Readout, Tagged and Signal Loss are monospace; Aged Parchment and Sealed & Wax are
serif. No world needs a font installed, and the harness draws them at `file://`.

**The audit was wrong about Font Config, and the types said so.** A GM's own faces live in core's
`fonts` setting, not in `CONFIG.fontDefinitions`, which `FontConfig._collectDefinitions` merges
with it. The inliner now reads both, and the picker lists from the same source, so the canvas
tier can draw whatever the picker offers. Every defined face is inlined once per session. A world
that added fonts pays for them in every canvas-tier SVG, and inlining only the faces in use is
the follow-up.

**The reveal sound plays on each player's own screen, when the prop arrives there.** It is
played:

- on the `environment` channel, with no volume of its own, so it follows each player's slider;
- not while the browser has yet to unlock audio, where core would queue it to burst out at the
  first click;
- once per distinct sound per LOD pass, so seven sealed letters revealed together crack one seal;
- for props only, because only a prop has an arrival.

The GM's client never sees a prop "appear", so the GM hears it through ▶ in either Studio. A
pin's own sound lives in `effect.revealSound`, not in `effect.params`. That map caps strings at
128 characters, and v14 expands a dotted key inside a flag into an object the normaliser then
drops as non-scalar.

**Schema.** The pin payload goes from 4 to 5 (`display.font`, `effect.revealSound`) and presets
from 2 to 3 (`params.type`). In both, the normaliser supplies the null defaults, so an unmigrated
payload on a player's client already draws and sounds as a migrated one (A18, A22).

The rule behind the bump, written down because it was argued: `planMigration` rewrites every pin
whose stored form differs from its validated form. Any new default-bearing field therefore
rewrites the world whether or not the number moves. So adding a field is what bumps the version,
exactly once per release, and nothing else does.

Two costs are accepted. After a downgrade, an older primary GM's sweep strips both pin fields,
and pins fall back to their preset's face and sound. A version 3 preset imported into an older
install warns that it is newer and loses its face.

**The pattern.** A15 said not to offer what cannot be honoured, and A16 said to find out first
what can be. This amendment is the third turn of the same idea. The DOM tier gave up everything
the canvas gives for free, and that was treated as all-or-nothing when one of those things was a
single number. Worth asking of every limitation this document lists: is it one mechanism, or
several that were lost together?

**Follow-ups:**

- A face added in Font Config mid-session reaches the canvas tier only after a reload (the DOM
  tier draws it at once).
- Inline only the fonts in use.
- Editing a user preset does not invalidate the props already drawn with it. This is
  pre-existing, and now covers its face too.

**Unverified, and on the live list below:**

- How often `initializeCanvasEnvironment` fires during an animated darkness transition. If it
  fires only at the end, add `lightingRefresh` behind the same O(1) check.
- The right value of `DARKEST_CARD`.
- That the `environment` channel follows the Environment slider, and what happens while locked.
- That a Font Config face appears in `getAvailableFonts()` and not in CONFIG.
- That FilePicker `type: "audio"` lists only audio, and that an S3 pick returns an `https://` URL
  (which is then refused, by design).
- That each `<option>` is drawn in its own face in the select's popup.

### A27 — A compendium document is read from its pack, not from core's cache (2026-09-30)

§10 limitation 10 said a compendium grants nothing per player, and stopped there. That was
true, and it was the least of it. A pin on a compendium document could always be made — an
Alt-drop from a compendium window made one — and almost nothing about it was right afterwards.

**`fromUuidSync` has three answers for one uuid.** `fvtt.ts` said "compendia return null".
The 14.366 types say otherwise, and the code has to assume the worst of them:

- For a compendium document, core returns the pack's **index entry**: a plain object with an
  `_id`, a `uuid` and a `name`, and nothing else — no `id`, no `documentName`, no `pages`, no
  methods.
- For the five minutes after anything loaded the document, it returns the **Document**. Drawing
  a card loads it.
- For a page of a compendium journal, it **throws** unless the journal is cached, and
  `resolveUuidSync` turns the throw into null.

Sixteen call sites read whatever came back. On the GM's client a pin on a compendium page was
labelled "Pin", with an icon that read as missing, until its card was drawn; then it had its own
name for five minutes, and "Pin" again after that. The chips raised no key on a prop the
players could not open and a false key on a pin they could. The Audience tab said a reveal
"shares the whole journal", which a compendium cannot do, and then said nothing. A compendium
PDF page was a card, then a texture, then a card. Pin Studio said "No source" for a valid
compendium page and listed no pages for a compendium journal. "Pin to scene" in a compendium
window did nothing, and nor did it on a page inside a compendium journal's sheet: the window
fires the journal sidebar's hook, and the row's id was looked up in `game.journal`. That is
A9's unwired entry again. Both now ask the application that fired the hook — the window's
collection, the sheet's journal — before the world.

**One interpreter.** `sources/describe.ts` is the only reader of that seam, and it never asks
`fromUuidSync` about a compendium uuid. A compendium source is described from its uuid
(`sources/uuid.ts`, pure) and its pack's index alone, so no cache can flip an answer.

- A page, which the index does not list, is named by its journal until `api.resolveSource` has
  actually loaded it, and by its own name from then on. The memo goes one way, from unknown to
  known, and never reads core's cache.
- The summary carries the name, the crumb ("Handouts › Letters"), the icon, the thumbnail and
  the PDF answer, and every former call site reads it.
- `pdfSourceForPin` is the one PDF answer behind `PropManager`'s draw, `drawsAsDom`, the
  Studio's Appearance tab and the migration's `drawnAsCard`. It is null for every compendium
  source: a compendium PDF page is always drawn as a card, on every client, and its PDF page
  can still be chosen. Limitation 13 still holds for world journals.
- The grep audit after the change: `resolveUuidSync` is called by `describe.ts` for world uuids,
  by `reconcile` (correct for every shape, since an index entry has no `update`) and by the edit
  hold's anchor lookup, which is not a source.

**Who can read a pack is a role question, and the GM's client can answer it.** "Compendium
content ignores the ownership field in favor of User role-based ownership" (TYPES,
`document.d.mts:342-358`), and roles are user data, so `sources/packs.ts` asks the pack about
any user from any client: `testUserPermission(user, "OBSERVER")`, else `getUserLevel(user)`,
else the ownership record read by hand. An answer that cannot be had is "cannot read": that
mistake costs a warning, the other one a blank. A GM always reads — the pack schema fixes the
GAMEMASTER role at OWNER. "The players can read it" means **every** current player: a pack
open to trusted players only is not one the table reads. That answer drives:

- **the key glyph**, for an icon and a prop alike, because a player who cannot load the document
  sees a placeholder wherever a world journal would read in place. The other half holds too,
  deliberately: a HIDDEN pin on a pack the players can read shows "can open it but cannot see
  it" on every chip and counts under the mismatch filter, as a world journal the player holds
  does. With core's default pack ownership (Player: Observer) that is the common case, and a GM
  staging hidden handouts from a compendium will see the filter fill. The index entry's shape
  used to hide it by accident; a test pins it now (limitation 15);
- **a warning to the GM**, naming the pack, after placing, retargeting or adopting a tile onto a
  pack that leaves a player out;
- ***Show to players now***, which reaches only the players who can read the pack and says when
  that leaves someone out;
- **the picker's greyed rows**, below.

**A player is never sent a request their role will be refused.** `packLockedHere` asks the role
first, on the player's own client. A locked pack is not loaded: the card is a placeholder titled
for what it is (`ResolvedCard.reason: "packLocked"`), and the reader and an icon's open say "in
a compendium your GM has not opened to you", never "no longer exists". What core does with a
refused load is unmeasured, and a card is resolved again at every LOD pass, so the module does
not find out. Revealing or deleting a compendium pin no longer loads the document from the
server only to learn that a pack grants nothing.

**The picker searches compendiums, and imports what the table cannot open.** From two folded
letters, *Pin a document* and `/pin` search every pack after the world (A28 widens this to
every kind of document): packs in title order, at most fifty rows, the rest counted. They read
the index core already holds and never ask the server per keystroke; an empty index is asked for
once per session, and the open picker searches again when it arrives. Folded names are cached
per entry with the name they were folded from, because core may merge a rename into the existing
entry rather than replace it. Entries only: a compendium journal's page is chosen afterwards in
Pin Studio, which loads the journal to list its pages and count a PDF's.

A row from a pack some player cannot read is greyed, and its primary action is **Import & pin**:

- The import is `WorldCollection#importFromCompendium`. `CompendiumCollection#importDocument`
  goes the other way, into a pack — and the chapter's prompt had named it.
- The copy goes into a "Documents Pinner" folder of its type, found by a flag so the GM may
  rename it, and the copy is what is armed, adopted or retargeted to.
- The copy starts with core's cleared ownership, so importing widens nothing; the pin's own
  audience shares it, like any world document.
- It is found again by `_stats.compendiumSource`, or by the module's own `importedFrom` flag — a
  uuid VALUE, never a key — so the same letter chosen twice pins the first copy.
- While the copy is being made the row is busy and a second Enter does nothing. An import that
  fails says so and arms nothing.

`/pin` arms a readable pack's match, and opens the picker on the query when only a locked pack
matches. The Alt-drop and the compendium window's menu still reference a locked pack directly:
that is the expert route, and it carries the placement warning.

**What the owner decided.** D1: a pack is referenced when every current player can read it,
decided on the GM's client; otherwise the picker's primary action is *Import & pin*, and a
player's client never asks the server for a pack its role cannot read. D5: compendiums are
searched from two characters, and the kind chips arrived with A28.

**What did not change.** Packs grant nothing, and pack ownership is never written. The ledger,
`grantTargets` and `reconcile` behave exactly as before for every compendium shape.

**Accepted, and said here so nobody rediscovers them:**

- A pack a player's client was never sent counts as LOCKED there — the placeholder, no request —
  and as MISSING on the GM's screen, which is sent every pack. When a pack's module is disabled,
  one pin reads "locked" on one screen and "missing" on the other. For a player, "not sent to
  me" and "not mine to read" cannot be told apart without asking the server, which is the one
  thing the rule forbids.
- A renamed compendium page keeps its old name in labels until it next loads.
- There is no fallback when `importFromCompendium` is absent: the import fails closed, with a
  notice, rather than referencing what the table cannot open.
- The source summary has no `embedded` field: refusing owned and token documents is the
  adapters' job (A28).

**Unverified, and how each is guarded.** Nothing above about core's runtime is measured. The
probe is `docs/spike-2-sources-probe.js`; its sections are named in the last column.

| Assumption | Guard in code | Probe |
|---|---|---|
| `fromUuidSync` returns the index entry for a pack document, the Document while cached (300 s), and throws for an uncached page | `describeSource` never calls it for a pack, so its shape does not matter | A3, B1, B2, B4, B5 |
| The pack index is precomputed and sent to every client | an empty index is asked for once, then searched again | A1, A3 |
| A player cannot load from a pack below OBSERVER (null? a throw? an error toast?) and can at OBSERVER | the role is asked first; null and a throw are both handled | C1 |
| A player's client holds a pack hidden from them in `game.packs` at all | a pack this client does not hold counts as locked for a player | C2 |
| `getUserLevel` / `testUserPermission` for another user on the GM's client equal that player's own answer | the key glyph, the warning and the greyed row rest on it | A2 against each player's A1 |
| `getIndex({fields: ["pages.*"]})` returns page stubs | not relied on: a page is named once loaded | B8 |
| A renamed compendium document's index entry is merged in place | the folded-name cache checks the name on every read | live, step 13 |
| `importFromCompendium` honours `folder` in its update data and sets `_stats.compendiumSource` | the module's own `importedFrom` flag finds the copy too | `importOne` |
| `Journal.show` of a compendium document opens for a player who can read the pack | the recipients are narrowed to readers | `showPack` |
| A compendium window fires `getJournalEntryContextOptions` with `app.collection` the pack, and its rows carry `data-entry-id` | every candidate hook is registered; `data-uuid`, then the collection, then the sheet's journal, then the world | `recordHooks` |

### A28 — The source adapter, and the actor and the item it lets in (2026-10-01)

Every question the module asked of a pin's source was answered for a journal, in place,
wherever it was asked. `ContentResolver` switched on a page's `type`; `ownership-sync` knew that
a page has a journal; `api` knew that a page opens inside its journal's sheet. An Actor's `type`
is a system subtype — `npc`, `weapon` — so the switch would have drawn a wanted poster as an
unknown page, blank; a reveal would have granted OBSERVER on an NPC's whole sheet; and the key
glyph would have asked for a level no actor sheet needs.

**One adapter per kind of document.** `src/sources/index.ts` is a registry keyed by
`documentName`. Each adapter answers what the rest of the module used to answer for a journal:
how a drop or a document becomes a source, or is refused; what the card shows of the named
document; its name, crumb, icon and thumbnail; its PDF, if it is one; the markup the card is
enriched from, and a figure above it; the parts a GM may choose between; where a reveal's grant
lands and how high it may go; the family a grant can sit in; the sheet that opens it and the
level that sheet asks for; whether core's `Journal.show` can put it on a screen; whether a new
pin on it starts with access on; whether it can be a source at all; and whether an edit to it
redraws a card. `resolveCard` asks the adapter **before** anything reads `type`.

- The journal adapter is the old behaviour moved, not rewritten, in a commit of its own
  (`da9c2f8`) with the whole suite passing unchanged and nothing under `tests/` touched.
- A document of no registered type is read as a journal, which is what every source was
  before: a pin an API caller pointed at a Scene draws exactly as it did.
- `ownership-sync` keeps `grantTargets` as a one-line delegate; tests import it and mock it.
- **The import rule.** `sources/*` imports nothing a test mocks with a partial factory (`api`,
  `data/ownership-sync`, `render/ContentResolver`, `apps/*`, `canvas/*`): every arrow points
  into `sources/`. So the update handler (`sources/hooks.ts`) is handed its four effects by
  `main.ts`; `fold` moved to `normalise.ts`; `sources/portrait.ts` reads the viewed scene's pins
  through `data/PinData.rawPinFlag`, a leaf no test mocks.

**The portrait card (D6).** An actor's or an item's card is the shell every card uses, with a
figure above the title: the picture, the name, the chosen text. The layout is derived from the
source and exposed as `data-dp-layout="portrait"`; nothing is stored, so papers, effects,
typefaces and Fit to content are untouched.

- **The picture** is the document's `img` unless that is a default; else, for an actor, the
  prototype token's texture unless that is a default too; else none. The defaults are the
  class's `DEFAULT_ICON`, `CONST.DEFAULT_TOKEN` and whatever `getDefaultArtwork({type})`
  returns, cached per type — asked with the type alone, since `toObject()` would copy an actor's
  data on every label read.
- **Its markup** is built from the path with `escapeHtml` and passed through `sanitise`, the
  treatment an image page's `<img>` gets: a `javascript:` path comes out with no `src`.
- **Its box is sized by the stylesheet**, 9em square, so Fit to content measures the card right
  before the picture decodes (A16, A26). It goes through the inliner like any `<img>`, so a
  portrait on another origin is dropped wherever a prop is drawn into the scene (limitation 19).

**Which text (D4).** `src/sources/fields.ts` walks the type's data model —
`CONFIG[doc].dataModels[type].schema`, else the instance's — into schema fields, embedded data
models included, and records HTML fields; it skips arrays, typed schemas and free objects, and
stops at eight levels. A template.json system with no data model offers the string leaves of
`game.model` whose path ranks. Labels are the model's own, localised, else the path made
readable ("Details › Biography › Public"). Discovery is cached per `documentName:type`; a pack
document needs no load, since its `type` is in the index. The probe's section E is the same walk
and the same ranking, and the two must stay in agreement.

- **The automatic choice** is public, then biograph, then description, then notes — and never a
  path with a segment that STARTS with `gm`, `private` or `secret` (`gm`, `gmNotes`,
  `privateNotes`, `secretNotes`). pf2e's `description.gm` is a whole field of GM text that no
  `.secret` section marks, which is why the name rule exists. It is a prefix rather than a list
  of names because a name the rule misses reaches the table, while a player-facing field that
  happens to start so is only left out of the automatic choice, and can still be chosen.
- **The GM's choice is `source.field`**, a dotted path under `system`, null meaning the automatic
  choice. It joins schema 5, which is unreleased, and the normaliser supplies the null.
- **The path is validated twice:** for its shape when the pin is read (eight identifiers, 128
  characters, no `__proto__`, `prototype` or `constructor`; anything else becomes null with a
  warning), and for membership in what the type declares when the card is drawn. The read walks
  `system` by hand and refuses those segments a third time.
- **Both cache keys carry the field**, beside the page and the PDF page.
- **A retarget names the field outright.** `retarget` writes the new source as a patch that
  `mergePin` deep-merges, and the picker, the menus, `/pin` and *Import & pin* build sources
  that do not name `field`. The old choice survived: a path chosen for one NPC read the next
  NPC's private biography, past the never-automatic rule, because a stored choice is taken as
  explicit. The write is now `{ ...source, field: source.field ?? null }`. This is A22's lesson a
  second time: a verb that REDIRECTS must reset what belonged to the old document.

**What a reveal grants (D2).**

- **The cap.** `grantTargets` grants an Actor **LIMITED at most**, for `default` and per-player
  keys alike, whatever the pin's level. OBSERVER would open an NPC's whole sheet, stat block
  included, and very likely share its tokens' sight.
- **Access starts off.** A new actor pin, from `pinAt` or `adoptTile`, starts with ownership sync
  off whatever the world setting says. The poster reads in place without any grant (§3.1), so a
  grant only lists the actor in sidebars, and the GM opts in pin by pin. A pin retargeted onto an
  actor from a kind that starts with access on has it switched off in the same write, and the GM
  is told once: switching off never widens anything. A pin already on an actor keeps the GM's
  choice.
- **The Audience tab** offers Limited alone for an actor and says that what a Limited sheet shows
  is the game system's choice. An Item takes the level asked, like a journal.
- **The key glyph** asks the level the sheet needs, the adapter's `openLevel`: LIMITED for an
  actor or an item (core's sheets' `viewPermission`), OBSERVER for a journal as before. The
  player's "not yet" uses the same level. An icon opens the sheet.

**What is refused (D3).** An item an actor owns, and a token's own actor. The uuid parse decides
— any embedded pair, or a root type that is not the document's — and `parent`/`isToken` are a
second check on loaded documents. A drop of one says so and returns `false`, since the gesture
was ours; the sheet header is not offered; their grants are empty, and their update hooks are
nothing to a pin.

**The drop (D8).** Core's Alt-drop of an actor places a hidden token, and Alt is this module's
default modifier, so an actor drop is taken only when the modifier is **Ctrl or Shift**. Under
"no modifier" it is left to core too: taking it would turn every token drag into a pin for the
GMs who chose "none" before actors were pinnable. Items take the modifier drop as journals do.
The setting's hint says all of it.

***Show to players*.** `Journal.show` resolves without showing anything for a document that is
not a journal. On an actor's or an item's row the Pinboard no longer offers it; `Shift+S` and
the API, which cannot hide a choice, say it opens journals only. Nothing is claimed as shown.

**Roll data.** An actor's or an item's text is enriched with the document's own
`getRollData()`, as its sheet would be. A system's derived data can throw on a player's client,
so the call is guarded and a throw reads as no roll data: the card still draws.

**Edits (P5).** `update<Document>` is wired from `hookedDocumentNames()` to one handler. An
embedded document returns at once; the ledger is rebased only when `ownership` is in the change,
and a label follows only when `name` is. A card is redrawn only when the adapter says the change
reaches it: for a journal, any change, as before; for an actor or an item, its name, its
pictures, its ownership, this module's flags, or the very field a pin on the viewed scene shows.
A hit point lost in combat no longer re-enriches and re-rasterises a wanted poster.

**Entry points.** "Pin to scene" is in the actor and item directories' context menus, the
sidebar's and a compendium window's alike, and in an actor's or an item's sheet header for the
GM. *Pin a document* has chips — All · Journals · Actors · Items; images stay the footer's
Browse button — and lists the world's actors and items after its journals, then every kind of
compendium. *Import & pin* copies an actor or an item into a "Documents Pinner" folder of its own
type. `/pin` takes the first match: journals, then actors, then items, then compendiums.

**What the owner decided.** D2: actors capped at LIMITED, and their pins start with access off;
items may take OBSERVER. D3: owned and token documents refused, with a notice. D4: system-agnostic
discovery with the ranked default above, null meaning automatic, and a template.json fallback.
D5: the four chips, with images left on the Browse button. D6: the portrait card, derived, in the
same shell. D7: RollTables, Scenes and Macros stay out (§1.1). D8: no actor drop while the
modifier is Alt.

**Accepted, and said here so nobody rediscovers them:**

- `DpSource.field` is optional in the type, so a source built for the ghost need not name one.
  Every stored payload has it, and the one writer that merges a source, `retarget`, names it.
- The adapter interface is not the brief's: the page and field choices are synchronous (a pack's
  index carries the `type` that decides the fields), and `maxGrant`, `syncOnCreate`, `isSource`,
  `redrawsOn`, `shown` and `pdf` were added.
- The ledger rebase and the rename follow every update without the scene filter, behind their
  own `ownership` and `name` guards, so a hit-point change costs two key reads.
- `DP.notice.showJournalsOnly` is a new key: `showUnavailable` is about a build with no
  `Journal.show`.
- No header button on AppV1 sheets: `getApplicationV1HeaderButtons` is not registered. A system
  whose actor sheets are AppV1 still reaches its actors through the menus, the picker and `/pin`.
- An actor's or an item's icon pin wears the shared book on the map (limitation 20).

**Follow-ups, not done:**

- Register `getApplicationV1HeaderButtons` if the probe shows the world's system uses AppV1
  sheets.
- Create an actor's or an item's anchor with its portrait as the tile's texture, same-origin only.
- `uuidFromContextTarget`'s last fallback searches world journals only: a context target with no
  collection behind it — the legacy `…DirectoryEntryContext` shape, which v14 does not fire —
  resolves no actor or item.

**Unverified, and how each is guarded.** Probe sections as in A27.

| Assumption | Guard in code | Probe |
|---|---|---|
| Actor and Item drags carry `{type, uuid}` from the sidebar and from a compendium, and an owned item's uuid is embedded (`Actor.a.Item.i`) | an unknown type falls through to core; an embedded uuid is refused | `armDrop` |
| Core's Alt-drop of an actor places a hidden token | D8: actors are taken only with Ctrl or Shift | the probe's manual step |
| `dropCanvasData` returning `false` suppresses core for an Item or Actor drop (§9 item 3) | unchanged | `armDrop` |
| `getActorContextOptions` and `getItemContextOptions` fire in the sidebar and in compendium windows, with `app.collection` the pack | every candidate name is registered; a name that never fires costs nothing | `recordHooks` |
| The system's actor and item sheets are AppV2 and fire `getHeaderControlsApplicationV2` | the guard is on `app.document`; an AppV1 sheet gets no button | `recordHooks`, G1, G2 |
| The world's actor and item sheet classes ask LIMITED (`viewPermission`) | the adapters' `openLevel` | G1, G2 |
| What a LIMITED actor sheet shows, and whether a LIMITED actor is listed in a player's sidebar | access starts off for an actor; the Audience tab says it is the system's choice | `limitedSheet`, D2 |
| OBSERVER on an actor shares its tokens' sight | the cap: never above LIMITED | live, step 14 |
| A player's client holds world actors at NONE, so a poster reads in place without a grant | premise of the access-off default; otherwise the GM switches access on, capped | D1 |
| The HTML field paths and labels discovered for the world's types, and that the automatic one is player-safe | the ranked default and the never-automatic segments; the Studio names what "Automatic" reads | E |
| A system's rich-text fields are `instanceof foundry.data.fields.HTMLField`, and `system` values are readable by property path on a live model | no field found → the card is the portrait and the name; `readField` returns "" for anything not a string | E, E.instance |
| `updateActor`'s change is a nested diff for a hit-point change, a rename and a biography edit; owned items fire `updateItem` with a `parent` | the filter reads nested and dotted keys and treats an operator as a whole-subtree change; a `parent` returns at once | `watchUpdates` |
| Default artwork: `DEFAULT_ICON`, `getDefaultArtwork({type})`, the prototype token's texture | core's literal defaults as well; an override that throws on a bare type is caught | F1, F2 |
| `isOwner` on a client is OWNER for that user, so an actor's secrets reach its owners and the GM alone | `enrichFor` strips for anyone else, and the content hash carries `isOwner` | live, step 14 |
| `enrichHTML` with the actor's roll data evaluates a biography's inline rolls as its sheet would | none needed | live, step 14 |
| A cross-origin portrait is dropped on the canvas tier and shown on the HTML tier | limitation 19 | live, on a world with an asset host |

---

### Live verification checklist for 14.365 — one sitting (A23, A25, A26, A27, A28)

Run this in Chromium as GM, with two players: Ali in Chromium and Ben in Firefox, each in their
own browser profile. Use a fresh world that has pins from 0.3.3, so the format-5 migration runs.
Record each answer as observed and fold the results into A24; fold the answers to steps 11–20
into A27's and A28's tables of what is unverified. Use a **test world**: steps 11–20 import
documents, make folders and change ownership.

**Setup** (about ten minutes):

- A scene with a darkness slider, a token for each player, one light, and unexplored fog.
- On that scene:
  - a text prop for everyone, hidden;
  - a text prop for Ali only, hidden;
  - a revealed text prop on the `projection` paper (Projected Readout);
  - a revealed PDF prop.
- A second scene with one pin.
- An `.ogg` file in the world's data folder.
- A face added in Font Config.
- A second world available in the same browser.
- For steps 11–20 (about twenty minutes more), in a world whose system has data models for its
  actors and items (dnd5e or pf2e are the cases the ranking was written against):
  - a world JournalEntry compendium, *Handouts*, holding a journal *Letters* with two text pages
    and a PDF page, and a second journal;
  - an Actor compendium, *Bestiary*, holding one NPC, and an Item compendium, *Loot*, holding
    one item;
  - a world NPC, *Black Jack*, with a portrait, a public biography holding a
    `<section class="secret">` and an inline roll (`[[/r 1d20 + 2]]`), a private biography, hit
    points, and a token on the scene; a second NPC of the same type, *Rook*; a world item with a
    description (on pf2e, one with a GM description too);
  - `docs/spike-2-sources-probe.js` at hand, to paste into each browser's console.

0. **Page grants (A23).** Make a journal with three pages — text, text, image — every page at
   its default ownership, and the journal at None. Pin page 2 with access granted, and reveal it
   to Ali. As Ali: the journal is in the sidebar; page 2 opens from the sidebar and from the
   pin; page 1 is not listed; and note whether the image page (page 3) is shown. If it is, A23's
   LIMITED listing leaks images, and the entry needs another route to the sidebar.
1. **Migration.** Open the scene. Its pins update silently. The other scene is offered once, and a
   reload offers nothing more.
2. **Where pings land** (GM on scene 1; Ali on scene 1; Ben on scene 2, then back to scene 1):
   - **Spotlight the everyone prop** from the HUD. Ali's view glides to it and Ben's (on scene 2)
     does not move. With Ben back on scene 1, spotlight again: his view moves too.
   - **Spotlight the prop for Ali** with `Shift+Space` in the Pinboard. It is revealed to Ali, and
     nobody's view moves. The pulse shows on the GM's screen only; ask Ben whether he saw any ring.
   - **Hold Shift and flash** a revealed pin. Nobody is pulled.
   - **Hide a pin and flash it.** A ring appears on the GM's screen only. (Before this cycle,
     expected: nothing at all.)
3. **Reveal next.**
   - Hide three pins in a known order and press `N` three times. They reveal in order, each to
     its remembered audience. The footer names the next one, and the fourth press says there is
     nothing left.
   - Hold `N`: one reveal only.
   - Open Configure Controls. *Reveal the next hidden pin* is listed with an empty slot. Bind it
     and press it with the board closed, then open: the board's status line updates.
4. **Reveal all.** With two or more pins hidden, the dialog names the count. Close it with ✕:
   nothing is revealed. Answer yes: each pin goes to its own audience.
5. **Hide while I edit.**
   - Open the Studio on a revealed prop. The banner counts the players; click *Hide while I edit*.
   - Reload the GM's browser. After `ready`, the pin is back, to the same players, with a notice.
   - Hold again, reveal the pin with the eye, hide it with the eye, then close the Studio. It
     **stays hidden**.
   - Hold again and close: it comes back.
   - Place a hold, then open the second world in the same browser. Its sweep does nothing, and the
     first world's hold is still there on return.
6. **Darkness.** Watch `--dp-scene-dim` on `#documents-pinner-overlay` in devtools.
   - Load the scene: a value is set.
   - Move the darkness slider: it follows.
   - Trigger an animated transition. Count the writes: expect up to 21 if the hook fires per tick,
     1 if only at the end. With 1, add `lightingRefresh`.
   - The reader, the ghost and the projection prop do not dim. The PDF prop dims through core, not
     twice.
   - At darkness 1, judge whether 0.35 still reads as "a letter in the dark", and tune
     `DARKEST_CARD`.
7. **Typeface.**
   - In the console, `getAvailableFonts()` lists the Font Config face and
     `CONFIG.fontDefinitions` does not.
   - The Studio's picker lists it, each option in its own face (check the popup in Chromium and
     Firefox).
   - Set a prop to that face: both players see it.
   - Set a prop to monospace and use *Fit to content* at once: the last line is not clipped.
   - Switch a player's effects level to off: the face stays.
8. **Reveal sound.**
   - Browse in the Preset Studio: the picker lists audio only. If an S3 source exists, pick from
     it: expect a warning and nothing stored.
   - Give a user preset the `.ogg` and put it on two hidden props. Reveal both with Reveal all:
     each player hears it **once**, at their Environment slider's volume (lower Ali's and compare).
   - Reload Ben, reveal without him clicking anywhere, then click: no late burst.
   - The GM hears it only through ▶.
9. **Keys** (GM, with the Pinboard and one Pin Studio open):
   - In the console, `game.keybindings.get("documents-pinner", "nope")` throws, and
     `game.keybindings.get("documents-pinner", "revealNext")` returns `[]`.
   - In Configure Controls, rebind *Open the Pinboard* to `Shift+B`. Press `?` on the board: the
     row reads as core names the key (expect `Shift+B`; on a Mac, note how Control and Alt are
     named). *Reveal next* reads "not set".
   - Click the Studio, then the Pinboard, then the Studio again, so each takes a turn on top.
     Then press `?` on the board. The sheet is above both windows.
   - With the sheet up and the focus inside it, press Escape. Only the sheet goes: the Pinboard
     and the Studio stay open, and the main menu does not open. Repeat on the HUD of a
     controlled pin: the sheet goes and the pin stays controlled. Repeat while placing: the
     sheet goes and the ghost stays armed.
   - Arm a pin, click into the chat box and type `?`: it is typed, and no sheet opens.
   - Two questions about behaviour that predates E2, which decide whether the surfaces' own
     Escape paths need `stopPropagation`:
     - In the Pinboard's search, type a word and press Escape. Does the search clear while the
       Pinboard stays open?
     - On a focused HUD button with no palette open, press Escape. Is the pin released, with no
       window closing and the main menu staying shut?
10. **Browser second opinion.** Repeat steps 2, 6, 8 and 9 from Ben's Firefox for anything that
    differed. Step 9 needs a GM, so promote Ben, or run it as GM in Firefox.
11. **The probe** (A27, A28). Paste `docs/spike-2-sources-probe.js` into the GM's console, then
    Ali's, then Ben's, and keep each report. It answers, by section: what `fromUuidSync` returns
    for a compendium document and page, before and after a load (A3, B1–B8); every pack's level
    for every player, as the GM's client sees it (A2) and as each player's does (A1); whether a
    player's client loads from a pack below Observer, at Limited and at Observer, and whether it
    raises a toast (C1, C2 — set the three levels on three packs first); which world actors a
    player's client holds (D1); the HTML fields and the automatic choice for every actor and item
    type (E); the default artwork (F); the sheet classes and the level each asks (G). Then, as
    the report's footer lists:
    - `__dpProbe2.recordHooks()`, and right-click a journal, an actor and an item in the sidebar
      and in a compendium window of each kind, and open each kind of sheet: the context-menu and
      header hook names, and each menu's target;
    - `__dpProbe2.armDrop(4)`, and drag an actor and an item from the sidebar, then from a
      compendium: the payloads (nothing is created while it is armed);
    - `__dpProbe2.watchUpdates()`, and change *Black Jack*'s hit points, rename him, edit his
      public biography and an item he owns: the shape of each change;
    - as Ali, with *Black Jack* set to Limited for her by hand,
      `__dpProbe2.limitedSheet("Actor.<id>")`, then look at the sheet and note what it shows,
      and whether he is in her Actors sidebar (D2);
    - as GM, opt-in: `__dpProbe2.importOne(uuid, { iUnderstand: true })` on a *Handouts* journal
      (`_stats.compendiumSource` on the copy; it deletes the copy and its folder), and
      `__dpProbe2.showPack(uuid, "<Ali's id>", { iUnderstand: true })` with *Handouts* readable
      and then not;
    - with the module disabled and no recorder armed, Alt-drop *Black Jack* on the map: is the
      token hidden? Delete it.
12. **A compendium the players can read** (A27). *Handouts* at Observer for the Player role.
    - In *Pin a document*, type `l`: no compendium rows. Type `le`: *Letters · Handouts* is listed
      after the world's rows, not greyed. Pin it.
    - In Pin Studio's Content tab the source reads *Letters*, "From the compendium “Handouts”",
      and the page select lists its pages. Choose the PDF page: the PDF page field appears with
      the right count, and on the map it is a card, not a texture.
    - Reload the GM's browser and open the Pinboard before anything draws. Note the row's name,
      crumb and icon, then wait for the card: nothing changes, except that the page's own name
      replaces the journal's once it has loaded.
    - Reveal it to Ali: she reads it on the map and in the reader, her chip carries no key, and
      nothing is added to her sidebar. Hide it again: her chip now carries the key (limitation 15).
13. **A compendium the players cannot read** (A27). *Handouts* at None for Player and Observer for
    Trusted, and Ben made Trusted.
    - In the picker *Letters* is greyed and reads *Import & pin*. Choose it: a "Documents Pinner"
      journal folder appears holding a copy, and the ghost carries the copy. Place it and reveal
      it with access on: Ali reads it and finds it in her sidebar. Choose it again: no second copy.
      Rename the folder and import the second journal: it goes into the renamed folder.
    - Alt-drop *Letters* from the compendium window: one warning, naming *Handouts*. Reveal it to
      both players: Ali sees a placeholder saying the document is in a compendium she cannot
      open, with no error toast and no request for it in her network tab; Ben reads it. Ali's
      chip carries the key and Ben's does not.
    - *Show to players now* from the Pinboard: only Ben gets the window, and the GM is told Ali
      was left out.
    - Right-click *Letters* in the compendium window, *Pin to scene*: the ghost arms it. Open
      *Letters* and right-click one of its pages in the sheet: the ghost arms that page.
    - `/pin letters`: the picker opens on that search with the greyed row. Set Player back to
      Observer and `/pin letters` again: the ghost arms the compendium journal.
    - Unlock *Handouts*, rename *Letters* to *Missives*, and search `missi` without reloading: it
      is found. Put Ben back to Player.
14. **The wanted poster** (A28). Pin *Black Jack* as a prop from his context menu, then his sheet
    header, then *Pin a document* with the Actors chip, then `/pin jack`. Each time: the
    portrait, the name and the public biography, and *Text shown* opens on "Automatic —" and the
    field's name.
    - Reveal it to Ali with access off, the default for an actor: she reads the poster without
      the secret, the inline roll shows a total, and *Black Jack* is **not** in her sidebar.
    - Switch access on: the Audience tab offers Limited alone, and Ali now has him listed at
      Limited. Note what the system's Limited sheet shows.
    - Make Ben his owner: Ben's poster shows the secret. The GM's shows it too.
    - The cap's reason, once, by hand: give Ali Observer on *Black Jack* in core's own ownership
      dialog and look through her eyes. Does she see through his token? Put it back.
15. **Drops** (A28). With the modifier on Alt, Alt-drag *Black Jack*: core's hidden token, no pin.
    Set the modifier to Ctrl and Ctrl-drag him: a pin. Alt-drag the world item and the *Loot*
    item: a pin each. Drag an item off a character's sheet with the modifier held: one notice,
    nothing placed. Put the modifier back to Alt.
16. **Retarget** (A28). On a poster whose *Text shown* is *Black Jack*'s private biography, choose
    *Rook* from the Studio: the poster shows Rook's public text, and *Text shown* reads
    "Automatic". Retarget a journal pin with access on onto *Rook*: one notice, access off, and
    Rook is in nobody's sidebar.
17. **Combat** (A28). Put *Black Jack*'s token in combat and change his hit points several times:
    the poster does not redraw (watch its DOM card's node in devtools). Edit his public biography:
    it redraws. Edit his private biography: it does not.
18. **An item** (A28). Pin the world item. "Automatic" names the players' description, never a
    GM one. Choose another field and check the card. *Show to players* is not in its Pinboard row
    menu, and `Shift+S` on the row says it opens journals only.
19. **A compendium actor** (A27, A28). Search `bestiary` with the Actors chip. With the Player
    role at None on *Bestiary*, the row is greyed; *Import & pin* makes an Actor folder
    "Documents Pinner" holding the copy and pins it with access off. With Observer, the reference
    is pinned and Ali reads the poster.
20. **Browser second opinion.** Repeat steps 12, 13 and 14 from Ben's Firefox for anything that
    differed.
21. **A pin from 0.1.x migrates once** (the whole-payload write). Open a world holding pins
    placed by 0.1.x — one of them set to click through — on scenes not opened since, and accept
    the offer to update them.
    - Reload: the offer does not come back, that session or the next, and the console logs no
      second migration of the same pins.
    - On the pin that clicked through, set *Opening* to *Double-click* in Pin Studio and
      reload: it is still *Double-click*, not back to *Not interactive*.
22. **Hide and show a pin with core's own controls** (the hidden fold). Reveal a prop to Ali alone,
    then hide it with the eye of core's Tiles HUD, on the Tiles layer.
    - It leaves Ali's map. The module's HUD eye offers to reveal it, its chips and the Pinboard
      row say hidden, and an unrelated edit in its Studio — a paper — leaves it hidden.
    - Show it with core's eye again: it comes back to Ali alone, not to Ben, with its access as
      before. Hide it with *Hidden* in Tile Config, then Ctrl+Z: the same, both ways.
