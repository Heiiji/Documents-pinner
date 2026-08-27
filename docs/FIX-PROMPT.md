# Fix prompt — documents-pinner, pre-release hardening

*Paste everything below the line into a fresh Claude Code session started in
`/Users/julien/Documents/FoundryModules/documents-pinner`.*

---

You are hardening a Foundry VTT v14 module for its first public release. The build is
feature-complete on paper — 403 passing tests, lint and typecheck clean, 11 commits, clean
tree — but a four-reviewer council found that **several headline features have never
executed**, and I independently verified the worst of them by running the code. Your job
is to fix what is listed here, prove each fix, and get the module to a genuinely
releasable state.

Read `docs/DESIGN.md` (spec + Amendments A1–A8) and `docs/CONTINUATION-PROMPT.md` (the
original build brief) before starting. Amendment A8 already admits nothing was watched
working on a real scene; this document is what that turned out to cost.

## How to work

- **The architecture is sound. Do not re-architect.** Every finding below is a localised
  defect, not a design error. The Tile anchor, the primary-group rendering decision, the
  pure/impure split, the ownership ledger's structure and the security posture are all
  correct and reviewed well. Section 6 lists what must not be disturbed.
- **Every fix needs a test that fails before it and passes after.** The reason all of this
  survived 403 tests is that the tests cover pure functions and markup strings, never the
  integration seams. Section 5 says where the coverage must go.
- **Verify by execution, not by reading.** Where I proved something with a script, the
  evidence is inline — reproduce it, fix it, re-run it.
- Work in the order given. Group 1 blocks everything else: until it is fixed, no prop has
  ever rendered, so nothing downstream of it has ever been exercised.
- Conventional Commits, one commit per group. Do not push without asking.

---

## GROUP 1 — Nothing renders. Fix this first.

### 1.1 The rasteriser's SVG is never well-formed XML, so every prop fails, always
`src/render/CardTemplate.ts:124` (`svgDocument`), `src/render/enrich.ts:189`,
`src/render/AssetInliner.ts:140`, `styles/card.css`

An SVG loaded via `Blob → img.src` is parsed by the **XML** parser, not the HTML parser.
Three independent producers emit non-XML into it. I verified this against a real parser:

```
real card.css + trivial body       FAIL  74:22: disallowed character in entity name
no css, plain paragraph            ok
no css, <br>   (void element)      FAIL  unexpected close tag
no css, <img>  (inlined asset)     FAIL  unexpected close tag
no css, &nbsp; (entity)            FAIL  undefined entity
no css, <hr>                       FAIL  unexpected close tag
                                   5/6 fail
```

Causes:
- **`styles/card.css` uses native CSS nesting** — 13 lines beginning `&` (73, 77, 78, 79,
  85, 90, 96, 97, 102, 109, 114, 115, 120). `svgDocument` splices the stylesheet raw into
  `<style>${css}</style>`. XML has no implicit CDATA for `<style>`, so a bare `&` is fatal.
  Since the stylesheet is *always* inlined, **every prop fails on every client**.
- **`sanitise()` returns `body.innerHTML`** (`enrich.ts:189`) — the HTML serialisation.
  Void elements come out unclosed and U+00A0 becomes `&nbsp;`, undefined in XML. Confirmed:
  `body.innerHTML` on `<p>a<br>b</p><img src="x">` yields `<p>a<br>b</p><img src="x">`.
- **`inlineImages()` returns `doc.body.innerHTML`** (`AssetInliner.ts:140`) — same
  serialiser, and this is the path that guarantees an `<img>` is present.

Downstream: `decodeSvg` rejects → `rasterise` catches at `Rasterizer.ts:178` → returns
`null` → `#generate` returns at `PropManager.ts:430` without binding. The error text is
neither `"insecure"` nor `"Tainted"` (`Rasterizer.ts:181`), so `canRasterise` is never
latched false and **the doomed rasterisation is retried for every prop on every LOD pass**
— a permanent enrich + parse + build + fail storm after every pan.

`probeRasterisation()` passes because its probe SVG contains no CSS and no journal HTML,
so the module reports "canvas rendering available" and then draws nothing.

**Fix:**
1. Wrap the stylesheet in CDATA in `svgDocument` — `<style><![CDATA[${css}]]></style>` —
   stripping any literal `]]>` from `css` first. (Or de-nest `card.css`; CDATA is safer
   because it also covers future CSS.)
