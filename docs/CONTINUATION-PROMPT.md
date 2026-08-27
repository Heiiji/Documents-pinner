# Continuation prompt — documents-pinner

*Paste everything below the line into a fresh Claude Code session started in
`/Users/julien/Documents/FoundryModules/documents-pinner`.*

---

You are a senior Foundry VTT module engineer finishing a module that is already
architected, scaffolded and partly built. Your job is to take it to a polished,
release-quality v1.0.0. Read this whole brief before touching anything.

## 0. Ground rules for this engagement

- **The architecture is decided. Do not relitigate it.** §3 lists the locked decisions
  and *why*. If you believe one is wrong, say so in one paragraph, then proceed as
  specified unless I overrule it.
- **Verify, don't assume.** Every claim about the Foundry v14 API in §4 was checked.
  Everything in §5 was NOT — resolve those first, empirically, before writing code that
  depends on them. Never hardcode an API name you have not confirmed exists.
- **Work in verifiable increments.** After each component: `npm test`, `npm run lint`,
  `npm run build`. Add unit tests for every pure module you write. Never report
  something as working that you have not run.
- **Match the existing code's voice.** Read `src/data/ownership-plan.ts` and
  `src/data/audience.ts` first: file-header comments explain *why* the module exists and
  what invariants it holds; inline comments explain non-obvious decisions, never restate
  the code. Follow that density exactly. Do not add comments to self-evident lines.
- **Never over-claim.** Especially about security (§7.2). The README's honesty about
  enforcement parity with core is deliberate and must survive.
