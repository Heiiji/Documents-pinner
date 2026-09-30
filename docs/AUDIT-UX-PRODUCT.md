# Documents Pinner — ergonomics and product audit

**Audited:** `59f786a` (0.3.3), 2026-09-30. 57 test files, 964 tests, all green.
**Status:** S1 resolved by documenting the default in the README; S2 and S5 fixed on
`main` (`5485811`, `e71bc0c`). Everything else is scheduled in
[`PLAN-FEATURE-GAPS.md`](PLAN-FEATURE-GAPS.md).
**Lens:** two people. A GM who has run investigation and dungeon games at a real table for
years and cares what the table *experiences*, and a product lead who cares whether the
module's promises hold and whether the next release moves it forward.
**Method:** read every surface — placement ghost, Pin HUD, Pinboard, Pin Studio, Preset
Studio, reader, picker, entry points, settings, onboarding — and the data paths behind
them. Nothing here was watched in a live world. Findings are marked **confirmed** (read in
the code, with the line) or **verify live** (depends on Foundry runtime behaviour this
audit could not run).

---

## 0. Verdict

The interaction craft is unusually good. The keyboard model, focus handling, one-surface
vocabulary for audiences (the chips), honest copy and honest limitations are better than
most commercial Foundry modules. Nothing in this audit asks to re-architect.

The gap is not polish. **The module is built around the GM's hands; the table's
experience is underbuilt.** A letter lying on the table is a small scene with three
beats, and the module serves the middle one well while leaving the other two to chance:

1. **It stays out of sight until the characters find it.** Today a revealed prop is
   visible through unexplored fog, and the default makes new pins visible on placement.
   Discovery exists in the data model and is unwired.
2. **The reveal is a moment.** Today the reveal is a fade. The reveal sound is
   implemented and cannot be set from any window; "Show to players" throws away the paper
   and the effect and opens core's journal sheet.
3. **Reading it gives exactly what was meant, no more.** Today revealing a page can hand
   the players the whole journal, and "Reveal all" can show a private note to the table.

The five moves, in order:

| # | Move | Why first | Size |
|---|---|---|---|
| 1 | Safe defaults and safe bulk reveal (S1, S3) | Spoils a session today | S |
| 2 | Grant the page, not the journal (S2) and stop the false ⚿ alarm (S5) | Spoils a campaign today | M |
| 3 | "Reveal next" + reveal sound and spotlight (P4, P2) | Turns the Pinboard into the scene script it claims to be | S–M |
| 4 | Discovery: visible when seen (P1) | The feature an RP GM expects from "a letter on the floor"; also closes the fog leak | M–L |
| 5 | Hand-out in the module's own reader, typeface choice (P3, P6) | The module's look reaches the moment it matters | M |

---

## 1. What works — keep it

- **The ghost.** Placing the real thing at real size with the legend beside it is the best
  idea in the module. Stamping (`Shift+click`) makes prep of ten clue markers one gesture.
- **No-save Studio.** Every change lands on the map; "does this read *here*" is answered
  while it is asked.
- **One audience vocabulary.** Filled / hollow / ⚿ chips, click toggles, `Shift` solos —
  identical in HUD, Pinboard and Studio. Learn once, use everywhere.
- **The eye remembers.** Hiding stores the audience and un-hiding restores it. This is
  exactly right, and it is why S3 below is worth fixing: bulk paths do not honour it.
- **Per-client secrets.** `secret` blocks never reach a player's browser. The README says
  precisely what is and is not enforced. Keep that honesty in every new feature.
- **Accessibility and focus.** Roving tabindex, real grid/tab patterns, focus that
  survives re-renders. A GM running a session one-handed is well served.

---

## 2. Safety — things that can spoil a session

A tabletop truth the design documents get wrong in one place: **a reveal is not
reversible.** DESIGN §5.3 and the Pinboard header treat reveal and hide as "one keystroke
to undo", so neither asks. The pin can be hidden again; what the players read cannot be
un-read. Everything in this section follows from taking that seriously.

### S1 — The default contradicts the promise, and grants access on placement · confirmed