2. Serialise the card body with `XMLSerializer` instead of `innerHTML`, in **both**
   `sanitise` and `inlineImages`:
   `[...body.childNodes].map(n => new XMLSerializer().serializeToString(n)).join("")`.
   This self-closes void elements and emits U+00A0 literally.
3. Latch `canRasterise = false` after N consecutive failures regardless of the error text,
   and cache failed cache-keys in a `Set` (cleared on `invalidate`/`refresh`) so a bad card
   is not retried on every LOD pass.
4. **Regression test** (this is the important part): run the *real* `card.css` and a
   fixture body containing `<br>`, `<hr>`, `<img>` and `&nbsp;` through `svgDocument`, parse
   the result as `image/svg+xml`, and assert no `parsererror`. `jsdom` is already a
   dependency and its DOMParser reproduces the failure exactly.

### 1.2 Document-backed props are anchored with no texture, so core builds no mesh
`src/api.ts:169`, `src/data/PinStore.ts:96-97,113`, `src/canvas/PropManager.ts:449-450`

```ts
texture: mode === "pin" ? pinTexture(source) : (source.src ?? null) || undefined,
```
For a journal source `source.src` is undefined, so the anchor gets `texture: { src: null }`.
`PinStore.ts:96-97` documents the intended contract — *"Texture for pin mode and for the
placeholder a prop shows before it rasterises"* — and the only caller violates it.
`PropManager.#bind` returns silently on `!mesh` (`:450`), so this failure is
indistinguishable from "still loading".

Expectation (verify in a live world with `canvas.tiles.get(id).mesh`): Foundry does not add
a tile with no valid texture to `canvas.primary`, so there is no mesh to bind to and the
canvas tier is a no-op even after 1.1.

**Fix:** always give a prop anchor a real placeholder texture src, and make `#bind` log once
when `tile.mesh` is null instead of returning silently.

### 1.3 `rendering: "dom"` and the WebKit fallback render nothing at all
`src/canvas/PropManager.ts:377`, `src/apps/OverlayRoot.ts`, `README.md:125`, `CHANGELOG.md:107`, `docs/DESIGN.md` A7

`#pump` bails on `rasterisationAvailable() === false || settings.get("rendering") === "dom"`
and **there is no DOM prop renderer to take over**. `OverlayRoot.mount()` has exactly two
callers: the placement ghost and the focus reader. So every Safari user, and anyone who
picks the documented "compatibility" option, gets invisible props with only a
`console.warn`. The README, CHANGELOG and DESIGN A7 all state the opposite: *"props still
work there, but they are not lit, fogged or occluded."*

**Fix — pick one and make the docs match:**
- (a) Implement the DOM tier. The markup, CSS and content pipeline all exist; mount a
  `.dp-card` per visible prop into the overlay, positioned in scene coordinates.
- (b) Remove the `dom` setting choice, make the WebKit path raise a real
  `ui.notifications.warn` explaining props are unavailable in this browser, and correct
  README / CHANGELOG / DESIGN A7.

(a) is the honest option — DESIGN §2 chose the Tile anchor partly so the module degrades
gracefully — but (b) is acceptable for v1 if you say so plainly everywhere.

---

## GROUP 2 — Interaction that is wired to nothing

### 2.1 Players cannot click a pin at all
`src/canvas/PropHitLayer.ts:90`

```ts
if (g()?.user?.isGM) return;              // players only, correct
if (!pin || pin.mode !== "prop") continue; // <- no hit area is ever built for pin mode
```
The Tiles layer is GM-only — that is the premise in DESIGN §2 and the reason `PropHitLayer`
exists — so `PinnedTile._onClickLeft2` is unreachable for non-GMs in pin mode. The brief's
first promise, *"a little token with an icon, and players able to double click on it to see
the document"*, does not work.

**Fix:** drop the `mode !== "prop"` filter. `rotatedPolygon` is already mode-agnostic and
tested.

### 2.2 The Pinboard's bulk and global visibility buttons are dead
`src/apps/Pinboard.ts:240-245`

```ts
bulkReveal: (app: any) => bulk(app, true),
revealAll:  (app: any) => allRows(app, true),
```
ApplicationV2 invokes actions as `handler.call(this, event, target)` — `this` is the
application, the first argument is the **PointerEvent**. Every other handler in the file
gets this right (`onSetFilter(this, _event, target)`, `onBulkDelete(this)`), so these four
are an oversight. Consequences: "Reveal/Hide selected" throws on `app.selected.map`;
"Reveal all"/"Hide all" **silently no-op**, because `store.all(event)` reads
`event.tiles`, gets undefined, and returns `[]`.

