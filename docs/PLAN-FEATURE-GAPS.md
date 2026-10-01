# Plan — the table's experience (0.3.4 → 0.6)

**Status (2026-10-01):** Phase 1 and Phase 2 are built, reviewed and unreleased — S3, S4,
E4, P4, P2a, P2b, P6, E1, E2, E3, E8. Decisions taken for them: no socket, no bundled fonts or
sounds, Pinboard `N` with the global binding unbound, "Reveal all" moved to the bulk bar. Phase
0's measurements are the live verification checklist at the end of `DESIGN.md`. Next: Phase 3.

**Written:** 2026-09-30, after `e71bc0c` (the audit, the README fix, page-level grants, the
prop key glyph). **Source:** [`AUDIT-UX-PRODUCT.md`](AUDIT-UX-PRODUCT.md) — the item ids
(S3, P1, E4…) are that document's.

The audit's verdict in one line: the module serves the GM's hands well and leaves the
table's three beats — *they find it*, *it is revealed*, *they read it* — to chance. This
plan closes the "biggest feature gaps" in the order that builds on itself, and folds in the
rest of the audit where it belongs.

Every phase below is written to be handed to a session on its own: goal, design, data,
files, tests, live checks, copy, docs, and what it depends on.

---

## 0. How to work

The house rules from `FIX-PROMPT.md` and `CONTINUATION-PROMPT.md` hold, restated because
they decide how every item is built:

- **A test that fails before and passes after**, for every behaviour change, through the
  real code path (`fakeDoc` / `installWorld`), asserting on the stored state.
- **Measured, not assumed.** Anything that depends on Foundry runtime behaviour is checked
  in a live 14.365 world first (§2) and written into DESIGN as an amendment.
- **Copy in both languages**, key for key; `tests/i18n.test.ts` enforces it.
- **CHANGELOG under [Unreleased]**, the README when a GM would do something differently,
  a DESIGN amendment for every decision that reverses or extends one.
- **One schema bump per release**, with defaults supplied by the normaliser so an
  unmigrated payload on a player's client already behaves as a migrated one (A18, A22).
- `npm run lint`, `npm test`, `npm run build`, `npm run harness` + a clean
  `tests/harness/effects.html` diff — exactly what CI runs — before any push.

---

## 1. Decisions needed before building

These are yours; each has a recommendation.

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| D1 | **Add a socket** (`"socket": true`), reversing DESIGN §8's "no sockets — nothing to broadcast". There now is: a hand-out, a flash players can see on a text prop, a spotlight that reaches only the audience. The payload is an anchor uuid — never content — so §3's per-client enrichment and secret stripping are untouched. | **Yes.** | P3, targeted spotlight, player-visible flash |
| D2 | **Where a discovery is remembered.** On the discovering player's own `User` flags (no pin write, no socket), on the fog's explored state (no write at all, if the API allows), or by a GM-side sweep of every player's vision. | **User flags**, with the fog test as a later, write-free alternative for "everyone" pins. | P1 |
| D3 | **Fonts.** Offer only what Foundry already registers (`CONFIG.fontDefinitions`, which includes Font Config) plus generic families, or also bundle two or three OFL faces (a hand, a typewriter, a blackletter). | **Registered + generic first**; bundling is a follow-up once the picker exists. | P6 |
| D4 | **Shipped reveal sounds.** Leave every preset silent, or bundle a few CC0 sounds (paper unfold, seal crack, signal blip). | **Bundle three CC0 `.ogg`**, a licence file beside them; every preset keeps `sound: null` except the three that obviously want one. | P2a |
| D5 | **Default keys.** `N` in the Pinboard for Reveal next; a global `revealNext` binding; Hand out moves `Shift+S` from "show the sheet". | As listed; the global binding ships **unbound** until checked against core and popular modules. | P4, P3 |
| D6 | **"Reveal all" in the Pinboard footer.** Keep it with a confirmation, or replace it with "Reveal next". | **Replace** it with Reveal next; "Reveal all" moves to the bulk bar with a confirmation. | S3, P4 |

---

## 2. Phase 0 — measure first (half a day, live world, no code shipped)

A probe in the style of `docs/spike-0-probe.js`: `docs/spike-1-probe.js`, run as the GM and
as a player in a 14.365 world, printing each answer. Its results become DESIGN **A24**, and
every later phase names the answer it depends on.

