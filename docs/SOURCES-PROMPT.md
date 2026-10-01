# Sources prompt — compendium search, then Actor and Item sources

*Paste everything below the line into a fresh Claude Code session started in
`/Users/julien/Documents/FoundryModules/documents-pinner`.*

---

You are the lead engineer and integrator for the next chapter of **Documents Pinner**, a
Foundry VTT v14 module (TypeScript, Vite, vitest, no runtime dependencies) that pins a
document onto the map as a small icon or as a readable prop lying on the scene. This
chapter widens **what can be pinned**:

1. **Compendium sources** — the picker and `/pin` find journals in compendiums, and a pin
   on a compendium document works for the GM and the players.
2. **Actor and Item sources** — a wanted poster from an Actor (portrait, name, a chosen
   text), a found-object card from an Item (image, name, description).

You run it as a small team: a **senior-engineer** subagent writes the engineering brief and
reviews every diff; **specialist** subagents implement in their own git worktrees; you
integrate. Read this whole brief before doing anything.

## 0. Ground rules

- **No release and no version bump.** `module.json` and `package.json` stay as they are;
  CHANGELOG entries go under `## [Unreleased]`; no new what's-new bullets.
- **Pin schema 5 and preset schema 3 are unreleased.** A new pin field joins version 5
  (extend the `SCHEMA_VERSION` history line in `src/const.ts`) — do not bump to 6. Defaults
  come from the normaliser, so a payload without the field already behaves as one with it.
- **Do not push without asking.** Commit locally with Conventional Commits in the house
  voice (`git log -10` shows it: a subject that says what a GM experiences, a body that
  says why, and the tests that fail before).
- **The architecture is decided.** The Tile anchor, the per-client enrichment and secret
  stripping, the ownership ledger, the pure/impure split and the `fvtt.ts` access helpers
  all stay. This chapter adds a source layer; it does not move anything else.
- **Never over-claim.** Anything about Foundry's runtime you have not measured is written as
  unverified, feature-detected in code, and put on the live checklist (§7).
- **Ask the owner** the decisions in §4 before building the parts they decide.

## 1. Start

1. `git fetch`. The chapter builds on commit `26fdf70` (Phases 1 and 2 of the plan). Use
   `main` if it contains it (`git merge-base --is-ancestor 26fdf70 origin/main`), otherwise
   `origin/claude/bold-shannon-t6n9jt`. Create `feat/sources` from it.
2. `npm ci`, then the CI set, which is exactly what CI runs:
   `npm run lint`, `npm test`, `npm run build`,
   `npm run harness && git diff --exit-code tests/harness/effects.html`,
   `npx tsc --noEmit`, `npx prettier --check "src/**/*.ts" "tests/**/*.ts" "styles/**/*.css"`.
   Baseline: 70 test files, 1162 tests, all green; a full pass takes about a minute.
3. Read, in this order:
   - `docs/DESIGN.md` — §1 (scope: Actor/Item were "a later adapter", RollTable stays out),
     §3 (security), §4 (ownership ledger), §6 (rendering), §7, §9, §10 (limitations 7 and
     10 are about compendiums), then amendments A9 (the "unwired" lesson), A21–A26.
   - `docs/AUDIT-UX-PRODUCT.md` P8; `docs/PLAN-FEATURE-GAPS.md` §7.
   - The code in §2's map.