This is the module's stated differentiator — the "as the ritual completes, all three glyphs
light up" gesture that the README and CHANGELOG both name as the Pinboard's reason to exist.

**Fix:** `bulkReveal(this: any) { return bulk(this, true); }` and the other three, matching
the file's own convention.

### 2.3 Every app re-attaches its listeners on every render
`src/apps/Pinboard.ts:290` · `PinHUD.ts:245` · `DocumentPicker.ts:139` · `PinStudio.ts:322` · `PresetStudio.ts:235,242`

All five call `#wire(content)` from `_replaceHTML(result, content)`. `content` is the
persistent window-content element ApplicationV2 hands you on **every** render; only `result`
is new. Fresh closures each time, nothing dedupes, handler sets accumulate.

Worst cases, all self-amplifying because the handlers trigger renders:
- **DocumentPicker** (`:151`): one `input` → `render()` → +1 handler set. Listener count
  **doubles per keystroke**; by ~12 characters the client locks up.
- **PinStudio** (`:328`): the Nth edit issues 2^(N-1) identical `doc.update()` calls to the
  server.
- **Pinboard** `#onKey` (`:336`) fires N times per keypress — ArrowDown jumps N rows.

**Fix:** wire the new subtree (`this.#wire(result)`), or attach once from `_onFirstRender`
with an `AbortController` torn down each render. One line per file.
**Verify in devtools:** `getEventListeners($('#dp-pinboard .window-content'))` after typing
three characters.

### 2.4 The HUD audience palette closes itself on every chip click
`src/apps/PinHUD.ts:105,243-245` · `src/main.ts:130-139`

`updateTile` unconditionally calls `refreshPinHUD(doc)` with no `isOurs(options)` guard
(unlike the journal hooks at `main.ts:147-155`). A chip click → tile update → HUD re-render
→ markup where both palettes carry `hidden`. Revealing to three of five players costs
*open → click → reopen → click → reopen → click*. Focus is destroyed at the same moment, so
the roving-tabindex toolbar resets to button one after every action.

This is stated ergonomic goal #1 — *"change visibility easily, mid-session, under time
pressure"* — failing on its primary surface.

**Fix:** keep the open palette id on the instance and re-apply it in `_replaceHTML`, or
patch the chip row in place instead of re-rendering the HUD.

### 2.5 The Pinboard can never receive a keystroke
`src/apps/Pinboard.ts:102,283-297,336,361-418`

The key handler is on the board root, so it needs focus inside the window — but nothing ever
focuses a row. `rowMarkup` emits `tabindex="0"` only for `focusedId`, which starts `null`,
and `_replaceHTML` restores focus only to the search input. Every path fails: `P` opens the
board with nothing focused; clicking a row focuses the `<li>` but `#select` re-renders and
`replaceChildren` destroys it; the search box swallows everything except `Escape` and `/`.

DoD #12 / acceptance criterion 16 ("fully operable one-handed from the keyboard") is unmet
on every path, while `DP.board.help` advertises ten shortcuts that cannot be reached.
`focusIndex()` and `.dp-row:focus-visible` are correct code waiting for a caller.

**Fix:** focus the first row on initial render; after `replaceChildren`, restore focus to
`.dp-row[tabindex="0"]` if focus was inside the list; let ArrowDown move from the search box
into the list. Also add `BUTTON` and `[contenteditable]` to the `typing` guard at `:363`.

### 2.6 User-authored presets can never render
`src/render/ContentResolver.ts:92` · `PropManager.ts:331` · `Pinboard.ts:64` · `PinHUD.ts:114` · `PinStudio.ts:125`

The render pipeline and both effect galleries call `getCorePreset()`, which only searches
`CORE_PRESETS`. `findPreset()`/`allPresets()` — which include the world's user presets — are
used only by the Pinboard's effect cycle. Assigning a user preset therefore yields no effect
at all, a raw id as the row label, and no reveal animation. The entire Preset Studio produces
artefacts the module cannot use, while the README promises "author, export and share your own".

**Fix:** `findPreset` in the three render/label sites, `allPresets()` in the two galleries.

### 2.7 A player who can see a prop but lacks OBSERVER gets a dead click
`src/apps/ReaderOverlay.ts:63`