| # | Question | Why it matters | Depends |
|---|---|---|---|
| M1 | Entry LIMITED + page OBSERVER: is the entry in the player's sidebar, does the page open from it and from a pin? Is an **image** page that inherits LIMITED shown? | A23 shipped on reasoning. If image pages show at LIMITED, the listing leaks images and needs another route. | shipped |
| M2 | Can a player `game.user.setFlag(...)` on their own User, with no GM online? Does the write fire `updateUser` on the GM's client? | The whole of D2. | P1, P3b |
| M3 | Does `sightRefresh` fire on the player's client when their token's vision changes, and is `canvas.visibility.testVisibility(point, { object })` right for a tile at that moment? | Discovery re-evaluation. There is no sight hook in the module today. | P1 |
| M4 | Is there a per-client "is this point explored" test on `canvas.fog`? At what cost? | Fog gating for "everyone" props (S4) without any write. | P1b |
| M5 | The ping option that pulls every view to a point (`pull`), and whether module code may pass it. | Spotlight. | P2b |
| M6 | With `"socket": true`: does it need a **server restart** to take effect after a module update? Round-trip latency GM → player. | Changelog wording, fallback design. | P3 |
| M7 | `AudioHelper.play` channel option on v14 (`environment` / `interface`), so a reveal sound obeys the player's volume sliders. | P2a. | P2a |

---

## 3. Phase 1 — 0.3.4 "Safe reveals" (small, ship first)

Finishes the audit's safety section. S1 (README), S2 and S5 are already on `main`, unreleased;
these three join them in the same patch.

### S3 — Bulk reveal honours each pin's audience · S

- `Pinboard.ts` `audienceFor(current, reveal)`: a reveal restores the pin's remembered
  audience — the same rule `audience.toggleVisibility` applies — instead of writing
  `everyone`. Extract that rule as a pure `revealed(audience)` in `audience.ts` and use it in
  both places so they cannot drift.
- Bulk bar: "Reveal to all" becomes "Reveal"; a secondary "…to everyone" in its menu.
- Footer: per D6, "Reveal all" leaves the footer; in the bulk bar it confirms when it would
  reveal more than one hidden pin, naming the count.
- **Tests:** a `selected: [ali]` pin, hidden, then bulk-revealed, reaches Ali only (fails
  today); the confirm fires for two, not for one; the eye and the bulk path agree on a
  table of audiences.

### S4 — A DOM prop in the dark · S

- `DomPropTier`: a `--dp-scene-dim` custom property from `canvas.environment.darknessLevel`,
  re-read on `lightingRefresh`, applied as `filter: brightness()` on the card (not the
  reader, which is UI). Global darkness only; no per-light claim is made.
- Studio, Audience tab, DOM-tier prop visible to anyone: one line, "Visible through fog —
  reveal it when they reach it." Removed for pins P1 gates.
- **Tests:** the property follows the level; the reader never carries it; `reduced` effects
  level keeps it (it is lighting, not motion).

### E4 — The Studio says when the table is watching · S

- Banner in the Studio header when `isRevealed`: "Visible to {n} players — changes are
  live", with **Hide while I edit**: stores the audience, hides, restores on close (and on
  a second click). The restore uses the same pure rule as S3.
- **Tests:** close restores; a pin re-revealed by hand in between is left alone.

---

## 4. Phase 2 — 0.4 "The moment"

### P4 — Reveal next · S

*Table:* the GM sorted the scene's clues in the order they will surface. Mid-scene, one
key reveals the next one and the list moves on.

- **Pure:** `pinboard-model.ts` `nextToReveal(rows, query)` — the first row, in sort order,
  under the current filter and level, that is not revealed. Tested alone.
- **Verb:** `api.revealNext(scene, query?)` — reveals through `toggleVisibility` (so the
  remembered audience is restored), flashes, and returns the row it revealed and how many
  hidden ones are left.
- **Surfaces:** Pinboard key `N`; a footer button in the place "Reveal all" leaves (D6), its
  label showing what is next ("Reveal next: *The Ledger*"); the status line announces
  "Revealed *The Ledger* — 3 left"; focus moves to the next hidden row. A global keybinding
  `revealNext`, `restricted: true`, unbound by default (D5), that works with the board
  closed.