- `src/settings.ts:142` — `defaultAudience` defaults to `"everyone"`.
- `README.md:49` — "click to place. It stays hidden from players until you reveal it."
  DESIGN §1's acceptance test says the same.
- `defaultOwnershipSync` defaults to `true` (`src/settings.ts:152`), and `pinAt` runs
  `syncAnchor` immediately (`src/api.ts:247`).

**At the table:** a GM prepping during a session — or preparing next week's scene while
players are logged in — alt-drops "The Cult's Ledger" onto the map. Every connected
player sees it at once (and, on the DOM tier, through the fog — see S4), and the journal
is granted OBSERVER to `default`, so it lands in every player's sidebar.

**Fix:** default to `hidden`. The placement toast already says which state it chose
(`DP.ghost.placedHidden` / `placedVisible`), so a GM who wants the other default flips one
setting. If "everyone" is kept deliberately, then the README, DESIGN §1 and the onboarding
line must say so — and the ghost chip should show the audience in the warning colour when
it is "everyone" and players are connected.

### S2 — Revealing one page hands over the whole journal · confirmed (grant target), verify live (page inheritance)

- `src/data/ownership-sync.ts:156–175` grants on `pin.source.uuid`.
- A pin on a journal entry with a page chosen in Studio (`source.pageId`) still carries the
  **entry's** uuid, so the grant lands on the entry. A pin on a whole entry shows only its
  first page (`src/render/ContentResolver.ts:81`) but grants the entry too.
- Pages that inherit ownership (the default) become readable with it.

**At the table:** the GM pins page 3, "The Letter", of the journal "Chapter 3 — GM notes"
and reveals it. The players now have the chapter in their sidebar, forever (the sidebar
access outlives the pin by design — `DP.settings.defaultOwnershipSync.hint`).

**Fix:** when a page is chosen, grant OBSERVER on that page and at most LIMITED on its entry
(verify on 14.365 what the entry needs for the page to be reachable from the sidebar). Say
what will be granted where it is decided: in the Audience tab, "Players will be able to
open: *The Letter* (1 page)" or "…*Chapter 3* (12 pages)". The ledger already handles two
documents per anchor in `planRetarget`; this is a target change, not a new mechanism.

### S3 — "Reveal all" discards per-player audiences, and asks nothing · confirmed

- `src/apps/Pinboard.ts:1042` — the bulk reveal writes `kind: "everyone"` for every pin.
  The footer's "Reveal all" (`:465`) and the bulk bar's "Reveal to all" both go through it.
- The row's `Space` and the HUD's eye go through `toggleVisibility`, which restores the
  remembered audience.

**At the table:** a note for the rogue alone (`selected: [rogue]`) was hidden for a beat.
At the climax the GM hits "Reveal all" to light up the ritual glyphs. The rogue's private
note appears to everyone. The same pin, revealed with `Space`, would have gone to the rogue.

**Fix:**
1. Bulk reveal restores each pin's own remembered audience, exactly as the eye does. Rename
   "Reveal to all" to "Reveal" and keep an explicit "…to everyone" as a secondary choice.
2. "Reveal all" in the footer is the largest spoiler button in the module and sits one
   pixel from "Hide all". Either move it into the bulk bar's menu, or confirm when it would
   reveal more than one hidden pin ("Reveal 7 hidden pins to their audiences?"). This is
   the one reversible-looking action that deserves a dialog, because it is the one whose
   mistake cannot be undone.

### S4 — A revealed prop is visible through unexplored fog · confirmed (documented limitation)

The limitation is documented (`README` Known limitations 5, `DomPropTier.ts:10`). What the
documentation does not spell out is the consequence: on the DOM tier — every text prop on
every browser today — **"visible to everyone" means "visible from anywhere on the map"**,
floating bright over black fog and darkness. A GM cannot pre-place a revealed letter in the
next room; they must time every reveal by hand.