```ts
if (!card.readable && !g()?.user?.isGM) return;
```
With ownership sync off — a documented setting, and the whole point of DESIGN §3.1 — the
prop is visible, the cursor says clickable, and clicking does nothing: no reader, no sheet,
no notification. The card HTML has already been built and secret-stripped at that point, so
the module is refusing to show content it is holding. This contradicts DESIGN §3.1 ("with it
off the module opens its own read-only viewer instead") and acceptance criterion 17 verbatim,
and it is exactly the "I can see it but nothing happens" failure the ⚿ glyph exists to warn about.

**Fix:** open the reader with the already-enriched card regardless of permission. Reserve the
refusal for a genuinely missing source, with a notification.

### 2.8 The Tile-config "this is a pin" checkbox creates an unrelated pin
`src/ui/entry-points.ts:222-230` · `src/api.ts:409`

Checking the box calls bare `openPicker()`, which arms the ghost and places a **new** pin
elsewhere; the tile being configured is untouched and the GM now has two objects. Unchecking
calls `api.unpin(doc)` immediately with no confirmation while the sheet holds stale data.
`adoptTile()` — the correct verb, already written and tested — has no caller anywhere.

Also: `renderNoteConfig` is never registered (`main.ts:116` wires only `renderTileConfig`,
and `onRenderConfig` bails on non-Tiles), so adopting an existing **Note** is impossible.
That was the module's only concrete ecosystem-integration surface (Pin Cushion, Revealed
Notes Manager).

**Fix:** thread the tile through (`openPicker({ adopt: doc })` → `adoptTile`), confirm before
unpinning, and register `renderNoteConfig` with a Note→Tile adoption path.

### 2.9 Every ghost-placed prop sits above tokens
`src/apps/PlacementGhost.ts:364` — `elevation: cv()?.scene?.foregroundElevation ?? 0`

`foregroundElevation` is the scene's *foreground threshold* (default 20). A tile at or above
it is an overhead tile and sorts above tokens in `canvas.primary`. That breaks acceptance
criterion 4 ("a token standing on a prop renders in front of it") for every ghost-placed
prop — one of the two visual claims the whole primary-group architecture was chosen for. The
brief asked for "inherits the active Scene Level", not the foreground threshold.

**Verify** with `canvas.scene.foregroundElevation` on a fresh scene, then **fix:** default to
`0` and let the Studio's elevation field do the rest.

### 2.10 `Alt+M` is never registered
`src/ui/keybindings.ts:106` — `if (isGM()) registerGmOnly(keybindings);`

Called from `Hooks.once("init")` (`main.ts:66-68`), where `game.user` is not yet populated,
so `isGM()` is false and the binding is never registered — it does not work and does not
appear in Configure Controls, while the README documents it. The gate is redundant anyway:
the other four bindings correctly use `restricted: true`, which is Foundry's own GM gate.

**Fix:** register `toggleMode` unconditionally with `restricted: true`; delete `registerGmOnly`.

---

## GROUP 3 — Permissions and security

### 3.1 `<noscript>` mXSS bypasses both the sanitiser and the secret filter — VERIFIED
`src/render/enrich.ts:32-47` (`FORBIDDEN_TAGS` omits `noscript`), inserted at `ReaderOverlay.ts:73`

`DOMParser` parses with **scripting disabled**; `innerHTML` on a live page parses with
**scripting enabled**, where `<noscript>` content is raw text so a `</noscript>` inside an
attribute value closes the element early. I confirmed the differential with parse5:

```
payload: <noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>
  scripting=false  ->  noscript p[title]              <- what the sanitiser sees: inert
  scripting=true   ->  noscript img[src,onerror] p    <- what the browser builds: live handler

payload: <noscript><p title="</noscript><section class=secret>GM ONLY</section>"></p></noscript>
  scripting=false  ->  noscript p[title]
  scripting=true   ->  noscript section[class] p      <- GM-only section resurrected
```

Amendment A6's round-trip **cannot** catch this by construction: it reaches a fixpoint of the
wrong parser on the first pass. The scrub is otherwise good — the A6 tag-name fix genuinely
works, I verified `<scr<script>ipt>` is removed.

Attack path: a player who owns a journal page (party notes, a character journal), or imported
adventure content, plants the string; the GM pins the page and opens the focus reader.