- **Open question:** GM-only notes sitting in the order. First version: none — the GM moves
  them to the end. If it bites, a per-pin "not part of the script" flag later.
- **Tests:** the pure function over filters and levels; `N` reveals and refocuses; the
  binding with the board closed; nothing to reveal says so.

### P2a — Reveal sound and animation, editable · M

*Table:* the wax seal cracks as the letter appears.

- **Preset Studio:** a "Reveal" group — animation (none / fade / materialise), duration
  (0–3000 ms), sound (path, **Browse** with `FilePicker` type `audio`, ▶ preview, clear).
  The schema already has all three fields (`preset.reveal`) and the runtime already plays
  them (`PropManager.#onReveal`, `playRevealSound`). Only the controls are missing.
- **Volume:** `playRevealSound` passes the channel M7 names instead of a fixed `volume: 0.6`.
- **Shipped sounds (D4):** three CC0 files under `sounds/`, a `sounds/LICENSE`, assigned to
  Sealed & Wax, Arcane Glow and Signal Loss.
- **Per-pin override** (Studio, Appearance): a sound for this pin only. Stored in
  `effect.params.reveal.sound` if the params merge reaches it cleanly, otherwise
  `effect.revealSound` in schema v5.
- **Tests:** the group writes the three fields; the path rule `playRevealSound` applies is
  enforced on import too; the override wins over the preset.

### P2b — Reveal & spotlight · S (M with the socket)

*Table:* the GM reveals the map scrap and every player's view glides to it.

- `api.spotlight(doc)`: reveal if hidden (remembered audience), then a ping with `pull`
  (M5), then the DOM pulse.
- **Leak rule:** a core ping reaches every client. For an audience of everyone, pull; for
  a narrower audience, **do not pull** without the socket — pulling Ben to an empty patch of
  map tells him where Ali's secret is. With D1, the pull and the pulse go to the audience
  only, over the socket. (The existing Flash has the same leak for a `selected` audience,
  and its label admits it; the socket fixes both.)
- **Surfaces:** HUD button, Pinboard `Shift+Space`, row menu.
- **Tests:** the pull is withheld for a selected audience without a socket; reveal happens
  before the ping.

### P6 — Typeface · S–M

*Table:* the ransom note looks cut from newspapers, the terminal readout is monospace.

- **Data:** preset param `type.family: string | null`; pin override `display.font: string |
  null` (schema v5). Validated against `^[\w .'-]{1,64}$` and emitted quoted — a preset
  comes from strangers (§7), and this is a new string reaching CSS.
- **Choices:** generic families (serif, sans-serif, monospace, cursive) and every key of
  `CONFIG.fontDefinitions`. `AssetInliner.inlineFonts` already inlines every one of those
  into every card, so the canvas tier needs nothing new. (Inlining only the families in use
  is a later optimisation.)
- **Card:** `card.css` reads `font-family: var(--dp-font, "Signika", …)`; `measure.ts` measures
  the same card, so Fit to content follows the face — assert it.
- **Shipped presets:** CRT Scanlines, Projected Readout, Tagged and Signal Loss take
  monospace; Aged Parchment and Sealed & Wax a serif. A visible change: say so in the
  changelog, and regenerate the harness.
- **Surfaces:** a select with each option drawn in its own face, in Appearance and in the
  Preset Studio's Paper group. PDF props: inert, like the paper.
- **Tests:** the variable is emitted and quoted; an injection attempt is refused with a
  warning; fit measures a monospace card taller than a condensed one.

### E3 — The HUD's live verbs · S (after P2b, P3)

Left: eye · audience · **hand out** · **spotlight**. Right: effect · shape · open for me ·
gear. Lock and Fit leave for the Studio strip, where they already are.

---

## 5. Phase 3 — 0.5 "Discovery"

### P1 — Visible when seen · M–L

*Table:* the letter lies in the next room. Nobody sees it through the fog; the rogue's
torchlight reaches it and it is there — for the rogue, and it stays there.

**Audience vocabulary.** Two new choices in the Studio, the HUD palette and the ghost's
`V` cycle, both on the existing `discovered` kind:

- **When seen** — `discovered`, `sticky: true`: appears the first time the player's own
  vision reaches it, and stays.
- **While in sight** — `discovered`, `sticky: false`: visible only while in view. No writes.