- Commit with Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`,
  `chore:`). Do not push without asking.

---

## 1. The product

A GM takes a document — a letter, a rumour, a warrant, a hand-drawn map scrap — and puts
it **on the map**, not in a window.

- **Pin mode** — a small icon on the scene; players click to open the document.
- **Prop mode** — the document lies on the map at full size and is **readable in place**,
  e.g. a letter dropped on a table.

Three requirements drive everything:

1. **Visibility is the GM's to control and trivial to change mid-session.** Core Foundry
   ties Map Note visibility to the linked journal's *permissions*, which is exactly the
   wrong coupling for "reveal the letter the moment they find it".
2. **Subtle, immersive per-pin effects** — glitch, out-of-focus, holographic frame, aged
   parchment, and friends.
3. A modern stack capable of carrying those effects.

The target experience, as the acceptance test: *a GM alt-drags a journal page onto the
scene, a ghost of the actual letter follows the cursor, the wheel rotates it, space
toggles pin↔prop, a click places it. It is invisible to players until the GM clicks one
eye icon — and when it appears, it is a parchment lying on the table, darkened by the
room's lighting, hidden by the fog they have not explored, and behind the token standing
on it.*

Sources may be: `JournalEntry`, `JournalEntryPage`, and **any image or video file** from
the file browser (a map scrap with no journal behind it). `Actor` / `Item` / `RollTable`
are a later adapter, not v1.

---

## 2. Current repository state

**Read these first, in this order:** `docs/DESIGN.md` (the full spec, numbered sections),
`src/const.ts`, `src/types/dp.d.ts`, `src/data/ownership-plan.ts`, `src/data/audience.ts`.

### Built, tested and green — 116 unit tests, lint clean, typecheck clean, build works

| File | Lines | Purpose |
|---|---|---|
| `src/const.ts` | 74 | `MODULE_ID`, `FLAGS`, `INTERNAL_OPTION`, `OWNERSHIP`, `DELETE_PREFIX`, `LOD`, `RES_TIERS`, `DEFAULTS` |
| `src/types/dp.d.ts` | 111 | `DpPinFlags`, `DpSource`, `DpDisplay`, `DpAudience`, `DpEffectRef`, `DpInteraction`, `DpGrantLedger`, `DpNotice` |
| `src/data/audience.ts` | 207 | **PURE.** `canSee`, `shouldRecordDiscovery`, `grantKeysFor`, `anchorHidden`, `toggleVisibility`, `setUserVisible`, `soloUser`, `cycleAudience`, `describeAudience`, `makeAudience` |
| `src/data/ownership-plan.ts` | 256 | **PURE.** `planGrant`, `planRelease`, `planRebase`, `planRetarget`, `keysHeldBy`, `emptyLedger` |
| `src/canvas/transform.ts` | 171 | **PURE core** + thin Foundry wrappers. `applyMat`, `invertMat`, `scaleOf`, `rotationOf`, `sameMat`, `toCssMatrix`, `viewportRect`, `rectsIntersect`, `rotatedBounds`, `screenPlacement`, `apparentWidth`, `stageMatrix`, `sceneToScreen`, `screenToScene`, `visibleSceneRect` |
| `src/effects/preset-schema.ts` | 358 | **PURE.** `DpPreset`/`DpPresetParams`, `defaultPreset`, `validatePreset`, `estimateCost`, `withComputedCost` |
| `src/effects/preset-css.ts` | 147 | **PURE.** `presetToCssVars`, `presetToDataAttrs`, `reduceCssVars`, `disabledCssVars`, `safeUrl` |
| `src/effects/presets/core-presets.ts` | 180 | The ten shipped presets, frozen |
| `src/i18n.ts`, `src/main.ts` | 74 | `t()`/`tn()`; entry point (hook wiring only, currently just exposes the pure API) |
| `styles/*` | 150 | `documents-pinner.css` entry + `base.css`, `theme.css`, `fx/_props.css` |
| `lang/en.json`, `lang/fr.json` | 66 | Flat dotted `DP.*` keys, key-for-key parallel |
| `tests/*.test.ts` | 1183 | 116 tests across 7 files |
| `.github/workflows/{ci,release}.yml` | 156 | CI + tag-driven release with Foundry registry publish |
| `docs/spike-0-probe.js` | 169 | The in-world probe for §5 |

### NOT built — this is your work

Everything Foundry-facing. See §6 for the ordered build plan.

### Commands

```bash
npm test          # 116 tests, must stay green
npm run lint      # ESLint 9 flat config, must stay at 0 problems
npm run typecheck # advisory only — NEVER let it block the build
npm run build     # vite -> dist/documents-pinner.mjs (unminified + sourcemap)
npm run watch     # rebuild on change
```

Dev loop: symlink the repo into `Data/modules/documents-pinner`, `npm run watch`, `F5` in
Foundry. **CSS is not part of the build** — stylesheet edits need no rebuild.

Git remote is configured: `git@github.com:Heiiji/Documents-pinner.git`, branch `main`.

---

## 3. Locked architectural decisions

### 3.1 One `TileDocument` per pin — both modes, one anchor

Modules cannot define new embedded Document types in a Scene, so a placeable must
piggyback on an existing type plus flags. `Tile` was chosen over `Note` and `Drawing`:

- **Only `Tile` has the full superset**: `width`/`height`/`rotation`/`alpha`/`hidden`/
  `locked`/`elevation`/`sort`/`texture`, plus v14 shape handles, `TileHUD`, and the v14
  Placeables sidebar tab.
- **Mode switching is one atomic `Tile#update`.** A split Note/Tile design needs
  delete + create: non-atomic, changes the `_id` and every UUID referencing it, and
  breaks core undo. Lossless mode switching is a stated requirement.
- **`Note#isVisible` / `_canView` consult the journal's ownership**, so a Note literally
  cannot be shown to a player who lacks permission. That kills requirement #1.
- **A `Tile` is already a `PrimarySpriteMesh` in `canvas.primary`**, which is exactly
  where the prop must render (§3.2).
- `BaseNote` has **no** `hidden`, `width`, `height` or `rotation`, and there is **no**
  `NoteHUD` in `foundry.applications.hud`.

Two costs, both already solved in the design:
- The Tiles layer is GM-only → a module-owned `CanvasLayer` in group `interface` carries
  invisible hit areas so players can hover/click props.
- Native sidebar drag makes a `Note` → we do not hijack it (§8.1); instead we offer
  Alt-drag plus a one-click "adopt this note" path in `renderNoteConfig`.

### 3.2 Prop content renders in the primary canvas group, not the DOM

Prop content is rasterised **on each client** (enriched HTML → SVG `foreignObject` →
`OffscreenCanvas` → `PIXI.Texture`) and bound to the Tile's own `PrimarySpriteMesh`.

Living in `canvas.primary` buys, for free: darkness tinting, per-light illumination, the
vision/fog mask, roof occlusion, and correct z-order against tokens. **A DOM card
floating unlit over a dark dungeon is the single most immersion-breaking artefact this
module could ship**, and CSS cannot fix it — per-light illumination is a fragment-shader
operation over the primary group.

Per-client rasterisation also means `enrichHTML({ secrets: page.isOwner })` yields
per-user content, so GM secrets stay secret. That is impossible with a shared image.

**The DOM is the focus tier only.** Clicking a prop dims the mesh and fades in a live
HTML reader: selectable text, working `@UUID` links, live inline rolls. This bounds DOM
cost to 1–3 elements and turns the out-of-focus preset from a gimmick into the module's
signature affordance — unfocused props are soft, focusing sharpens them.

Keep a **DOM rendering mode** as a user-selectable fallback (`Rendering: Canvas
(recommended) / DOM (compatibility)`) for WebKit and low-VRAM clients.

### 3.3 Visibility is decoupled from ownership; ownership sync is an optional layer

`Journal.show(doc, { force, users })` displays a document "regardless of normal
permission", and `Journal._showEntry(uuid, force)` takes only a UUID and resolves it on
the receiving client — so clients already hold world-document data. Ownership sync
therefore exists so a revealed journal also lands in the player's sidebar and persists,
**not** because it is required to show content.

The ledger (`src/data/ownership-plan.ts`) is written and tested. Its three invariants:
1. Never lower a level that was already higher.
2. A deliberate GM edit always wins — on release, restore the baseline *only if* the
   value we wrote is still present; otherwise leave it, drop our bookkeeping, notify.
3. Releasing every holder restores the exact prior state, **deleting** a key that did not
   exist before rather than writing a spurious `NONE`.

Required level is **OBSERVER (2)** for both modes. At LIMITED a text page will not open
and is not even listed in the journal sheet; LIMITED is exposed as a deliberate "tease".

### 3.4 Stack

Vite + TypeScript, single unminified ESM output with sourcemaps. Plain CSS with
`@layer` + native nesting + `@property` — no preprocessor, because Foundry v14 is
Electron 40 / Chromium 144 where all of it is native. **Type-checking is deliberately
decoupled from the build** (esbuild strips types without checking) because Foundry v14
type definitions are immature — no stable release exists for any Foundry generation. A
types regression must never block a release.

No sockets. No libWrapper. No monkey-patching. No dependencies.

---

## 4. Verified v14 API facts — rely on these

- v14 is GA; **14.365** is v14 Stable 7 (July 2026). Manifest targets
  `{ minimum: "14", verified: "14" }`, no `maximum`.
- `Journal.show(doc, { force, users })` — `force` displays "regardless of normal
  permission". `Journal._showEntry(uuid, force)` takes only a UUID.
- `getSceneControlButtons(controls)` receives a **Record keyed by control name**, not an
  array. Tools are also a record:
  `controls.notes.tools.myTool = { name, title, icon, order, button, visible, onChange }`.
  **A tool with neither `onChange` nor `onClick` throws in core.** Use
  `order: Object.keys(controls.notes.tools).length`.
- `CONFIG.Canvas.layers[name] = { layerClass, group }` is usable by modules. Groups
  include `primary`, `effects`, `visibility`, `environment`, `interface`, `overlay`,
  `rendered`. (Sequencer does exactly this and is verified on v14.)
- `PrimaryCanvasGroup.SORT_LAYERS = { SCENE: 0, TILES: 500, DRAWINGS: 600, TOKENS: 700,
  WEATHER: 1000 }`.
- v14 added `PrimaryCanvasObject#inPrimary`, `PrimaryCanvasContainer#sortLayer`,
  elevation auto-propagation to children, FADE occlusion inside containers,
  `PrimaryCanvasGroup#objects`, `Tile#name`, `Tile#levels`, `ApplicationV2#detachWindow`,
  `ApplicationV2#_refit`, and a Placeables sidebar tab.
- v14 changed the Tile mesh position to equal the `TileDocument` (x,y) and added
  Anchor X/Y to the Tile config.
- `canvasPan(canvas, view)` fires **every tick** during an animated pan — never do
  expensive work there.
- `canvas.visibility.testVisibility(point, { tolerance, object })` exists.
- All core UI is ApplicationV2; no jQuery by default.
  `foundry.applications.api.{ApplicationV2, HandlebarsApplicationMixin, DialogV2}`,
  `foundry.applications.apps.FilePicker.implementation`,
  `foundry.applications.ux.TextEditor.implementation.enrichHTML`,
  `foundry.applications.ux.ContextMenu`,
  `foundry.applications.handlebars.renderTemplate`,
  `foundry.applications.hud.{BasePlaceableHUD, TileHUD, HeadsUpDisplayContainer}`.
- `HeadsUpDisplayContainer` is an ApplicationV2 with
  `DEFAULT_OPTIONS.position.zIndex === 100` and `window: {frame:false, positioned:false}`.
  There is **no** documented extension point for adding HUD parts — mount your own
  overlay instead.
- v14 **deprecated** the `-=` / `==` special operation keys in favour of
  `DataFieldOperator`. `-=` still works; it is isolated in `DELETE_PREFIX` in
  `src/const.ts` for a one-line migration.
- `CONST.DOCUMENT_OWNERSHIP_LEVELS = { INHERIT:-1, NONE:0, LIMITED:1, OBSERVER:2, OWNER:3 }`.
- `canvas.ping(origin, options)` displays both locally and on other connected clients —
  no socket needed for the "flash" action.

---

## 5. UNVERIFIED — resolve these FIRST

**Your first action is to run `docs/spike-0-probe.js`.** Ask me to paste it into the
Foundry console (v14, GM, scene active) and give you the report. It is read-only apart
from one temporary tile it deletes in a `finally`. Do not write code that depends on
these until you have the answers.

1. **`PIXI.VERSION` in v14.** Assumed **7** (the v8 migration was explicitly deferred
   during v13 as too breaking for the module ecosystem). If it is 8, all GLSL moves from
   ES 1.0 (`attribute`/`varying`/`texture2D`) to ES 3.0 (`in`/`out`/`texture`). Nothing
   else in the design changes.
2. **`PrimarySpriteMesh#setShaderClass()`** accepting a custom `PrimaryBaseSamplerShader`
   subclass while keeping `renderDepthData()` and occlusion intact. **Highest
   uncertainty in the project.** Fallback if it fails: `PIXI.Filter` with an explicit
   `filter.resolution` — this breaks batching and caps animated props at ~12, so the LOD
   budget must tighten accordingly. Resolve on a throwaway branch before committing to
   the shader path.
3. **`dropCanvasData` returning `false`** suppressing core's default Note creation. The
   v14 docs give `(canvas, data, event) => void` and do not state it. If it does not
   cancel, the Alt-drag entry point must instead let the Note be created and immediately
   convert it, or use a different gesture.
4. **`Tile#isVisible` overrides propagating to `mesh.visible`** via `_refreshVisibility`,
   and whether `_canHover`/`_canControl` overrides suffice to block interaction for
   non-audience users. If not, hide the mesh explicitly in `_refreshVisibility`.

**Derive at runtime, never hardcode:** the Tile placeable context-menu hook name (the
`get*PlaceableContextOptions` family); the font definitions API shape
(`CONFIG.fontDefinitions` vs `FontConfig.getAvailableFonts()`); whether `pixi-filters`
(`GlowFilter`, `OutlineFilter`) is bundled; `_stats.compendiumSource`; whether
`core.photosensitiveMode` exists (wrap in try/catch); whether a public HTML sanitiser
exists (**assume not** — strip `script`/`iframe`/`on*` explicitly).

---

## 6. Build order

Each step ends green (`npm test && npm run lint && npm run build`) and with a commit.

### Step 1 — Data layer and authoring skeleton
`src/data/PinData.ts` — a `foundry.abstract.DataModel` subclass validating the
`flags["documents-pinner"].pin` payload so bad flags from an older version cannot crash
the canvas. Mirror `src/types/dp.d.ts` exactly. Fields: `v`, `mode`, `source`, `display`,
`effect`, `audience`, `interaction`.

`src/data/PinStore.ts` — impure CRUD over Tile flags. `place()`, `read()`, `update()`,
`convertMode()`, `batchUpdate()` (one `Scene#updateEmbeddedDocuments` for N pins, never
N calls), `all(scene)`. Every write carries `{ [INTERNAL_OPTION]: true }` and every hook
early-returns on it. Serialise writes per anchor through a promise chain (copy the
`enqueue` pattern from
`/Users/julien/Documents/FoundryModules/alternative-token-foundry/scripts/request-service.mjs`).

`src/data/migrations.ts` — versioned, GM-only, idempotent, runs on `canvasReady` for the
active scene and offers a world-wide sweep for scenes never opened.

`src/settings.ts`, `src/api.ts`, `src/ui/controls.ts`, `src/ui/keybindings.ts`.

At this point props render as plain Tiles with a placeholder texture. **That is a real
milestone** — it proves the authoring UX and the anchor choice with no rendering risk.

### Step 2 — Audience enforcement and the GM control surfaces
`src/canvas/PinnedTile.ts` — `CONFIG.Tile.objectClass` subclass. **Chain the current
value at `init`** so you compose with systems rather than clobber them:
```ts
Hooks.once("init", () => {
  CONFIG.Tile.objectClass = class PinnedTile extends CONFIG.Tile.objectClass { /* … */ };
});
```
Override `isVisible` (core `hidden` AND `audience.canSee`), `_canHover`, `_canControl`,
`_onClickLeft2`, `_draw`, `_refreshMesh`, `_destroy`. **Never touch the mesh's position,
size or rotation** — core owns the transform entirely.

Wire the ownership ledger: on audience change, `planRetarget` → one document update
carrying both the ownership diff and the ledger flag. Add the manual-edit detector on
`updateJournalEntry`/`updateJournalEntryPage` (`changed.ownership` present,
`!options[INTERNAL_OPTION]`, acting GM only) → `planRebase`. Add the `ready`
reconciliation sweep.

`src/apps/PinHUD.ts` (extends `BasePlaceableHUD`, uses core's `togglePalette` idiom) and
`src/apps/Pinboard.ts`. **This is the product's differentiator — land it early and make
it excellent.** See §8.3.

### Step 3 — Rendering core
`src/render/enrich.ts` — **the single `enrichHTML` call site.** Rules in §7.2.
`src/render/ContentResolver.ts` — uuid → `{ html, title, access }`.
`src/render/CardTemplate.ts` — self-contained card markup.
`src/render/AssetInliner.ts` — fonts + `<img>` → `data:` URIs, memoised in a module-level
`Map`, per-asset cap 2 MB / total cap 8 MB, warm the font cache at `ready` via
`requestIdleCallback`.
`src/render/Rasterizer.ts` — the one piece of genuinely novel code:
```ts
const doc = `<div xmlns="http://www.w3.org/1999/xhtml" class="dp-card">
    <style>${fonts}\n${css}</style>${html}</div>`;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">`
          + `<foreignObject x="0" y="0" width="${w}" height="${h}">${doc}</foreignObject></svg>`;