**Fix:**
1. Add `"noscript"` to `FORBIDDEN_TAGS`.
2. Descend into `<template>.content` — `scrub` uses `querySelectorAll("*")` (`enrich.ts:115`),
   which does not cross into a template's `DocumentFragment`. `<template><script>…</script></template>`
   currently survives `sanitise` byte-for-byte. Inert in the HTML reader, but the same string
   is concatenated into an XML SVG where `<template>` has no special meaning.
3. Make `sanitise` **fail closed**: `enrich.ts:193` returns `current` after three
   non-converging passes, i.e. markup that is by definition not at a fixpoint. Return `""`.
4. `isDangerousUrl` (`enrich.ts:71`) requires a `;` after the media type, so the common
   `data:image/png,…` and `data:image/svg+xml,%3Csvg…` forms are misclassified — fix the
   pattern in the same pass.
5. Add a test that re-parses sanitised output with `scriptingEnabled: true` (parse5 is already
   available transitively via jsdom) and asserts no event-handler attributes and no `.secret`.

**Honesty note for the docs:** keep the README's "parity with core, not above it" framing. It
is correct and it should survive. But the *secret removal* claim is stronger than parity, so
it must actually hold.

### 3.2 The ledger is written through a merging update, so no key is ever removed
`src/data/ownership-sync.ts:47`

`applyPlan` writes `data["flags.documents-pinner.grants"] = plan.ledger`. Foundry merges
nested plain objects on `Document#update` — the module relies on this itself (`DELETE_PREFIX`,
`PinStore.unpin`, the `-=` keys `planRelease` emits). So the `delete ledger.holders[key]` /
`granted[key]` / `baseline[key]` at `ownership-plan.ts:149,163,164` **never reach the stored
document**. Only total release is safe, because it takes the `-=grants` branch at `:48`.

Scenario: pin A on journal J, audience `selected:[Ali]`. GM flips to `selected:[Ben]`.
`planRetarget` correctly emits `{ben:2, "-=ali":null}`, but the merge leaves the stored ledger
with `holders:{ali:{A:2}, ben:{A:2}}`. The ledger now claims A holds `ali`, whose ownership
entry no longer exists. Every later release hits `current[key] !== wroteValue` → a false
"the GM overrode us" warning, no restore, `overridden` grows — and the phantom holder can
never be cleared, because each deletion merges straight back. `reconcile` cannot help: the
anchor is alive, so it is not an orphan.

**Fix:** emit explicit `flags.documents-pinner.grants.-=<subkey>` deletions, or unset and
re-set the flag, or write the ledger in its own update with `{recursive: false}` — do **not**
apply `recursive: false` to the same update as `ownership`, which needs the merge.

*Reasoned from Foundry's documented merge semantics, not traced against Foundry source.
Confirm in a live world before and after the fix.*

### 3.3 Deleting a pin by any core gesture never releases its ownership grant
`src/main.ts:130-139`

`deleteTile` is wired to UI refresh only. `releaseAnchor` is reachable **only** from
`api.deletePin`/`api.unpin`, called only by the Pinboard and Pin Studio.

Scenario: GM reveals a letter to Ali (ownership sync raises her to OBSERVER, journal appears
in her sidebar). End of scene, GM selects the tile on the Tiles layer and presses Delete — or
`Ctrl+Z`, or deletes it from the v14 Placeables sidebar. **Ali keeps OBSERVER indefinitely.**
`reconcile` repairs it only at the next `ready`, only on the primary GM's client. DESIGN
§10.8 explicitly keeps anchors as ordinary Tiles other tooling can act on, so this is a
mainline path.

**Fix:** `Hooks.on("preDeleteTile", …)` — `pre` so the pin flag is still readable — calling
`releaseAnchor` when GM and `!isOurs(options)`.

### 3.4 `planRebase` adopts a manual raise, then the next release destroys it
`src/data/ownership-plan.ts:210-212` then `:150-161`

A *lowering* becomes both floor and ceiling, raises the badge and notifies (`:213-219`). A
*raise* is adopted into `granted` but `baseline` is left alone — so the next release sees
`current === granted`, does not classify it as an override, and restores the baseline.

Scenario: GM reveals to Ali (`baseline.ali = null`, `granted.ali = 2`). GM then decides Ali
should own the journal and sets Owner by hand → `granted.ali = 3`, baseline still `null`. GM
hides the pin → not an override → `base === null` → the plan emits `-=ali` and **Ali's
ownership is deleted outright, silently.** This violates invariant 2, "a deliberate GM edit
always wins".