**Seeing.** Already per client: `PinnedTile#isVisible` → `canSee` with `hasLineOfSight`
from `testVisibility` (`PinnedTile.ts`). Missing: re-evaluation. Hook `sightRefresh` (M3);
when the scene has `discovered` pins, re-test those only, coalesced to one pass per frame,
then `refreshAllPins(ids)`, `propManager().refresh()`, `syncHitLayer()` for the ones that
changed. The DOM card and the hit area follow `isVisible`, so fog gating comes free for
these pins.

**Remembering (D2, M2).** On the player's client, the first `true` for a sticky pin appends
its anchor uuid to `game.user.flags[MODULE_ID].seen`, **an array of uuids** — never an
object keyed by uuid: v14 expands dotted keys inside flags (the 0.3.2 ledger lesson).
`canSee` gains an injected `seenByUser: boolean`, pure as today. `canUserSee(anchor, id)`
reads that user's flag, so the GM's chips need nothing else, and `updateUser` already
refreshes them (`main.ts`).

**Granting.** `grantKeysFor` takes the discovering users from the flags instead of
`audience.discovered`, which no one can write. The acting GM's client syncs on `updateUser`
when a `seen` list grew; `reconcile` covers a discovery made with no GM online. A grant for
a sealed pin (P5) is capped at LIMITED.