**Fix:** P1 below (visibility gated on sight) closes this for props that opt in. Two cheap
mitigations regardless: dim DOM cards by the scene's global darkness level (a CSS
`brightness()` from `canvas.environment.darknessLevel`, per client, re-read on
`lightingRefresh` — not per-light, but no more "bright paper in a black crypt"); and say in
the Studio's Audience tab, for a DOM-tier prop, "Visible through fog — reveal it when they
reach it."

### S5 — The ⚿ warning fires on props that read perfectly well · confirmed

- `src/api.ts:401–411` — `canUserOpen` tests OBSERVER regardless of mode.
- `src/apps/ReaderOverlay.ts:220` — a prop's reader opens for anyone in its audience,
  deliberately, whatever the ownership. `setAudience` already knows this and warns only for
  pins (`src/api.ts:292`).

So on a prop with access sync off, every chip shows the key glyph, the Pinboard's "Won't
open" filter lists it, and the footer counts it — for players who can read it. The GM's
natural response is to turn access sync on, which is what triggers S2. **Fix:** for a
prop, and for a pin set to *Read in place*, a player who can see it can open it. If the
sidebar half still matters, say that instead: "{name} reads it on the map; it is not in
their journal."

---

## 3. Features — the roleplay gaps

### P1 — Discovery: "visible when seen"

The data model has it (`audience.kind: "discovered"`, `sticky`), `canSee` handles it, and
`PinnedTile#isVisible` already runs a per-client line-of-sight test (`PinnedTile.ts:95`).
It is unwired (`audience.ts:68`) because persisting a discovery seemed to need a player
to write the pin, which DESIGN §3 forbids, or a socket, which §8 rules out.

There is a route that needs neither: **a player records their own discoveries on their own
`User` document** (`game.user.setFlag(MODULE_ID, "seen", […anchorUuids])`). Players may
update their own User (verify live on v14: flags on one's own User are writable by that
user), no pin is ever written by a player, and `updateUser` already triggers a pin refresh
(`main.ts:263`). `canSee` for a sticky pin reads the viewing user's own flag; the GM's
chips read every user's; the acting GM's client syncs ownership on `updateUser`, so access
is granted at the moment of discovery.

To build:
- Re-evaluate visibility on `sightRefresh` for the pins that use it — there is no sight
  hook today, so a token walking into view would not show the pin (`grep sightRefresh src`
  is empty).
- Offer two choices in the audience vocabulary: **"When seen"** (sticky) and **"While in
  sight"** (non-sticky, no writes at all). Both gate the DOM card too, which closes S4 for
  these pins.
- Show who has discovered it on the chips (a filled chip with a small eye).

This is the single feature an RP GM expects from "a letter lying on the floor", and most of
it is already written.

### P2 — Make the reveal a moment

The reveal is the moment the module exists for (its own comment, `PropManager.ts:688`),
and it is a fade.

- **Reveal sound is built and unreachable.** `playRevealSound` exists
  (`PropManager.ts:1124`) and is called on every reveal (`:663`). Every shipped preset has
  `sound: null`, and the Preset Studio has no control for it — nor for `reveal.animation`
  or `reveal.durationMs`. Add a "Reveal" group to the Preset Studio: animation, duration,
  sound (audio `FilePicker`, same-origin rule already enforced). Consider a per-pin override
  in the Studio, because "this one letter should arrive with a thunderclap" is a pin
  decision, not a preset one.
- **"Reveal & spotlight".** A verb (HUD, Pinboard, and `Shift+Space` on a row) that
  reveals, flashes, and pulls players' view to it. Core's ping can pull views for a GM;
  verify the option name on 14.365 (`canvas.ping(origin, { pull: true })` or
  `ControlsLayer#handlePing`). No socket needed: a ping already broadcasts.

### P3 — Hand it to the players in the module's own reader

"Show to players" calls `Journal.show` (`src/api.ts:465`), which opens **core's journal
sheet** on their screens. The paper, the torn edge, the wax seal, the glitch — everything
the GM chose — is gone at the one moment the players look closely. It is also missing from
the HUD (`PinHUD.ts:193–206`); it lives only in the Pinboard (`Shift+S`, row menu).