`tests/ownership-plan.test.ts:151-164` locks in the current behaviour but only with a
non-null baseline, where the damage is a silent revert rather than a deletion.

**Fix:** on a raise, move the baseline up with it, or classify it as an override exactly as a
lowering is. Add the `baseline === null` case to the test.

### 3.5 Related permission defects
- **`onSourceOwnershipEdited` reads the ledger outside its own queue** (`ownership-sync.ts:125-137`)
  while `syncAnchor` and `releaseAnchor` correctly read inside. Move both the read and the
  `if (!stored) return` inside the `enqueue` callback.
- **`store.batchUpdate` bypasses the per-anchor queue** (`PinStore.ts:211-230`) that every
  other writer uses. A Pinboard "reveal all" landing while a HUD chip toggle is in flight
  reads a stale payload and clobbers it — the exact failure the queue exists to prevent.
- **Bulk hide destroys a pin's remembered audience.** `audienceFor(current, false)` writes
  `restore` unconditionally, so hiding an already-hidden pin stores `restore.kind = "hidden"`,
  which `normaliseAudience` rewrites to `"everyone"`. A pin that was `selected:[Ali]` then
  caught by "Hide all" later reveals **to the whole table**. Leave `restore` untouched when
  the audience is already hidden.
- **`shouldRecordDiscovery` has no caller**, so the `discovered` audience is inert: `discovered`
  is permanently `[]`, `sticky` never sticks, and `grantKeysFor` returns `[]` so it can never
  sync ownership — a permanent "visible but won't open" for an audience kind the Pin Studio
  offers. Wire it (GM-only write) or remove the option.
- **Failed ownership writes reject unhandled** (`api.ts:201-205`, every UI caller uses
  `void …` with no `.catch`). The GM sees the pin revealed and the player cannot open it.

---

## GROUP 4 — Performance and correctness

- **Async rasterisation has no liveness check** (`PropManager.ts:403-435`). Five awaits, then
  `#cache.set` and `#bind` with no check that the record still exists, the tile still exists,
  the scene did not change, or the tier did not move. `stop()` clears records but does not
  cancel in-flight work or reset `#working`, so a pending generate resolves into the *new*
  scene's cache under the *old* scene's key and assigns `mesh.texture` on a destroyed mesh.
  **Fix:** a monotonic `#epoch` bumped in `stop()`/`refresh()`, captured in `#pump`, checked
  after every await. This also gives you the missing "cancel when a prop leaves the viewport".
- **`invalidate()` destroys textures still bound to live meshes** (`PropManager.ts:159-163`).
  It destroys via the cache, then nulls `boundKey` for *every* record — so the later `#unbind`
  early-returns and never restores. Editing a page that 10 props reference leaves 10 meshes
  pointing at destroyed textures for 250 ms plus serialised regeneration. **Restore first,
  destroy second, and only for affected records.**
- **A single tile update fans out to a full world rebuild; bulk is quadratic**
  (`main.ts:130-139`). Foundry fires `updateTile` once per document, so a correctly-batched
  50-pin "Reveal all" arrives as 50 hook calls, each doing O(all placeables) work: ~2500
  `PIXI.Container`/`Polygon` allocations and destroys in one tick, 50 full Pinboard renders,
  and up to 2500 `testVisibility` calls. **Fix:** coalesce changed ids into a `Set` and run
  the refresh block once from a microtask.
- **The auto-degrade guard measures a path that costs microseconds** (`PropManager.ts:219-235`).
  `elapsed` covers one counter increment, a matrix read and six float compares — a few µs
  against a 4 ms budget — because all real cost is deliberately off the ticker. The guard can
  never fire and acceptance criterion 10 cannot be observed. (`stepPerf` itself is correct and
  latches, so it cannot toast repeatedly.) **Fix:** accumulate the module's own off-frame work,
  or switch the guard to `sampledFps()`.
- **The cache key has no content signal.** `docHash` is `width + "x" + height`
  (`PropManager.ts:361`) while `ResolvedCard.contentHash` is computed and never read. So a pin
  anchored to a whole `JournalEntry` never invalidates when a page is edited
  (`keysFor` prefix-matches the page uuid against the entry uuid and finds nothing) — the prop
  is stale for the session. **Fix:** resolve the card before computing the key and put
  `card.contentHash` into `docHash`.