4. Get the Foundry v14 type definitions **outside the repo** as the API reference:
   `npm pack fvtt-types@beta` in a scratch directory and unpack it. They are evidence, not
   proof: the repo has caught them wrong once (a tile's point is its centre on 14.365).

## 2. What exists today — verified at `26fdf70`

| Area | Fact | Where |
|---|---|---|
| Source kinds | `DpSource.kind` is `"document"` (a uuid) or `"image"` (a path); `DOCUMENT_SOURCES = ["JournalEntry", "JournalEntryPage"]` | `src/types/dp.d.ts`, `src/api.ts:46` |
| Drops | `sourceFromDropData` accepts any JournalEntry/Page uuid — a compendium one included — so an Alt-drop from a compendium already makes a pin. Actors and Items return `null` and fall through to core. | `src/api.ts:55` |
| Menus, header button | `sourceFromDocument` refuses anything outside `DOCUMENT_SOURCES`; the context-menu hooks are the journal ones only | `src/api.ts:92`, `src/main.ts:60-63`, `src/ui/entry-points.ts` |
| Picker | World journals only: a flat, folded search over entries and pages | `src/apps/DocumentPicker.ts:43` |
| `/pin` | World journals only; the first substring match | `src/ui/entry-points.ts:140` |
| Resolution | `resolveSource` (async, `fromUuid`) and `resolveSourceSync` (`fromUuidSync`). The sync path has **16 call sites** — 10 of `resolveSourceSync`, 6 of `resolveUuidSync` — in `api.ts`, `ownership-sync.ts`, `Pinboard.ts`, `PinStudio.ts`, `PropManager.ts` and `migrations.ts` | `src/api.ts:105-121`, `src/fvtt.ts:138-157` |
| **The seam** | `fvtt.ts:148` says "Compendia return null". The v14 types say otherwise: `fromUuidSync` returns the **index entry** for a compendium document (a plain object: name, id — no `pages`, no `testUserPermission`, no `sheet`), and **throws** for an embedded compendium document (a page), which the wrapper turns into `null`. Every sync site must be audited against both shapes. | types: `foundry/client/utils/helpers.d.mts:63-69` |
| Content | `ContentResolver.rawContentOf` dispatches on `source.type` (`text`/`image`/`video`/`pdf`/entry). An Actor's or Item's `type` is a **system subtype** (`npc`, `weapon`), which would fall to the default branch and render nothing. Dispatch must be on `documentName` first. | `src/render/ContentResolver.ts:57` |
| Ownership | `grantTargets` is journal-shaped (page + LIMITED on its entry, A23); `grantable` refuses pack documents; `reconcile`'s `sourcesWithLedger` already walks `game.actors` and `game.items` | `src/data/ownership-sync.ts` |
| Hooks | Edits invalidate cards, follow renames and rebase the ledger for `JournalEntry` and `JournalEntryPage` only | `src/main.ts:259` |
| Security | Every HTML that reaches a card goes through `enrichFor`, which strips `secret` sections for non-owners on each client (§3) | `src/render/enrich.ts` |
| Packs (types) | `CompendiumCollection` has `getIndex({ fields })`, `visible`, `getUserLevel(user)`, `testUserPermission(...)`, `importDocument(...)`; `HTMLField` exists in `foundry/common/data/fields.d.mts`, and system data is a `TypeDataModel` with a `schema` | types |

## 3. The table stories (what "done" means to a GM)

- **Compendium.** "The adventure I bought ships its handouts in a compendium. I type
  *letter* in the picker, see *Letter from the Baron — Curse of the Crimson Throne:
  Handouts*, and pin it. When I reveal it, my players read it."
- **Actor.** "The party walks into the tavern. On the notice board: a wanted poster —
  the bandit's portrait, his name, the bounty line from his biography. My players read the
  poster. They never see his stat block."
- **Item.** "In the chest: a strange amulet. A card with its picture, its name and the
  description I wrote. Handing the item over is the system's job, not this module's."

## 4. Decisions for the owner — ask before building what they decide

Put these to the owner in one message, each with your recommendation, after the engineering
brief exists (it may change the recommendations):

| # | Decision | Recommendation |
|---|---|---|
| D1 | A compendium the players cannot read (pack ownership below OBSERVER for the player role, or not `visible`): their client probably cannot load the document at all (verify, §7). Reference it anyway and warn, import a world copy on pin, or refuse? | Reference when the players can read the pack. Otherwise the picker offers **Import & pin** — a world copy in a "Documents Pinner" folder, carrying `_stats.compendiumSource` — and the GM is told why. |
| D2 | How far ownership sync may go for an Actor. OBSERVER on an NPC opens its whole sheet, stats included. | **Cap Actors at LIMITED** in `grantTargets`: in most systems a limited sheet shows the portrait, name and biography. Items may take OBSERVER. |
| D3 | Embedded documents: an Item owned by an Actor (`Actor.x.Item.y`), a synthetic token actor. Their ownership is the parent's. | **Out of scope this chapter**: refused at the drop, picker and menu, with a short message. |
| D4 | Which text an Actor or Item card shows. Systems differ (dnd5e, pf2e, a homebrew…). | **System-agnostic**: walk the document's `system` data model and offer every `HTMLField` path in the Studio ("Text shown"). Default to the first path matching `/biograph|description|public|notes/i`, else the first one. Store the chosen path in a new `source.field` (schema 5). Discover once per document type and cache. |
| D5 | Picker shape. | One search box; type chips (*Journals · Actors · Items · Images*); compendium results searched lazily once the query has two characters, labelled with the pack's title and greyed when the players cannot read the pack. |
| D6 | Card layout for actors and items. | A **portrait card**, derived from the source type rather than a stored field: image above, name as the heading, the chosen text below, in the same card shell, so papers, effects, typefaces and Fit to content keep working. |
| D7 | RollTables, Scenes, Macros. | Stay out (DESIGN §1.1). |

## 5. How to run the chapter

### 5.1 The team

1. **Senior engineer (subagent, first, alone).** Reads §1–§3 plus the code, verifies every
   Foundry API this chapter touches against the v14 types and the repo's measured usage,
   and writes `ENG-BRIEF-SOURCES.md` **in your scratch directory, not the repo**:
   - A compatibility contract: per API, the access path (through `fvtt.ts` / `ns()`), the
     evidence, LIVE versus TYPES-only, and the fallback. At least: `game.packs` filtered by
     `documentName`; `CompendiumCollection#getIndex`, `visible`, `getUserLevel`,
     `testUserPermission`, `importDocument`; `fromUuid`/`fromUuidSync` for pack entries and
     pack pages; loading a page of a pack journal; `ClientDocument#sheet` and the view
     permission each sheet checks; `TypeDataModel` schema traversal and `HTMLField`
     detection; `TextEditor.implementation.enrichHTML`; Actor `img` versus the prototype
     token's texture; the `updateActor`/`updateItem` hooks; the drag payloads for an Actor
     and an Item from the sidebar and from a compendium; the context-menu hook names for the
     Actor and Item directories and for compendium windows.
   - Resilience, performance and testing rules for this chapter.
   - Ownership zones per package, merge order, and the review checklist it will apply.
2. **Package S1 — compendium sources**, one specialist in a worktree (§6.1).
3. **Package S2 — the source adapter, then Actor and Item**, one specialist in a worktree
   (§6.2). **Sequential, after S1 is merged:** S2 rebuilds the resolution layer S1 audits.
4. **Reviews.** The senior engineer reviews each package against its brief before merge.
   Blocking findings are fixed by the same specialist, as new commits. After both merges, a
   final integration review of the combined diff, which also writes the DESIGN amendments
   (§8).

### 5.2 Lessons from the last chapter — apply them

1. **Commit after each item is green.** A container restart once wiped two packages' work
   because nothing was committed.
2. **`git stash` is shared by every worktree.** Never use bare `stash`/`pop`. To prove a test
   fails before: commit first, then `git checkout <base> -- src lang styles`, run the test,
   and restore with `git checkout HEAD -- src lang styles`. **Never check out over
   uncommitted work** — it is destroyed.
3. **Iterate on the files you touch** (`npx vitest run tests/<file>`, plus `tsc` when types
   move). Run the full CI set once, at the end of each package.
4. **Lean tests.** One test per behaviour, failing before and passing after, through the
   real code path (`tests/helpers/fake-foundry.ts`: `installWorld`, `fakeTile`, `fakeDoc`).
   Variants and hostile inputs go in `it.each` tables. No tests of wording, CSS text or the
   fakes themselves. The last chapter added 283 tests and had to consolidate them to 161;
   aim for that shape from the start.
5. **The fake is never more permissive than core.** Each new member says whether it is LIVE,
   TYPES or RECALLED. A pack, an index entry and a system data model with `HTMLField`s will
   need modelling — model `fromUuidSync`'s two compendium shapes exactly.
6. **Worktrees.** Symlink `node_modules` from the main checkout. `.gitignore`'s
   `node_modules/` does not match a symlink: add `node_modules` and `.claude/worktrees/` to
   `.git/info/exclude`.
7. **Lang files** are sorted JSON, two-space indent, trailing newline, key for key in EN and
   FR. Add keys with a load-sort-dump script, never by hand. Merge them **three-way per
   key** against the common base — a union brings deleted keys back.
8. **Merges.** CHANGELOG `[Unreleased]` by union, in the order Added, Changed, Fixed. After
   merging two packages that both add imports to one file, run `tsc`: git does not flag a
   duplicate import or `const`.
9. **House rules that bit before:** all Foundry access through `fvtt.ts` (`ns()`, `cv()`,
   `g()`…), no bare deprecated globals, no `-=` keys, dotted keys inside flags are expanded
   by v14 (store lists, not objects keyed by uuids), every `canvas.ping` passes `pull` and
   `style`, and a "Reveal" is irreversible — nothing in this chapter may widen who sees what.

## 6. The packages

### 6.1 S1 — compendium sources

- **Picker:** JournalEntry packs searched lazily through their cached index, entries only —
  a page of a pack journal is chosen afterwards in the Studio, whose `_renderHTML` is
  already async. Results labelled with the pack, ordered after world results, greyed when
  the players cannot read the pack, with D1's *Import & pin* where it applies.
- **`/pin`** searches packs too, after the world.
- **The resolution audit.** Walk all 16 sync-resolution sites
  (`grep -rn "resolveSourceSync(\|resolveUuidSync(" src`) and decide, for a compendium
  source, what each must do: the label comes from the index entry; the icon and the
  breadcrumb (*pack › entry*); `pageChoices` loads the document asynchronously; the chips'
  `canUserOpen` uses the pack's permission for the player — the key is TRUE when the player
  cannot read the pack, and must show then; `isPdfPin`, `grantScope` ("from a compendium:
  the content shows, nothing is added to sidebars") and the Pinboard row. Fix the
  `fvtt.ts:148` comment. Prefer one small resolver that returns a typed "what this source
  is" summary over 16 local patches.
- **Players.** Measure (§7) whether a player client can load a document from a pack it
  cannot read. If not, the card shows the placeholder for them, and the GM was warned at
  placement — never a silent blank.
- **Ownership:** unchanged; packs grant nothing.
- **Docs:** README limitation 7 rewritten (EN and FR), CHANGELOG, picker hint copy.

### 6.2 S2 — the source adapter, then Actor and Item

1. **A behaviour-preserving refactor first, in its own commit:** a `src/sources/` registry of
   adapters keyed by `documentName`. Each adapter answers: accepts a document or drop;
   label; icon and thumbnail; sub-choices (pages, fields); the raw content for the card;
   how it opens for a player (sheet versus reader) and what "can open" means; grant
   targets; which hooks invalidate it. The journal adapter is today's behaviour. **The
   existing suite passing unchanged is the proof**, so no test edits in that commit.
2. **Actor:** a portrait card (D6) from `img` (or the prototype token's texture when `img` is
   the default), the name and the chosen `HTMLField` (D4), enriched through `enrichFor`.
   Grants capped per D2. Opening: a prop reads in place, as every prop does; an icon opens
   the actor's sheet, and the chips' "can open" follows the level that sheet needs.
3. **Item:** the same, with the item's image and description.
4. **Entry points:** Alt-drop of an Actor or Item from the sidebar or a compendium; "Pin to
   scene" in the Actor and Item directories' context menus and on their sheet headers (GM
   only); the picker's type chips; `/pin` across types.
5. **Studio:** the Content tab's *Text shown* select for actors and items (the field's label
   from the data model, else the path made readable); the page select hidden for them.