// Blob -> objectURL -> new Image() -> await img.decode()  (throws on WebKit -> degrade)
// -> OffscreenCanvas(w*dpr, h*dpr) -> PIXI.Texture.from(canvas, { resolution: dpr,
//    mipmap: PIXI.MIPMAP_MODES.ON, scaleMode: PIXI.SCALE_MODES.LINEAR })
```
Explicit `width`/`height` on both `<svg>` and `<foreignObject>` (Chrome requires it).
Mipmaps are mandatory: they make the far LOD look right **and** enable the free
out-of-focus blur via positive mip bias in the fragment shader.
`src/render/TextureCache.ts` — LRU keyed by `(uuid, userId, resTier, presetBake, docHash)`.
**Always `texture.destroy(true)` on eviction** — `PIXI.Texture.from(canvas)` caches by
the canvas's internal id and leaks GPU memory otherwise.

`styles/card.css` is loaded normally (for the reader) **and** fetched and string-inlined
into the SVG, so the two tiers cannot drift.

### Step 4 — Interaction layer
`src/canvas/PropHitLayer.ts` — a `CanvasLayer` (**not** `InteractionLayer`, whose
`interactiveChildren` is tied to `active`) registered into `CONFIG.Canvas.layers` in
group `interface`. One empty `PIXI.Container` per prop with `eventMode: "static"` and a
rotated `PIXI.Polygon` hit area. Read `zIndex` for tokens/notes **at runtime** and sit
below them. Disable hit areas while a token drag or the ruler is active.

`src/apps/OverlayRoot.ts` — mount, `alignToBoard()`, and `syncTransform()` using
`src/canvas/transform.ts` (already written and tested). Mount as a sibling of `#board`
inside `#interface`, `z-index: 90` (below core's HUD at 100), `pointer-events: none` on
the container and `auto` only on interactive cards.

`src/apps/ReaderOverlay.ts` — the L3 focus reader.

### Step 5 — Effects
`src/effects/EffectRegistry.ts` — `id → { bake?, shaderClass?, filterFactory?, cssClass }`,
picked by tier. **Implementation preference: baked > shader > CSS.** Baked effects cost
nothing per frame and survive a future PIXI major untouched.

Order of work: baked presets first (aged-parchment, sealed-and-wax, torn-edges,
bloodstained — best quality/effort ratio in the module), then the CSS renditions for the
reader tier, then GLSL under `src/effects/shaders/` (the **only** PIXI-version-dependent
code in the project).

Per-preset implementation notes are in `docs/DESIGN.md` §7; the parameter → CSS mapping
is already written and tested in `src/effects/preset-css.ts`.

### Step 6 — LOD, culling, budgets
`src/canvas/PropManager.ts` — **the only stateful singleton.** Owns `Map<tileId,
PropRecord>`, one `canvas.app.ticker` callback at `PIXI.UPDATE_PRIORITY.LOW`, the shared
`PIXI.UniformGroup` (`uTime`, `uDarkness`, `uGlobalIntensity`), the texture LRU, and the
LOD state machine. Everything else stays stateless.

### Step 7 — Studios and polish
`src/apps/PinStudio.ts`, `src/apps/PresetStudio.ts`, `src/apps/DocumentPicker.ts`,
`src/apps/PlacementGhost.ts`. Image/video sources. Compendium handling. `/pin` command.
README screenshots/GIFs. CHANGELOG. Tag `v1.0.0`.

---

## 7. Hard rules

### 7.1 Performance — these are non-negotiable
- **Never `backdrop-filter`** anywhere. Over a WebGL canvas it forces a per-frame
  readback of the composited backdrop and destroys the frame rate.
- **Never animate SVG `feTurbulence` `baseFrequency`/`seed`** — full CPU-side filter
  re-evaluation every frame. Static use only.
- Any `PIXI.Filter` must set `filter.resolution` explicitly (PIXI 7 default is
  `PIXI.Filter.defaultResolution`, **not** the deprecated `PIXI.settings.FILTER_RESOLUTION`)
  or filtered props render visibly softer than unfiltered ones.
- **One ticker callback for the whole module.** Never per-prop tickers or rAF loops.
- **One shared `PIXI.UniformGroup`.** A preset change is a uniform write, not a shader
  recompile.
- **Transform sync is guarded by a dirty check on the six matrix components**
  (`sameMat`), *not* by the `canvasPan` hook — that hook fires every tick during an
  animated pan. Six float comparisons when nothing moved.
- **DOM writes are write-only and batched into one rAF.** Never read
  `getBoundingClientRect()` in a frame you write styles.
- **LOD recompute debounced 100 ms** after the transform settles — tier changes allocate
  textures and must not thrash during a zoom gesture.
- **Texture generation is a concurrency-1 priority queue**, priority = distance from
  viewport centre; off-screen work via `requestIdleCallback` with a 30 ms deadline;
  cancel in-flight work when a prop leaves the viewport.
- **Resolution tiers snap to powers of two** (`RES_TIERS` in `const.ts`).
- **Source-edit invalidation debounced 250 ms and coalesced by UUID.**
- **VRAM budget 256 MB default**, LRU by `lastSeen`, evicted props demote to L1.
  2048² RGBA8 = 16 MB, so ~16 full-res props resident. Target 50 props/scene with
  graceful degradation.
- **Auto-degrade** if the module's ticker budget exceeds 4 ms for 60 consecutive frames:
  drop every tier by one and post **one** notification with a "Review in Pinboard" link.
  Never silent, never a hard failure.
- `store` off-screen DOM cards behind `content-visibility: auto` +
  `contain-intrinsic-size`.

**The LOD ladder** (thresholds in `const.ts`):

| Tier | Condition | Texture | Effect | DOM |
|---|---|---|---|---|
| L0 culled | off-viewport / `hidden` / not in audience | released after 5 s | — | — |
| L1 silhouette | apparent width < 48 px | shared tinted paper | — | — |
| L2a coarse | 48–320 px | 512 px long edge | ½ intensity, ≤3 taps | — |
| L2b full | ≥ 320 px | `min(2048, nextPow2(px·dpr))` | full shader | — |
| L3 reader | focused, ≥ 480 px, readable by this user | unchanged | eases into focus | live enriched HTML |

### 7.2 Security and secrets
- **Never render on one client and broadcast HTML.** Every client enriches locally from
  its own copy. This is the strongest guarantee in the module and another reason not to
  use a socket for content.
- **One enrichment call site** (`src/render/enrich.ts`) with `secrets` computed from the
  **viewing user only**:
  ```ts
  enrichHTML(page.text.content, {
    secrets: page.isOwner,          // NEVER game.user.isGM, NEVER a value from the GM's client
    documents: true, links: true, rolls: true, embeds: true,
    relativeTo: page,
    rollData: page.parent?.getRollData?.() ?? {},
  });
  ```
- **Post-filter belt-and-braces:** when `!page.isOwner`, remove
  `section.secret, .secret` from the fragment before insertion.
- **Sanitise explicitly** — strip `script`, `iframe`, `on*` attributes. We insert into
  our own DOM, not a core sheet.
- **GM preview** — "show me what \<player\> sees" re-enriches with simulated ownership so
  the GM can audit *before* revealing.
- **Never over-claim.** Pin visibility is enforced **at parity with core Foundry, not
  above it** (core enforces `Tile#hidden` client-side too). The only thing genuinely
  *removed* rather than hidden is a page's secret sections. The README says exactly this;
  keep it that way.
- `safeUrl()` in `preset-css.ts` is the single place a preset string reaches CSS. Shared
  presets have **no free-form CSS field** by design — do not add one.

### 7.3 Style and conventions
- **Pure/impure split is a hard rule.** A "pure" module must never touch `game`,
  `canvas`, `ui`, `foundry`, `CONST`, `Hooks`, `PIXI` — not at import time and not inside
  a function body. That is what keeps it testable under Node. Inject anything Foundry-ish
  as a plain argument or a callback.
- **Validators and describers return i18n keys** (`DpNotice`), never prose.
- **i18n**: flat dotted `DP.*` keys, `en.json` and `fr.json` kept key-for-key parallel
  with identical placeholders. `tests/i18n.test.ts` enforces this and also fails if the
  source references a key that does not exist — so add keys as you add code.
- **CSS**: every selector `.dp-`/`#dp-` prefixed (or the full module id for the single
  overlay root), everything inside a `dp.*` layer, no `!important` outside the two
  documented `[data-dp-fx]` accessibility overrides. `tests/assets.test.ts` enforces
  namespacing, layer ordering and `@import` resolution.
- **Theme**: reference only *semantic* Foundry variables with literal fallbacks
  (`var(--color-bg-option, #1b1b23)`) and derive with `color-mix()`. That is what makes
  light and dark both work with zero override rules — never add a `.theme-dark` block.
- Every module-originated document write carries `{ [INTERNAL_OPTION]: true }`; every
  hook early-returns on it.
- `src/main.ts` contains **hook wiring only, no logic**.
- Keep the code bundler-portable: relative imports, no bare specifiers beyond
  devDependencies.

### 7.4 Accessibility
- Client setting `effectsLevel: auto | full | reduced | off`. `auto` resolves from
  `prefers-reduced-motion`, `navigator.hardwareConcurrency <= 4`,
  `navigator.deviceMemory <= 4`, and sampled FPS < 40.
- **`reduced` keeps static identity** — tint, frame, texture, edge shape — and drops only
  animation and expensive per-pixel work. Presets must still look like themselves.
  `tests/preset-css.test.ts` asserts no shipped preset collapses to a blank card.
  This is not cosmetic: if reduced motion produced grey boxes, GMs would tell players to
  switch it off.
- All animated presets freeze under `prefers-reduced-motion` **and**
  `core.photosensitiveMode` (try/catch). Glitch and scanlines are photosensitivity
  hazards; this is not optional.
- HUD is `role="toolbar"` with arrow-key navigation; palettes are `aria-expanded`
  disclosures; avatar chips are `role="checkbox" aria-checked`. The Pinboard must be
  fully operable one-handed from the keyboard.

---

## 8. UX specification

### 8.1 Entry points — do NOT hijack native drag
Dragging a journal to the canvas creating a plain `Note` is the most established journal
gesture in Foundry, and other modules build on it. `dropCanvasData` acts **only** with a
modifier held.

| Rank | Entry point | Hook |
|---|---|---|
| 1 | **Alt-drag** journal/page from sidebar | `dropCanvasData` + `game.keyboard.isModifierActive("Alt")` |
| 2 | Journal sheet header button "Pin to scene" | `getHeaderControlsApplicationV2` |
| 3 | Two tools in `controls.notes.tools` — *Pin document*, *Pinboard* | `getSceneControlButtons` |
| 4 | Sidebar + page context menus | `get*ContextOptions` |
| 5 | Keybindings | `game.keybindings.register` |
| 6 | `/pin <search>` | `chatMessage` |

No new top-level scene-control group — the rail is contested and pins belong with Notes.
Expose a setting `dropModifier: alt | ctrl | shift | none` for hostile OS/browser
combinations (macOS Option-drag alters HTML5 `dropEffect`).

`renderTileConfig` and `renderNoteConfig` each get a **three-element** injected section
(switch + thumbnail + "Open Pin Studio"), wrapped in `.dp-scope`. Deliberately tiny —
DOM injection into a core ApplicationV2 is the most fragile thing the module does, so
keep the blast radius to one row of HTML. This also gives one-click adoption of existing
Notes, including ones made by Pin Cushion or Revealed Notes Manager.

Keybindings: `Shift+P` pin last-viewed doc at cursor with last preset (zero dialogs) ·
`P` Pinboard · hold `Alt` **peek** (all props → 15 % so the map beneath is readable, for
players too) · `Alt+Shift+V` cycle audience · `Esc` cancel.

### 8.2 Placement — ghost, not modal
A modal cannot answer the only questions that matter at placement time (*how big is it
here, does the effect read against this map, is it covering the door*) and costs two
extra clicks per pin. A GM placing ten pins while prepping would face ten modals.

A ghost of the real prop at real scene size, `opacity: .65`, effect live, follows the
pointer, with a legend chip below-right — the self-teaching move, because nobody reads
docs mid-prep:

```
      ╭────────────────────────╮
      │   ~ The Duke's Letter  │
      │   Aged Parchment · 60% │
      ╰────────────────────────╯
        ┌────────────────────────────────────────────┐
        │ ⟳ wheel rotate  ⇧⟳ fine   ⌥⟳ scale         │
        │ ␣ prop ⇄ pin    E effect  V audience: All   │
        │ ⌘ free-place    ⇧click stamp   ⎋ cancel     │
        └────────────────────────────────────────────┘
```

`wheel` rotate 15° · `Shift+wheel` 1° · `Alt+wheel` scale (0.25×–6×) · `Space` prop⇄pin ·
`E`/`Shift+E` effect · `V` audience · `R` reset rotation · `Ctrl` suspend grid snap ·
click places · **`Shift+click` places and stays armed** (eight clue markers = one arm,
eight clicks) · `Esc`/right-click/layer-change/window-blur cancels.

On commit: a 220 ms settle animation (scale 1.06 → 1, drop-shadow bloom) and a transient
toast `Pinned "The Duke's Letter" — visible to Players. [Configure] [Undo]`. Elevation
inherits the active Scene Level; show a `▲ Level 2` tag in the legend **only** when the
scene has more than one level.

### 8.3 Changing visibility — the two surfaces (the most important ergonomics work)

The HUD answers *this one, right now*; the Pinboard answers *the whole scene*. Ship both.

**Pin HUD** — `BasePlaceableHUD` subclass using core's `togglePalette` idiom:

```
 ┌───┐                                                    ┌───┐
 │ 👁 │ visibility      ╭──────────────────╮   pin ⇄ prop  │ ⇄ │
 │ 👥 │ audience ▸      │  ~ The Duke's ~  │  open for me  │👁‍🗨│
 │ ✨ │ effects  ▸      │      Letter      │  flash        │ ⚡ │
 │ 🔒 │ lock            ╰──────────────────╯  configure    │ ⚙ │
 └───┘                                                    └───┘
   ┌──────────────────── audience palette ─────────────────────┐
   │ [All] [Players] [None]        ⛭ sync content access  [✓]  │
   │  ⬤Ali   ⬤Ben   ◯Cléo   ⬤Dara   ⚿Eve                       │
   │        "Eve can see the pin but cannot open the document"  │
   └────────────────────────────────────────────────────────────┘
```

**Avatar chips are the core idea.** Each is a circle: avatar or initial, 2 px ring in the
user's colour. **Filled = can see. Hollow = cannot.** A **⚿ key glyph** overlays the chip
when presence and content access disagree — the single most valuable indicator in the
module, because that mismatch is exactly the bug a GM ships to their table and only
discovers when a player says *"I can see it but it won't open."*

Click toggles (`setUserVisible`) · **Shift-click solos** (`soloUser`) · Alt-click toggles
content access only · hover tooltips name the resulting state in words. `👁` is a true
on/off that remembers the last non-empty audience (`toggleVisibility`). `⚡` calls
`canvas.ping()`. `👁‍🗨` opens the document locally without revealing anything.

**Pinboard** — scene-scoped, **detachable to a second monitor** via
`ApplicationV2#detachWindow`; that is the real answer to running a live session.

```
┌─ Pinboard — Ashen Keep, 2nd floor ─────────────────── ⧉ ─ □ ✕ ┐
│ Scene [Ashen Keep ▾]   🔍 duke______                     ⚙    │
│ [All 12] [Visible 4] [Hidden 8] [Props 5] [Pins 7] [Level 2]  │
├───────────────────────────────────────────────────────────────┤
│ ⋮⋮ ▤  The Duke's Letter        prop  ⬤⬤◯⬤⚿  Aged  ▾  ◎  ⋯  │
│ ⋮⋮ ◈  Warded Door — rune       pin   ◯◯◯◯◯  Arcane▾  ◎  ⋯  │
│ ⋮⋮ ✉  Ransom note (bloodied)   prop  ◯◯◯◯◯  Blood ▾  ◎  ⋯  │
├───────────────────────────────────────────────────────────────┤
│ ▣ 3 selected   [Reveal to all] [Hide] [Effect ▾] [Delete]     │
│ [＋ Place…]         [Reveal all]  [Hide all]   ⏱ 4 / 12 shown │
└───────────────────────────────────────────────────────────────┘
```

Row: drag handle (reorders `sort`) · live thumbnail with effect · name (+ page breadcrumb
on hover) · mode chip · **the same avatar chips as the HUD** · effect quick-swap ·
**◎ locate** (pans and zooms to the pin, then flashes it) · ⋯ overflow.

Optimise for these live-play constraints:
- **One-handed keyboard operation** — ↑↓ focus, `Space` toggles the focused row, `Enter`
  Pin Studio, `L` locate, `O` open for me, `F` flash, `/` search, `Esc` clears. A GM must
  be able to reveal the right clue without looking away from the table.
- **No confirmation dialogs on reveal/hide.** Reversible actions never confirm; `Delete`
  does.
- **Bulk is first-class.** Shift-range-select, then "Reveal to all" in one gesture — the
  scripted-reveal moment ("as the ritual completes, all three glyphs light up").
- **Row order is the reveal order**, hand-sortable, persisted in `sort`. That makes the
  Pinboard a lightweight scene script.
- Footer counts so scene state is visible at a glance.

### 8.4 Pin Studio
Bespoke ApplicationV2 (**not** a NoteConfig/TileConfig tab — 20+ controls and a live
preview do not fit, and mutating a core class's `static PARTS` is monkey-patching).
`tag: "form"`, `submitOnChange: true` (every change live on canvas — no Save button, no
"did that apply?"), `closeOnSubmit: false`, detachable.

Three tabs + a persistent live preview + an always-visible placement strip:
**Content** (source, page, label, tooltip, interaction) · **Appearance** (mode, pin icon
or prop geometry, effect gallery + intensity + motion, on-the-map behaviour) ·
**Audience** (the chip matrix, content-access sync, reveal animation/sound/chat card).
Footer: Level, Elevation, Sort, Locked, Reset.

Defaults so a GM who never opens this window gets a good result: **prop / live content /
fit-to-content / last-used preset at 60 % / audience All / open on double-click / fade
under tokens on / reveal = materialise / no sound / no chat card.**

### 8.5 Preset Studio
Three panes: preset list · live preview · parameters. Core presets are read-only —
**Duplicate is the only way to edit one**, so a broken user preset always has a working
ancestor. **Preview background swatches** (current map / dark / light / checker) matter
more than they look: an effect that reads beautifully on white is invisible on a dark
dungeon map. Freeze-motion for authoring, replay-reveal for tuning. A cost meter from
`estimateCost`. Import via paste / FilePicker / file-drop, validated by `validatePreset`
(already written) — unknown params drop with a warning so a future-version preset
degrades instead of failing. Export writes JSON and copies to clipboard.

### 8.6 Player experience
Hover feedback and cursor affordance on interactive props; double-click opens; read in
place for prop mode. On reveal: the preset's reveal animation, optionally a ping, a
sound, or a chat card (all off by default). **Fade when a token is underneath** (default
on, 25 %) so props never obscure gameplay, and click-through when interaction is `never`.

---

## 9. Definition of done for v1.0.0

`docs/DESIGN.md` §11 holds the full acceptance-criteria table. The ones that matter most,
and which you must actually verify rather than assume:

1. A prop is **darkened by scene darkness and lit by a torch** — the single most
   important visual check, and the whole justification for §3.2.
2. A prop is **hidden by unexplored fog** and **occluded by a roof tile**.
3. A token standing on a prop renders **in front of it**.
4. Toggling one avatar chip changes visibility for exactly that player, live, no reload.
5. GM secrets are **absent from a player's prop** — inspect the player's own texture/DOM,
   not just the picture.
6. Reveal → un-reveal restores ownership byte-for-byte; a manual GM edit in between
   survives and raises the ⚿ badge.
7. Mode switch pin↔prop keeps the same `_id`, all flags, and the Pinboard row.
8. 50 props on one scene hold 60 fps; auto-degrade toasts once; VRAM stays under budget.
9. `prefers-reduced-motion` stops animation but presets keep their identity.
10. Deleting the source shows a placeholder, no console errors, anchor survives.
11. Disable → re-enable repairs the ledger with no orphan grants.
12. The Pinboard is fully operable one-handed from the keyboard.

Plus: 116 existing tests still green and meaningfully extended; lint at zero;
`docs/DESIGN.md` updated with what you learned (append **Amendments** with the field
observation that motivated each, rather than rewriting history); CHANGELOG in
Keep-a-Changelog form; README updated with real screenshots/GIFs and the status banner
removed; `module.json` version stamped by the tag, not by hand.

---

## 10. Out of scope for v1 — do not build these

- Editing document content from the map. Props are a view; the sheet is the editor.
- Replacing core Map Notes.
- Player-authored pins. Players read; only the GM places and reveals.
- Rolling a pinned RollTable from the map (needs OWNER, which we never grant).
- Animated video content inside a rasterised prop.
- Actor / Item / RollTable sources — define the adapter interface, ship journals + images.
- Any claim of secrecy beyond core Foundry's own.

## 11. Module ecosystem

**Integrate**: Sequencer (expose `api` so effects can target a pin), Monk's Enhanced
Journal (source documents), Levels / Perfect Vision (elevation + vision).
**Test for conflict**: Pin Cushion and Revealed Notes Manager (both subclass `Note`; we
subclass `Tile`, so they should coexist — verify the config injection does not collide),
**Token Magic FX** (also touches Tile mesh shaders — the real conflict risk), JTCS Art
Gallery (overlapping intent, different mechanism).

---

**Start by**: reading `docs/DESIGN.md`, then `src/data/ownership-plan.ts` and
`src/data/audience.ts` to absorb the house style, then asking me to run
`docs/spike-0-probe.js` and give you the report. Do not write canvas code before you have
those four answers.