- **The `OffscreenCanvas` is retained by the BaseTexture** (`Rasterizer.ts:157-176`), roughly
  doubling real memory: a 2048² prop is ~22 MB VRAM **plus ~16 MB retained CPU backing store**,
  none of which `textureBytes` counts. At the 256 MB default the true footprint is ~475 MB.
  **Fix:** `createImageBitmap` and release the canvas, or count both sides and halve the default.
- **`openReader` races itself** (`ReaderOverlay.ts:50-91`): it awaits before assigning `element`,
  so two in-flight calls orphan the first card in the overlay permanently. Take a token before
  the await.
- **The placement ghost rebuilds its legend on every pointermove** (`PlacementGhost.ts:198`),
  `innerHTML` synchronously in the handler, though the legend only changes on scale/effect/
  audience/mode. Split `renderChip()` from `renderPosition()`.
- **`repositionReader` has no dirty check** (`main.ts:101-106`) despite the comment claiming
  it does; it writes five style values every tick of an animated pan.
- **Bulk delete is N round trips** (`Pinboard.ts:550`) — use one `deleteEmbeddedDocuments`.
- **Per-frame and per-prop settings reads**: `settings.get("autoDegrade")` inside the ticker;
  `currentLevel()` per prop in `#keyFor`, each doing a settings read plus a fresh
  `window.matchMedia`. Hoist both.
- **`readPin()` runs full schema validation on every read** (`PinData.ts:84`) and is called from
  `PinnedTile.isVisible`, a hot getter. Memoise on the raw flag object identity.
- **`AssetInliner`'s failure cache grows unbounded** — zero-byte failure entries never evict.
  Add an entry-count cap.
- **`record.originalTexture` goes stale when core redraws a tile.** `PinnedTile` already fires
  `${MODULE_ID}.tileDrawn` (`:166`) and nothing listens; wire it to clear `boundKey` and
  re-capture.
- **Failed rasterisations are retried forever** — see 1.1 point 3.

---

## GROUP 5 — Docs, release mechanics and coverage

- **The README has no installation instructions.** No manifest URL, no "paste into Foundry's
  Install Module dialog" — only a Development section. Add an Installation section in **both**
  languages with `https://github.com/Heiiji/Documents-pinner/releases/latest/download/module.json`.
- **The French README is roughly half the English one** — missing Installation, entry points,
  the key tables, Settings, Known limitations, Development. The prose that exists is idiomatic
  and correct; this is a completeness task, not a translation one.
- **Two French pluralisation slips** in `lang/fr.json`: `DP.chip.summary` gives "Visible par 1
  joueurs sur 4" and `DP.chip.summaryMismatch` "1 ne peuvent pas". The file's own
  `joueur(s)` convention elsewhere is the fix.
- **"None" vs "Hidden" vs "Masquée"** name the same audience state three ways across
  `DP.hud.audienceNone`, `DP.ghost.audienceNone` and `DP.audience.hidden`. One word per concept,
  per language.
- **The shipped bundle references a sourcemap that is excluded from the zip**
  (`release.yml` `-x "*.map"`), so every user devtools open 404s and `vite.config.ts`'s stated
  rationale is not delivered. Ship the map or set `sourcemap: false` for release builds.
- **CHANGELOG says `## [1.0.0] — unreleased`** and the release job does not stamp it.
- **`module.json` `compatibility.verified: "14"`** — use the real tested build, `14.365`.
- **The placement ghost never shows the effect** (`PlacementGhost.ts:196` sets
  `dataset.dpFx`; nothing styles `.dp-ghost[data-dp-fx]`). The ghost is a dashed rectangle,
  yet DESIGN §5.2's entire justification for a ghost over a modal is "does the effect read
  against *this* map". Either style it or stop claiming it.
- **The pure-CSS accessibility guard is dead** (`styles/fx/_props.css:56-63`).
  `[data-dp-fx="reduced"] .dp-pin` can never match: `data-dp-fx` holds a *preset id*, the level
  lives in `data-dp-level`, and `.dp-pin` is never emitted by any source file. The whole
  `dp.theme` layer (`styles/theme.css`) also targets selectors that never exist. The JS path
  works, so `reduced` is not broken today — but the safety net the comment describes is absent.
  Re-point to `[data-dp-level="reduced"] .dp-card` and delete the dead rules.