6. **Hooks:** `updateActor`/`updateItem` invalidate cards, follow renames (`followName`) and
   rebase the ledger, as journals do.
7. **Security:** an actor biography holding a `<section class="secret">` never reaches a
   player's card or reader — test it. A field path chosen in the Studio is validated
   against the discovered list before it is read.
8. **Performance:** field discovery cached per document type; nothing per frame; portraits
   go through `AssetInliner` like any image.
9. **Docs:** DESIGN §1 updated (Actor and Item are in; RollTable stays out), README (EN and
   FR), CHANGELOG.

## 7. Live verification — the owner runs Foundry locally

Write `docs/spike-2-sources-probe.js`: console snippets the owner pastes as GM and as a
player in a **test world** (never a campaign world), each printing an answer. They must settle:
- what `fromUuidSync` returns for a pack entry and a pack page;
- whether a player can load a document from a pack they cannot read;
- the drag payloads for an Actor and an Item, from the sidebar and from a compendium;
- what a LIMITED actor sheet shows in the world's system;
- the `HTMLField` paths discovered for the world's actor and item types;
- whether a LIMITED actor appears in a player's sidebar.

Fold the answers into the DESIGN amendment, and extend the live verification checklist at the
end of `docs/DESIGN.md` with this chapter's steps. If a Foundry server is running locally
with a test world, you may offer to drive it with Playwright for these checks — ask first.

## 8. Definition of done

- Every behaviour change has a test that fails on the base and passes after; the full CI
  set is clean; the test count grows in proportion to the source added, not in multiples.
- EN and FR copy, README tables and prose, CHANGELOG `[Unreleased]` in the house voice.
- DESIGN amendments **A27** (compendium sources) and **A28** (the source adapter, Actor and
  Item), written by the senior engineer from the packages' drafts — A24 stays reserved for
  the Phase-0 live probe — plus the checklist additions.
- No version bump, nothing pushed.
- A final report to the owner: what shipped, what is unverified and how it is guarded, the
  decisions taken, and the follow-ups noted but not done.