**Proposal:** a "Hand out" verb that opens the module's reader on each recipient's screen,
centred and upright, with the prop's effect at reader strength. It needs one message: the
anchor's uuid. Each client resolves and enriches its own copy, so `secret` blocks stay
stripped exactly as today. This is the case DESIGN §8 did not have when it said "no
sockets — there is nothing to broadcast": there is now, and it is one field. Add
`"socket": true` to `module.json`; keep `Journal.show` as the fallback when a recipient's
client has no reader. Put the verb on the HUD.

### P4 — "Reveal next": the order is a script, give it a play button

The Pinboard says "row order is reveal order… turns the list into a scene script"
(`Pinboard.ts:18`) and supports reordering from the keyboard. Nothing consumes the order.
Add **Reveal next**: reveals the first hidden row in order (to its remembered audience,
per S3), flashes it, and focuses the next one. Board key `N`, plus a global keybinding so
a GM can advance the script without opening the board. Cheap, and it makes an existing
claim true.

### P5 — Face-down: seen, but not yet read

Props always show their content to anyone who can see them. A table constantly wants the
state in between: *the envelope is on the desk, sealed*; *a folded note under the body*;
*a locked diary*. The object is visible, the text is not, until the GM (or a skill check)
opens it.

The module already has a word for this with nothing behind it on props: access level
**"Limited — a tease, they cannot open it"** (`DP.studio.syncLimited`) does nothing for a
prop, which reads in place regardless (S5). Proposal: a `display.concealed` flag (or map it
onto LIMITED) that draws the paper, the effect and the title, but no body, and makes the
reader say "It's sealed." Unsealing is itself a reveal (P2's sound and spotlight). The
"Sealed & Wax" preset finally means something.

### P6 — Typography

Every card is set in Signika (`styles/card.css:41`), which is Foundry's interface font. A
ransom note, a telegram, a royal decree and a terminal readout all look like the settings
dialog — the most common immersion break in a handout, and the easiest to fix.

`AssetInliner` already inlines every face in `CONFIG.fontDefinitions`
(`AssetInliner.ts:164`), including fonts a GM adds in core's Font Config. So a **Typeface**
choice — per preset, with a per-pin override in Appearance — is cheap. CRT Scanlines and
Projected Readout should default to a monospace; parchment to a serif. Bundling two or three
OFL faces (a hand, a typewriter, a blackletter) would give every world a good set with no
setup; check their licence file ships alongside.

### P7 — Documents with more than one page

A prop and its reader show one page; a whole journal shows its first. A diary, a dossier or
a case file is exactly what a GM wants to leave on a desk. Add page turning in the reader
(`←`/`→`, a page indicator), limited to pages the player may read, and let the Studio choose
which pages travel with the pin (default: the chosen one).

### P8 — Where sources come from

- The picker lists world journals only (`DocumentPicker.ts:43`). Published adventures ship
  their handouts in compendiums; a drag from a compendium works (limitation 7), but the
  picker and `/pin` cannot find them. Add a lazy compendium index search.
- Actors and Items are scoped out as "a later adapter" (DESIGN §1.1, continuation brief).
  A wanted poster built from an Actor (portrait, name, a line of text) and an item card
  ("you find…") are the two props tables ask for most after letters. Worth scheduling.

---

## 4. Ergonomics — polish

**E1 — "Pin" means two things.** It is the module's noun for everything *and* one of the
two shapes: "Switch the selected pins between pin and prop", "Shrink to a pin", "Pin — a
small icon". Rename the shape to **Icon** and keep *pin* as the thing: "Switch between icon
and prop", "Shrink to an icon". About fifteen strings in each language and the README.

**E2 — Nine surfaces, no map.** Ghost, HUD, Pinboard, Pin Studio, Preset Studio, reader,
picker, tile/note config, chat — and roughly twenty-five shortcuts across three scopes, of
which the ghost's `E V R F` and the board's `L O M F` cannot be rebound. The ghost legend is
the only self-teaching surface and it can be switched off. Add a `?` cheat sheet reachable
from the ghost, the board and the HUD, listing the keys of the surface it was opened from,
in the platform's names (`ui/modifiers.ts` already does the naming).

**E3 — The HUD's verbs.** Live-play surface, nine buttons: eye, audience, effect, **lock**
| shape, fit, open for me, flash, gear. Lock is a prep verb and Fit is a layout verb; "Hand
out" (P3) and "Reveal & spotlight" (P2) are the verbs a GM reaches for mid-scene and are
absent. Suggested order: eye · audience · hand out · spotlight | effect · shape · open for
me · gear; move lock and fit to the Studio strip (they are already there).

**E4 — The Studio edits in front of the table.** `submitOnChange` (`PinStudio.ts:595`) is
right for prep, but on a revealed prop the players watch the GM cycle papers, sizes and
effects — the lesson the Pinboard already learned for its effect button (0.3.3 changelog).
Show a banner in the Studio header when the pin is revealed: "Visible to 4 players —
changes are live", with a one-click "Hide while I edit" that restores the audience when the
Studio closes.

**E5 — The Content tab mixes two questions.** Source, page, label, follow-name and title
are *what it is*; **Opening** and **Tooltip** (`PinStudio.ts:234–242`) are *how players
interact with it*, and Tooltip is an unlabelled free-text field with no hint. Move both to
the Audience tab, rename that tab **Players**, and give Tooltip a hint ("Shown when a player
hovers it. Empty uses the pin's name.").

**E6 — Settings for engineers sit beside settings for GMs.** *Texture memory budget (MB)*,
*Console detail*, *Prop rendering* and *Reduce detail automatically* are in the main list
beside *Default visibility*. Keep the table-facing five on top and move the rest into an
"Advanced" submenu (the module already registers one menu for the Preset Studio).

**E7 — Current scene only.** The Pinboard cannot answer "where did I pin the ledger?" A
prep-time "All scenes" scope, and a count on the journal sheet's *Pin to scene* header
button ("Pinned on 2 scenes"), would answer it.

**E8 — What's new is for the table.** The 0.3 dialog spends one of three bullets on
"Firefox is a supported browser" (`onboarding.ts:25`). Keep those bullets to things a GM
will do differently tonight.

**E9 — Players have three affordances** (hover, click, `Alt` peek) and nothing to keep. A
"Handouts" list for a player — every pin they have been shown or discovered, re-openable in
the reader — follows directly from P1's per-user flag and makes clues survive the session
without granting sidebar access.

---

## 5. Suggested roadmap

| Release | Theme | Items |
|---|---|---|
| **0.3.4** | Safe by default | S1, S3, S5, E4 banner, README/DESIGN wording on S4 |
| **0.4.0** | The moment | P2 (reveal group, spotlight), P4 (reveal next), P6 (typeface), E1, E3 |
| **0.5.0** | Discovery | P1 (when seen / while in sight, sight refresh, DOM gating), S2 (page-level grants), P5 (face-down) |
| **0.6.0** | Hand-outs | P3 (socket, reader hand-out), E9 (player handouts list), P7 (pages) |
| Later | Reach | P8 (compendium search, Actor/Item adapters), E2 cheat sheet, E6, E7, darkness dimming |

**A bold bet, for later:** investigation games (Call of Cthulhu, Delta Green, Blades) live
on evidence boards. Props already lie on the map; a "connect with string" gesture that draws
a core Drawing between two props, and a Pinboard view grouped by connection, would make
this *the* module for mystery campaigns.

---

## Appendix — verify live before building

| Item | Question |
|---|---|
| S2 | On 14.365, what must the entry's ownership be for a player with OBSERVER on one page to open that page from the sidebar and from a pin? |
| P1 | Can a player write flags on their own `User` document on v14 without GM help? Does `sightRefresh` fire on every token move that changes vision, and on the player's client? |
| P1 | Is there a per-client "explored" test (`canvas.fog`) cheap enough to gate a sticky pin without any write at all? |
| P2 | The option that makes a GM's ping pull every player's view, and whether it is available to module code. |
| P3 | Socket round-trip on a world with a player on the DOM tier and one on a PDF canvas tier: does the reader open on both? |