- **Effect choice is name-only in both live surfaces** (`styles/ui/studio.css:121`,
  `PinHUD.ts:113`): every swatch is the same beige rectangle. Emit `presetToCssVars(preset, 1)`
  into each swatch's `style` so a GM can tell Glitch from Torn Edges without applying it.
- **`interaction.tooltip` is a dead control** — the Pin Studio offers it, it persists, nothing
  reads it. `PropHitLayer` fires a `propHover` hook nothing listens to, so players get no hover
  feedback at all. Render it or remove the field.
- **`reveal.sound` and the `materialise` animation are schema-only** — validated, stored, never
  read; `materialise` and `fade` are the same alpha fade. Wire or remove.
- **Coverage must move to the seams.** 403 tests, and 21 modules have no test import at all —
  including `api.ts`, `Pinboard.ts`, `PropManager.ts`, `ownership-sync.ts`, `entry-points.ts`,
  `ContentResolver.ts`, `keybindings.ts`. **Every blocking finding above lives in that gap.**
  Add a thin jsdom integration layer with a fake `game`/`canvas` covering: ApplicationV2 action
  handler signatures, `PropHitLayer.sync()` for both modes, `svgDocument` XML well-formedness,
  the sanitiser under `scriptingEnabled: true`, `ownership-sync` apply/release round trips
  against a fake document that reproduces Foundry's merge semantics, and listener counts after
  repeated renders.

---

## GROUP 6 — Do not disturb

All four reviewers independently praised these. Leave them alone unless a fix above requires
touching them, and preserve their behaviour if it does:

- **`src/data/ownership-plan.ts`** — three named invariants, exact reversibility including
  deleting a key that did not exist, no input mutation. 3.4 is one policy choice inside it and
  3.2 is a defect in the layer around it; the structure is right.
- **`src/apps/chips.ts`** — the two-fact chip encoding, the ⚿ badge for both directions of
  mismatch, state-not-action tooltips, `safeColor`/`safeAvatar`. Every chip defect is in the
  call sites, never here.
- **`src/apps/pinboard-model.ts`** — accent-insensitive `fold()`, range-select over visible
  rows, evenly-spaced `planReorder`, clamping `focusIndex`. Finished work waiting for a caller.
- **`src/data/audience.ts`** — the state machine has no trapdoors.
- **The frame path**: exactly one ticker at `UPDATE_PRIORITY.LOW`, the six-component matrix
  dirty check, power-of-two tiers, the 100 ms post-settle LOD debounce, `texture.destroy(true)`
  on every eviction path, `OverlayRoot`'s write-only batched rAF with no `getBoundingClientRect`
  anywhere in `src/`.
- **`PinnedTile` never touches mesh position/size/rotation/anchor**, and `_refreshVisibility`
  is downward-only.
- **`PropHitLayer` is a `CanvasLayer` in group `interface` with runtime zIndex** — both correct.
- **Both hard prohibitions hold**: no `backdrop-filter` anywhere, `feTurbulence` never animated.
- **`enrich.ts`'s posture**: single call site, `secrets: source.isOwner` never `game.user.isGM`,
  per-user texture cache key, rasterisation gated on visibility before content resolution.
- **The release pipeline**: tag as the single version source, compatibility read back out of the
  manifest, conditional registry publish, `tests/assets.test.ts` validating CSS `@import`
  resolution and layer ordering.
- **The documentation voice and the DESIGN amendment discipline** — A1–A8, and A8's honest list
  of what was never verified. That honesty is why this review could be precise. Update the
  amendments with what you learn; do not rewrite history.
- **The README's "parity with core, not above it"** framing. Correct, and it must survive.

---

## Definition of done

1. Groups 1–3 fixed, each with a failing-then-passing test.
2. Group 4 fixed or explicitly deferred with a note in `docs/DESIGN.md`.
3. Group 5 done.
4. `npm test`, `npm run lint`, `npm run typecheck`, `npm run build` all clean.
5. **The DESIGN §11 manual acceptance table run once on a real scene** — darkness and torch
   lighting on a prop, fog and roof occlusion, token z-order, the live audience toggle, secret
   absence in a player's own texture, the ownership round-trip with a manual edit in between,
   mode switching, fifty props at 60 fps, one-handed Pinboard operation. Ask me to run anything
   you cannot. Amendment A8 exists because this was skipped; the cost of skipping it is this
   entire document.
6. A new amendment (A9) recording what this pass found and changed.
7. Then, and only then, tag and push.