**GM tools.** Chips show "discovered" with a small eye; a Pinboard filter "Waiting to be
found"; a HUD / row-menu verb **Forget discoveries** (the GM may write any user's flags);
the Studio warns when the scene has token vision off ("everyone sees everything here — a
pin *When seen* appears at once").

**P1b — fog for everyone else.** If M4 finds a cheap explored test: a per-pin "Hidden in
unexplored fog" for `everyone` props, default on for new pins. Otherwise the S4 line stays.

**Tests:** `canSee` over the new injected facts; one flag write per discovery, none for
"while in sight"; sticky survives losing sight; a grant follows `updateUser`; the ghost,
HUD and Studio offer the two choices; `sightRefresh` with no discovered pins does no work.

### P5 — Face-down: seen, not yet read · M

*Table:* the envelope is on the desk, sealed. Everyone can see it. Nobody can read it until
the GM — or a successful check — breaks the seal.

- **Data:** `display.concealed: boolean` (schema v5, default false).
- **Card:** for a player, `ContentResolver` does not enrich the body at all — paper, effect,
  title and a seal glyph only. Secrecy is at core parity, the same as a hidden pin: the
  document is in world data; this client simply never renders it. The GM sees the content
  under a "Sealed" corner badge.
- **Reader and sheet:** a player's open says "It is sealed." — no reader, no sheet.
- **Ownership:** while concealed, grants are capped at LIMITED in `grantTargets`, or the
  sidebar would open what the seal hides. This finally gives "Limited — a tease" a meaning
  on props (the audit's S5 note).
- **Chips:** a seal glyph instead of the key: the state is deliberate, not a mistake.
- **Unseal** (HUD, Pinboard `U`, row menu, Studio): clears the flag, and the reveal moment
  plays on every client that can see it — `PropManager` treats concealed → open like hidden
  → visible, so P2's sound and animation run.
- **Tests:** no enrichment for a player while concealed; the reader refuses; the grant cap;
  unseal plays the reveal; the GM still reads it.

---

## 6. Phase 4 — 0.6 "Hand-outs"

### P3 — Hand it out, in the module's own reader · M (needs D1)

*Table:* the GM slides the letter across the table. On every player's screen the parchment
rises into the middle, upright, torn edge and wax seal intact.

- **Transport:** `"socket": true`; channel `module.documents-pinner`; message
  `{ type: "handout", anchor, users }` — a uuid and a list, never HTML.
- **Sender:** GM only; recipients are the pin's audience (`canUserSee`), as
  `showToAudience` does now.
- **Receiver:** acts only if it is listed **and** its own `canSee` passes — a player
  replaying the message from a console can open, for another player, only a pin that player
  may already read. Resolves and enriches its own copy, so secrets stay stripped.
- **Presentation:** a screen-space mode of `ReaderOverlay` — centred, upright, up to 80 vh,
  the effect at reader strength — not anchored to the scene, so a letter handed out from
  another scene still arrives. Esc or a click outside closes it.
- **Fallback:** no socket yet (M6 — the server may need a restart after the update) →
  `Journal.show` as today, and the GM is told once why.
- **Surfaces:** HUD **Hand out**; the Pinboard's `Shift+S` and row menu. "Open the sheet
  for them" stays in the row menu for GMs who want core's sheet.
- **Also on the socket:** Flash and Spotlight reach the audience only, and the pulse draws
  on the players' DOM cards. Today a text prop's Flash is invisible to players: the ping
  lands under the card, and the pulse is local to the GM.
- **Tests:** message shape; a receiver not listed, or unable to see, ignores it; the
  screen-space reader's markup; the fallback path.

### E9 — The players' handouts · M (after P1 and P3)

A player's own list of every pin they were handed or discovered — `seen` and a sibling
`handed` array on their User flags — reachable from a button on the Journal directory,
each opening the screen-space reader. Clues survive the session without any sidebar grant.

### P7 — Documents with more than one page · M

*Table:* the diary on the desk has five entries; the players leaf through them.

- **Data:** `source.pages: "one" | "all"` (schema v5; default `"one"`).
- **Reader:** ‹ › and ←/→ (PageUp/PageDown keep scrolling), "2 / 5", the page title; each
  page resolved through the same `resolveCard`, so each is enriched and secret-stripped the
  same way.
- **Grants:** with "all", `grantTargets` grants each page the reader shows, plus the entry
  at LIMITED — never the entry at the audience's level.
- **Tests:** navigation bounds; "one" is today's behaviour; grants for "all".

---

## 7. Phase 5 — reach

### P8 — Compendium sources in the picker and `/pin` · S–M

Journal packs searched lazily from the picker once the query has two characters, through
their cached indices; results labelled with the pack. The Studio says a compendium source
reveals content but grants no sidebar access (pack ownership is pack-wide).

### Actor and Item sources · L (its own design first)

A source adapter behind `ContentResolver.rawContentOf`: an Actor as a wanted poster
(portrait, name, a chosen text field), an Item as a found-object card. Its own DESIGN
section before any code: ownership semantics differ (an Actor at LIMITED is a limited
sheet), and `reconcile`'s collections already anticipate it.

---

## 8. Ergonomics track — interleave as capacity allows

| Item | What | Size | Best with |
|---|---|---|---|
| E1 | The shape "pin" becomes **Icon**: "Switch between icon and prop", "Shrink to an icon". About fifteen keys per language, and the README. | S | Phase 2 |
| E2 | A `?` cheat sheet in the ghost, the Pinboard and the HUD, listing that surface's keys in the platform's names (`ui/modifiers.ts`). | S | Phase 2 |
| E5 | Opening and Tooltip move to the Audience tab, renamed **Players**; Tooltip gets a hint. | S | Phase 3 |
| E6 | An **Advanced** settings menu for texture budget, console detail, rendering tier, auto-degrade. | S | any |
| E7 | Pinboard "All scenes" scope for prep; "Pinned on N scenes" on the journal's header button. | M | Phase 4 |
| E8 | What's-new bullets only for what a GM will do differently; drop the 0.3 Firefox line. | XS | next release |
| — | `PropTooltip` reads `api.readsInPlace` instead of its own copy of the rule. | XS | any |

---

## 9. Release summary

| Release | Ships | Schema | Needs |
|---|---|---|---|
| 0.3.4 | S2, S5, README (on `main`), S3, S4, E4, E8 | 4 | M1 |
| 0.4.0 | P4, P2a, P2b (no pull for narrow audiences), P6, E1, E2, E3 (partial) | **5** (`display.font`, reveal override) | D4, D5, D6, M5, M7 |
| 0.5.0 | P1 (+P1b if M4), P5, E5 | 5 (`display.concealed`) — fold into 0.4's bump if they ship together | D2, M2, M3, M4 |
| 0.6.0 | P3, E9, P7, targeted flash/spotlight, E7 | 5 (`source.pages`) | D1, M6 |
| later | P8, Actor/Item adapters, E6 | — | — |

**Definition of done, per release:** every item's tests fail on the previous release;
lint, tests, build and harness clean; both languages; CHANGELOG and README; a DESIGN
amendment for every decision; and the live-world checklist for that release run in
Chromium and Firefox with one GM and two players, one of them on a second browser.
