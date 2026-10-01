# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **A letter no longer glows in a pitch-black crypt.** Text props are drawn over the map
  rather than into it, so core's darkness never reached them: bright paper floated over
  every night scene. They now darken with the scene's darkness level, and follow it when
  it changes — except on the Projection stock, which is light rather than paper and stays
  as bright in a dark room as in a lit one. Lights and fog still do not reach them, so
  Pin Studio's Audience tab now says, on every text prop, that it shows through
  unexplored fog — reveal it when the party gets there.
- **A ransom note no longer looks like the settings dialog.** Every card was set in
  Foundry's interface font. A prop can now have its own typeface — serif, sans serif,
  typewriter, handwriting, or any font the world has, including one added in Font Config —
  from Pin Studio's Appearance tab, and a preset can carry one in the Preset Studio's new
  *Type* group. It holds with effects switched off, and *Fit to content* measures in it.
  A shared preset can only name a face this way; anything else is refused with a warning.
- **The wax seal can crack as the letter appears.** Every preset was silent and nothing
  could change it, and every duplicated preset arrived with its ancestor's fade. The
  Preset Studio's new *Reveal* group sets an effect's arrival — none, fade or materialise
  — its duration and its sound, with a file browser and ▶ to hear it; Pin Studio can give
  one prop a sound of its own. Each player hears it as the prop appears on their screen, at
  their Environment volume, once however many props arrive together. A sound must be a
  file on your own server: a shared preset naming a web address is refused on import, so
  it cannot report your table's reveals to anyone.
- **Reveal next: the Pinboard's order plays.** Row order has always been reveal order, and
  nothing used it. `N` on the board — or the footer's button, which names the pin before
  it goes out — shows the first hidden row to the players it remembers, points at it, and
  moves the list on; the footer says what went out and how many are left. It follows the
  board's filter, search and level, and never hides anything. *Reveal the next hidden pin*
  does the same from anywhere — through the board when it is open, with a notice when it
  is not — and ships without a key, for you to give it one in Configure Controls.
- **Reveal & spotlight.** One gesture reveals a pin to the players it remembers and brings
  the table to it: when the pin is for everyone, every player's view glides there. For a
  narrower audience nobody's view moves — a Foundry ping reaches every player, and would
  show the others where a private clue lies — and you are told so. On the HUD, as
  `Shift+Space` in the Pinboard, and in the Pinboard's row menu.
- **Pin Studio says when the table is watching.** Every control saves as it moves, so on a
  revealed pin the players watched each paper, size and effect you tried. Above its tabs
  the Studio now says how many players can see the pin, and offers *Hide while I edit*:
  the pin hides at once, and comes back to the same players when you close the Studio or
  click *Reveal again*. A pin you reveal or hide again by hand meanwhile is left as you set
  it, and one hidden when the page reloaded comes back the next time the world loads.
- **`?` shows the keys.** Some twenty-five shortcuts across the ghost, the Pinboard and the
  HUD, and the only one that taught itself was the ghost's legend, which can be switched
  off. Press `?` while placing, on the Pinboard or on a pin's HUD — or click the `?` on the
  last two — and that surface's keys are listed in your keyboard's own names, ⌘ on a Mac,
  with every Configure Controls binding shown as you set it and *Reveal next* as unbound
  until you give it a key. Escape or a click anywhere else puts it away.
- **Pin the handouts your adventure ships in a compendium.** *Pin a document* and `/pin`
  now search the journals of every compendium once you have typed two letters, after your
  world's own, each row labelled with its pack. A compendium your players' role can open
  is pinned as it is. One that some player cannot open is greyed, and offers *Import &
  pin*: the journal is copied into a "Documents Pinner" folder and the copy is pinned, to
  be shared like any journal — choosing it again pins the same copy. A page of a
  compendium journal is chosen afterwards in Pin Studio, which now lists them.
- **Pin a wanted poster: the bandit's portrait, his name and the bounty line from his
  biography.** An actor or an item can now be pinned as a journal is — from its context
  menu in the sidebar or a compendium window, its sheet's header, *Pin a document* or
  `/pin`, and an item also by the modifier drag. The prop is a portrait card on the same
  paper, with the same effects: its picture — an actor's portrait, else its token's — its
  name, and the text you choose in Pin Studio's *Text shown*, which lists every rich-text
  field your game system gives that kind of actor or item. *Automatic* prefers public
  text, then a biography or a description, and never a field named for the GM; secret
  sections reach only the document's owners and you. Its icon opens its sheet. *Pin a
  document* gains chips — All · Journals · Actors · Items — and searches the world's
  actors and items after its journals, then every kind of compendium; one some player
  cannot open offers *Import & pin* into a folder of its own type. An item an actor owns
  and a token's own actor cannot be pinned, and a drop of one says so.

### Changed

- **The small shape is called an icon.** *Pin* named both the thing you place and one of
  the two shapes it can take, so the HUD offered to "Shrink to a pin", a key switched "the
  selected pins between pin and prop", and the Pinboard filtered its list of pins by
  *Pins*. The shape is *Icon* now — in the HUD, the Pinboard's column and filter, the
  placement legend, Pin Studio, the *Default shape* setting, Configure Controls and the
  README, and *icône* in French. A pin is still the thing itself, whichever shape it takes.
  Nothing stored changes, so every pin and the setting keep their shape.
- **CRT Scanlines, Projected Readout, Tagged and Signal Loss now type in monospace, and
  Aged Parchment and Sealed & Wax in a serif.** A terminal set in the interface font read
  as a letter held up to a lamp. Generic faces only, so they look right in every world
  with no font installed; a pin that should keep the old face can choose it in Pin Studio.
- **Pins are stored in format 5 and presets in format 3, for the typeface, the reveal
  sound and the text an actor's or an item's card shows.** Opening a scene updates its
  pins silently and the rest of the world is offered once, as before; nothing changes on
  any map. A preset exported from this version and imported into an older one is reported
  there as newer, and loses only its typeface.
- **"Reveal all" asks first, and has left the footer.** It sat one button from "Hide all",
  and it is the one reveal whose slip is a whole scene's worth of spoilers — hiding again
  does not take back what the table has read. It is now in the bulk bar, apart from the
  selection's own verbs, asks before it shows more than one pin, naming how many, and is
  greyed out when nothing on the scene is hidden. The bulk bar's "Reveal to all" is now
  "Reveal".
- **The HUD keeps to the verbs of the moment.** On the left: reveal, who can see it, and
  spotlight; on the right: effect, shape, open for me, flash, Pin Studio and `?` for the
  keys. Lock and *Fit to content* have left it for Pin Studio's strip, where both already
  were; Fit is still `Alt+Shift+F`.
- **A player who cannot open a compendium sees a placeholder that says why — and you are
  told first.** A pin on a compendium document shows to the players whose role can open
  that compendium. Pointing one where some player cannot — by an Alt-drop, a menu or Pin
  Studio — now warns you, naming the pack. Their card and reader say the document is in a
  compendium they cannot open, where they used to say it no longer existed, and their
  client no longer asks the server for it. "Show to players" reaches only the players who
  can open it, and says when that leaves someone out. A PDF page from a compendium is
  always drawn as a card.
- **Revealing an actor shares it at Limited at most, and a new actor pin starts with access
  off.** Observer would open an NPC's whole sheet, stats included, so a reveal never grants
  more than Limited, and the Audience tab offers Limited alone and says that what a
  Limited sheet shows is your game system's choice. The poster reads in place without any
  access, so granting it — which lists the actor in your players' sidebar — is yours to
  switch on, pin by pin; a pin pointed at an actor from Pin Studio switches it off and
  says so, and starts again on the automatic text. *Show to players* opens journals only:
  the Pinboard no longer offers it on an actor's or an item's row, and `Shift+S` says so
  rather than claiming it was shown.
- **Alt-dragging an actor still places Foundry's hidden token.** Alt is the default drag
  modifier, and Foundry already uses it on actors; an actor is pinned by dragging only
  when the modifier is Ctrl or Shift, and the setting's hint says so. With no modifier
  set, an actor drag still places a token. Items take the modifier as journals do.

### Fixed

- **A glance at another browser tab no longer shrinks every prop on the map.** The frame
  rate the module watches counted the seconds a hidden tab draws nothing as slow frames,
  so a player back from their character sheet was told pins were costing too much, and
  every prop dropped a detail level for the rest of the scene — the smallest vanished. A
  pause is no longer counted, and one slow second — a scene loading, say — no longer
  trips it either: it now takes two in a row.
- **Effects on *Auto* no longer switch off and on by themselves.** A machine running near
  40 fps read as slow on one pass and fast on the next, so motion stopped and started and
  every card on the scene was redrawn at each flip. Once *Auto* has reduced the effects,
  it now waits for the frame rate to climb clear of the line — 46 fps at the default cap —
  before bringing them back.
- **A text prop could go back to what it said before the scene redrew.** A card still
  being prepared when the scene was drawn again — switching the viewed level does that —
  could land on the new card for the same prop and stay there, with the older text, until
  something else changed. It is dropped now.
- **Alt-Tab no longer leaves every prop faded.** A player holding Alt to peek who switched
  to another application let go of Alt there, where the page never heard it, so the props
  stayed see-through on their return until Alt was pressed again. The peek now ends when
  the window loses focus.
- **Editing a preset in the Preset Studio now changes the props that wear it.** A saved
  edit reached no prop on the map, on any client, until something else made it redraw — a
  zoom across a detail level, an edit to the prop, a reload. Every client redraws them as
  you save. Changing *Prop rendering* or *Effect level*, or lowering the *Texture memory
  budget*, likewise takes effect at once instead of at the next pan.
- **Placing a pin on a gridless or a hex map no longer jumps in square steps.** The ghost
  snapped to half a square of a grid the scene does not have: on a gridless map it moved
  in 50-pixel steps, and on a hex map it landed between the hexes, unless you held the
  free-placement key. It now follows the pointer freely on a gridless map, and snaps to
  the hexes' centres, corners and edge midpoints on a hex map.
- **"Reveal all" showed a private note to the whole table.** A pin narrowed to one player
  and hidden for a beat went back to that player when revealed with `Space` or the eye —
  and to everyone when revealed from the Pinboard's bulk bar or "Reveal all". Every reveal
  now restores the audience the pin remembers.
- **Flashing a hidden pin did nothing.** It is drawn on your screen alone, so players are
  not shown where it is — and it was sent without the scene Foundry needs to draw it. It
  shows now. A flash also no longer pulls every player's view to the pin when Shift
  happens to be held.
- **Revealing one page handed over the whole journal.** Access was granted on the journal
  whatever page the pin showed, and every page that inherits its permissions — every page,
  by default — went with it, into the players' sidebars, for good. A pin showing one page
  now grants that page, and lists its journal as Limited so the page can be reached; a pin
  on a whole journal still shares the whole journal. The Studio's Audience tab says which
  a reveal will do. Grants an earlier version made are narrowed the next time the world
  loads, and the GM is told how many.
- **Choosing another page in Pin Studio left the access on the old one.** The grant moves
  with the page now.
- **A prop revealed without granting access showed a key on every chip.** The key means
  "can see it but cannot open it", and a prop opens in the module's reader for anyone who
  can see it, whatever the permissions say. The Pinboard listed those props under "Won't
  open" too, and the natural fix — turning access on — granted a journal nobody needed.
  Props, and pins set to read in place, now show a key only when it is true. A player who
  holds the journal while the pin is hidden from them is still flagged.
- **The README said a new pin stays hidden until you reveal it.** It is visible by default
  — that is the *Default visibility* setting — and the README now says so, and how to
  change it.
- **A compendium pin said one thing before its card was drawn and another after.** A pin
  on a compendium page was labelled "Pin" and its Pinboard icon read as missing; the key
  glyph sat on the wrong chips; a PDF page was a card, then a texture. Foundry answers for
  a compendium document differently once it has loaded it, for five minutes. A compendium
  pin is now read from its pack throughout, and names its page once the page has loaded.
- **"Pin to scene" in a compendium window did nothing**, and nor did it on a page inside a
  compendium journal's sheet. The row was looked up among the world's journals, where a
  compendium's are not. It pins the compendium's journal, or that page, now.
- **Pin Studio said "No source" for a page from a compendium**, and listed no pages to
  choose from for a compendium journal. It names the page and lists them.
- **The Audience tab said revealing a compendium document "shares the whole journal".** A
  compendium's permissions are per role and pack-wide, so a reveal grants nothing and adds
  nothing to anyone's sidebar, and the tab now says so.

## [0.3.3] — 2026-09-30

A UX pass. A review of every surface — the HUD, the Pinboard, both Studios, placement, the
reader and the hover tooltip — found places where the module's own rules were applied in
one window and not the next. This release fixes the medium and minor findings, and one
of the serious ones.

### Fixed

- **"Some players" chosen in Pin Studio with nobody picked hid the pin from everyone,
  while the Pinboard said it was visible.** The pin reached no one; the Pinboard counted
  it as visible, the HUD's eye stayed open, and every chip under it was hollow. The HUD
  always refused this. The Studio now does too: it asks for a player, or takes back the
  selection the pin remembers from before it was hidden. A pin already in that state now
  shows as hidden everywhere.
- **Pin Studio and Preset Studio lost the keyboard focus after every change.** A slider
  moved with the arrow keys could be moved one step; a GM tabbing down the form was sent
  back to the window after each field. The focus now stays where it was, and a half-typed
  label survives a change made elsewhere. Only the Studio of the pin that changed
  re-renders now, not every open one.
- **You could not zoom or pan while placing.** The wheel rotated and every right press
  cancelled, and a right-drag is how Foundry pans. `Ctrl`/`⌘`+wheel (or a trackpad pinch)
  zooms, a right-drag pans, and a right click still cancels.
- **Holding Shift for a fine rotation turned the next click into "keep placing".** A
  Shift already used on the wheel, or to step back through the effects, now places once.
- **The reader closed at the start of every pan.** It closed on any press beside it,
  including the right-drag that pans and a drag of a token. It closes on a click now.
- **The reader opened at the angle the prop lay at.** A letter dropped at 20° was read
  at 20°. The reader now turns upright as it opens and back as it closes.
- **Glitch, jitter, flicker and the moving scanlines kept running in the reader.**
  Glitch's colour fringe doubled every letter. In the reader the motion stops, the fringe
  goes, and the textures and the projected overlay sit at half strength. The prop keeps
  the full effect.
- **An open Pinboard kept the last scene's pins.** It now follows the scene being viewed
  and drops the old selection. Pin Studio's "Find on the map" for a pin on another scene
  views that scene first, instead of panning this one to the other's coordinates.
- **Flash and Locate were hidden under text props.** A ping is drawn inside the canvas
  and a text prop's card is drawn over it. The card now pulses on the GM's screen.
- **"Show to players" said nothing.** On a hidden pin it did nothing at all; now it says
  there is nobody to show it to, and says how many players it reached when it works.
- **The Pinboard's shortcut line printed ⌥ ⇧ ⌃ to everyone.** It now names the keys as
  the keyboard does, and says ⌘ on a Mac, where ⌃-click is a right-click. The placement
  legend says ⌘ there too.
- **The picker's hint said Enter takes the first match.** It takes the highlighted row.
- **Page types showed untranslated** ("text", "pdf") in the picker and in Pin Studio.
- **The welcome dialog's "Later" never came back.** It says "Not now", and where the
  tools are.

### Added

- **A pin's icon.** Every document pin was the same book. Pin Studio offers core's
  map-note icons or any image, and the icon survives pointing the pin at another
  document.
- **Hovering a pin names it**, as a map note shows its label, and tells a player whether
  it opens on a click or a double-click.
- **A one-time tip for players** about holding `Alt` to see through props — the one key
  they have, which nothing in the game mentioned.
- **"Use on this pin" in the Preset Studio**, when it was opened from a pin. A preset
  duplicated and tuned from a pin's gallery can now be put on that pin from where it was
  made.

### Changed

- **"Show to players" in the Pinboard is `Shift+S`.** It is the one verb there that
  reaches the players' screens and cannot be taken back, and a bare `S` is what a GM
  types expecting to jump to a row.
- **The Pinboard's effect button opens a menu** of every preset, drawn as itself. It used
  to step to the next preset per click, a save each time, visible to the table on a
  revealed prop. Menus near the foot of the list open upward and scroll.
- **The Preset Studio groups its parameters by layer** — paper, edges, glow, lens,
  scanlines, overlay — each open when the preset uses it.
- **Sliders say their unit.** Intensity and the faded opacity are percentages in the
  Studio as in the HUD; text size, margins and speed say px, em and ×.
- **Pin Studio's title names the pin**, and its tabs are one tab stop moved with the
  arrows.
- **Tooltips are Foundry's own** instead of the browser's, on the HUD, the Pinboard and
  the chips.
- **The mismatch badge is a Font Awesome key.** The ⚿ character is missing from most
  interface fonts.
- **Pinboard rows show what they point at** — a journal, a page, a PDF, an image, or a
  missing document — instead of the same book on every row. Their avatar chips are 24 px,
  and the list is a grid a screen reader can move through.
- **The HUD's eye states itself in its label only**, not also as "pressed".
- **Accent and warning text is derived from the theme's text colour**, so it keeps its
  contrast in Foundry's light theme.

## [0.3.2] — 2026-09-30

A reliability pass. Three audits: one checked every Foundry API the module relies on
against the 14.367 source, one checked the runtime for timing and state faults, and one
checked the cost of every path that runs per frame or per event. The permissions
findings were then confirmed by running v14's own document-update code.

### Fixed

- **Hiding a pin could leave players able to open its journal.** With ownership sync on,
  revealing a pin grants players access to the journal, and hiding it is meant to take
  that back. On v14 that failed three ways:
  - **Most releases were refused outright.** Hiding a pin removes the player's entry from
    the journal's permissions. v14 refuses that kind of write and drops the whole update,
    with an error about permissions that never named the module. This was the usual case: a player
    who had no entry of their own before the pin.
  - **v14 rewrote the grant record's keys on every save**, so hiding a pin could not find
    the grant to undo.
  - **A record that only lost a player was wiped.**

  Releases are now written the way v14 accepts: the whole permission list at once, as
  core's own permission dialog does. The grant record is stored in a form every Foundry
  version saves exactly as written. Records already in a world are read correctly and
  rewritten the first time they are used. **Check the permissions of journals you
  revealed and then hid on v14:** a grant whose release was refused, or whose record was
  wiped, cannot be found automatically.
- **Cards drawn over the map lagged one step behind a zoom.** They are the cards every
  text prop uses on current browsers. After each mouse-wheel notch they sat at the
  previous zoom until the next pan. The module read the map's transform before Foundry
  had recomputed it.
- **Editing a pinned journal did not update its card on the map.** The reader showed the
  new text; the paper on the map kept the old one on every client until a zoom crossed a
  detail boundary.
- **Changing who can see a pin did not show or hide its icon.** Core re-checks
  visibility only when `hidden` changes, and a pin's audience is stored elsewhere. The
  player just removed kept seeing an icon they could not open, and the player just added
  saw nothing.
- **A reader stayed open after its pin was hidden** from the player reading it.
- **A notice said pins were too costly on clients with a frame-rate cap.** At core's
  "Maximum framerate" of 40 or below, or under Chrome's energy saver, the detail guard
  fired on every scene: a warning, and every prop drawn one level coarser. It now
  compares against the client's own cap and stays quiet on scenes without props. The
  automatic effects level had the same fault, and at a cap of 40 it switched level back
  and forth, re-drawing every card each time.
- **One broken enricher from another module blanked a card and silenced its reader.** If
  enrichment fails, the card now shows the text unenriched. It goes through the same
  sanitiser, so GM secrets are still stripped.
- **A card that failed to draw once stayed blank for the session.** The next pass
  retries it.
- **A refused placement disabled placing for the rest of the session.** It now says it
  failed, and the next click tries again.
- **The GM's shortcut onto a pin from the Notes layer followed the layer switch one step
  late.** Arriving on Notes built nothing, and leaving it left the shortcut on Tokens and
  Walls. A press there then switched to Tiles in the middle of a rubber-band select or a
  wall. The press is also handled now, so the canvas no longer closes the HUD it just
  opened or releases the pin it just selected.
- **A pin's warm light and tooltip got stuck on** when the hit areas were rebuilt under
  the pointer, and a token dragged across a prop no longer lights it up on the way.
- **An image dragged from Foundry's file browser was not pinned by an Alt-drop.** It
  fell through to core and became a plain tile.
- **Rendered PDF pages were never released.** Every size a page was drawn at, and every
  reader opened on one, stayed in memory for the session. At most eight are kept now,
  and all of them are released when the scene changes.

### Removed

- **A sweep that could delete other people's Notes.** 250 ms after an Alt-drop it
  deleted "any Note that appeared", though core never makes one from that drop. It
  could only ever find someone else's. After a scene change inside that window it
  deleted every Note on the new scene.
- **The "hit areas go dead during a drag" mechanism, which never ran.** It listened for
  hooks core does not fire. The one visible effect it was meant to have, no hover during
  a drag, is now done differently.

### Changed

- **Deletions are written the v14 way.** The `-=key` form logged a compatibility warning
  on every write, and v16 removes it. Permissions use a whole-list replacement and flags
  use `ForcedDeletion`. A permission change made in core's dialog is now recorded when it
  happens: the dialog sends the whole list, and a removed player, who is simply missing
  from it, used to read as "no change". The context-menu entry, the HUD's hide and
  the journal "show" call also moved off APIs v14 deprecates.
- **Development toolchain:** vitest 5, eslint 10, jsdom 30.1; `npm audit` reports nothing.
  The module still has no runtime dependencies.
- **The test double for `Document#update` models v14 instead of v13.** It covers how
  saves are validated, how changes are compared, and how nested keys are expanded. The
  old double is why the permissions fault above passed every test. Under the new one,
  the 0.3.1 ownership code fails most of the ownership tests.

## [0.3.1] — 2026-09-30

### Fixed

- **Players could not open a pin or a prop at all.** A v14 canvas layer starts with its
  children switched off for the hit test, and the layer that carries the players' hit
  areas never switched them on. So a player's click went through to the map underneath,
  and a document pinned for the whole table could be read by nobody but the GM. The GM's
  shortcut onto a pin from the Notes layer was dead the same way. Measured on 14.367: the
  hit area was in the right place and never reached. The layer now switches them on
  every time it rebuilds.
- **A long document in the reader scrolled only while the pointer was over its text.**
  The text is the one part of the reader that scrolls. The title, the margin around it
  and the close button do not, and a wheel over any of them did nothing, so the same
  reader scrolled or not depending on where the pointer rested. The wheel now scrolls
  the text from anywhere over the reader, and a mouse that reports lines is read as
  lines. While the reader has focus, the arrow, Page Up/Down, Home and End keys scroll
  it instead of panning the map underneath.

## [0.3.0] — 2026-09-02

Three asks in one release: choose which page a pin shows, run the module in Firefox, and
an augmented-reality effect family. The pin payload is version 4 and the preset payload is
version 2; both migrations are invisible on any map.

### Added

- **Choose which page of a journal a pin shows, and which page of a PDF.** The field for
  it has existed since v1 and nothing ever wrote it, so a pinned journal always drew its
  first page and a multi-page PDF always drew page 1. Both are now in the Pin Studio's
  Content tab, and opening the pin lands on the same page. Choosing a page that is a PDF
  also moves that pin onto the canvas tier, where it is lit, fogged and occluded like the
  map itself — that part needed no new code at all.
- **Change which document a pin shows, without losing the pin.** Re-pointing meant
  unpinning and re-adopting, which reset the mode, the geometry, the effect, the
  interaction and the audience. "Change document…" keeps all of it and moves only the
  source and the access it granted, releasing the old document's grant as it goes.
- **An augmented-reality effect family: Projected Readout, Tagged and Signal Loss.** The
  first draws the document as light on a new translucent Projection stock; the second
  leaves the paper as paper and marks it, the way a visor would; the third is the same
  overlay degrading. What makes them subtle is one rule applied three ways — static
  geometry plus exactly one slow-moving thing, and no border at all, so the panel's extent
  is implied by corner marks and a grid rather than drawn.
- **The Preset Studio can edit colours and shapes**, not only numbers. It had no control
  for any colour or any enum, so the edge shape and the frame style had been uneditable
  since they were added and a duplicated preset could not be recoloured.
- **A stated browser baseline, and a test that holds it.** Chrome 120 and Firefox 129 —
  ESR 140 yes, ESR 128 no. `tests/css-baseline.test.ts` fails when a stylesheet reaches
  past it, and also when the effect system emits a custom property or a data attribute
  that no rule reads.

### Fixed

- **Three selectors were Sass, not CSS.** `&--left`, `&--right` and `&--missing` are
  parent concatenation, which native nesting does not have, so the rules were invalid and
  dropped — in every browser, since the day they were written. Neither HUD column had a
  grid area; the layout worked only because the name between them is placed explicitly.
  The Pinboard's missing-thumbnail placeholder was never centred.
- **The scanlines were invisible on three shipped presets.** The texture stack composited
  with the tint's blend mode, and every layer in it is dark: black under `screen` is the
  identity operation, so CRT Scanlines, Holographic Frame and Glitch lost their scanlines
  on the HTML tier while a PDF kept them. One preset, two tiers, two different pictures.
- **Coarse-tier props kept animating.** The rule that stops motion at a distance matched
  the card and not its pseudo-elements, where the scanline roll and the glow pulse
  actually live — so they ran on in exactly the size band where a scene has the most
  props. The reduced-motion net had the same hole, for the same reason.
- **A reduced-motion client saw the full animation until the first level pass.** The
  stylesheet's own guard was a custom property that no rule anywhere read, while two
  comments described it as the gate every animation runs through. There is now a real
  `prefers-reduced-motion` media query.
- **The reader's settle and the HUD palette's fade depended on when the browser happened
  to flush style.** Both were primed by a single `requestAnimationFrame`, which is not a
  specified moment: the palette animated only because the `focus()` call on the next line
  forced a recalculation. Both now declare their starting style.
- **A PDF prop's inert controls were dimmed by CSS and disabled by nothing.**
  `pointer-events: none` does not stop a keyboard reaching a slider, in any engine.
- **Renaming the page a pin had chosen redrew nothing**, and opening a pin whose chosen
  page had been deleted asked the sheet for a page that was not there.
- **A re-sourced pin could leave a player holding access forever.** The ledger sweep's
  only test was "the anchor no longer exists", which was the same question as "this grant
  is stale" only while a pin's source could not change.
- **No effect ever reached a prop drawn INTO the scene.** The rasteriser inlines its own
  stylesheet into an isolated SVG document, and it inlined only the paper — every rule
  that paints a tint, a stain, a frame or the new overlay lives in another file that never
  travelled with it. A prop rasterised with a full dressing and nothing that consumed any
  of it. Masked until now because journal props never reach that tier at all.
- **Clearing the width or height field made a one-pixel tile.** An emptied number input is
  a GM part-way through typing, not a request.
- **A preset whose overlay colour was three or eight hex digits broke its own PDF.** The
  zero-alpha form was built by appending "00", which is a valid colour for exactly one of
  the three shapes the schema accepts — and an invalid one throws out of `addColorStop`,
  aborting the bake so the page lost its frame and its edge mask too.
- **A grid at the schema's finest pitch could freeze the canvas for a fifth of a second
  per prop**, synchronously, inside the queue that draws every other one.

### Changed

- **Pin payload version 4.** `source.pageId` is strictly a journal page's id and
  `source.pdfPage` is the page of a PDF: one field held both meanings, and "page 4 of the
  journal, and that page is a PDF, at its page 7" is a sentence it could not hold. A
  number found in the old field is folded into the new one when the payload is READ, not
  when it is migrated, so a player's client behaves correctly before the sweep reaches it.
- **Preset payload version 2**, for the overlay parameters. Every preset written before it
  renders byte-identically, and a preset from a newer version still degrades rather than
  being rejected.
- **A preset may name the paper stock it is drawn on**, and applying it brings that stock.
  Projected Readout on parchment is a tinted sheet of paper rather than a projection. The
  value is checked against the known stocks, so a preset pasted in from a stranger can at
  worst print a legible card on a different paper.
- **Firefox is a supported browser and says so.** Measured by hand in Firefox 155 against
  a live world and a local harness, not reasoned about.

## [0.2.2] — 2026-09-01

### Fixed

- **The paper and the tile were half a card apart.** On v14 a Tile's stored point is its
  centre, and the module read it as the top-left corner everywhere it placed anything:
  the card, the reader, the tooltip, the players' hit areas, the pan target, the ping,
  the line-of-sight test and the ghost's own placement. So a text prop showed no resize
  handle (it was under the paper), a dragged prop trailed a white book (core's preview,
  where the tile actually was), and a player's click landed half a card off. One helper
  now owns the conversion, every site goes through it, and the first drawn tile of every
  scene is checked against core's own bounds so a future change is said out loud in the
  console rather than shown on the map. Existing text props are re-anchored once, so the
  paper stays exactly where it was and the frame joins it; PDFs and pin-mode icons, which
  core drew at the point, do not move.
- **Drag the paper, not the book.** Core's drag preview is a clone drawn from the
  placeholder texture. It now shows nothing on the DOM path, where the card follows the
  clone, and the original's own page for a PDF.
- **The selection frame and the resize grip are drawn on the paper.** Core draws them
  under the card, which is opaque. The card now redraws both in the same rectangle, in
  core's own selection colour, and the press still reaches core's handle.

### Changed

- **Fit to content and Reset size keep the top edge where it was.** A resize grows the
  sheet down and to the right in its own frame, as core's corner grip does, instead of
  about its middle. The pin payload is version 3; the payload itself is unchanged.

## [0.2.1] — 2026-09-01

### Fixed

- **The Studio's and the HUD's effect galleries overflowed their buttons.** Core gives
  every `<button>` a fixed height and a centred flex row, and the swatch buttons declared
  neither, so each preview and cost label painted over the row below and every HUD swatch
  name was cut to three letters. The buttons now declare their own layout. Also in the
  Studio: slider readouts sit beside their sliders instead of wrapping underneath, the
  placement strip is two deliberate rows — the geometry, then the verbs — and the window
  opens tall enough to show the gallery.

## [0.2.0] — 2026-09-01

The resize release, and a product pass over every surface a GM and a player touch.
The pin payload schema is now version 2; the migration changes nothing on any map.

### Added

- **Resize a prop to show more or less of its document.** A prop used to be a zoom: its
  type size followed the tile, so a bigger prop was the same words, larger. It is now a
  window: the type size belongs to the pin, and growing the tile shows more lines.
  Existing props keep exactly the size they are drawn at — the migration writes down the
  number each one already had. The card follows core's resize handles live, and text
  that does not fit fades into the paper at the bottom edge instead of cutting off
  mid-line, in both rendering tiers.
- **Text size and Margins in Pin Studio**, in place of the padding fraction; **Fit to
  content** and **Reset size** in the Studio strip, the HUD and `Alt+Shift+F`; **width
  and height in grid squares** with a ratio lock, beside the rotation. The placement
  ghost previews the real page at the chosen text size, `Shift+Alt+wheel` sets it, `F`
  fits, and the choice is remembered per client.
- **Click a pin on the Notes layer to grab it.** A press on a prop from the layer the
  module's tools leave you on switches to the Tiles layer and selects the pin, so the
  next press drags; a double click opens it; a hover shows the tooltip the GM authored and
  could never see. The "Move and resize pins" toolbar button is gone with the detour.
- **The reader fits the screen.** Opening a prop brings the view in when its text is too
  small to read, never on close; a pin set to read in place opens as a natural-size sheet
  rather than a box one grid square wide; a click on the prop being read closes it, which
  the board's own listener used to prevent; the last lines of a titled page can now be
  scrolled into view.
- **The player hears why a pin will not open** — "the GM has not granted access yet" —
  instead of core's generic refusal, and the Pinboard has a filter for exactly those
  rows. Revealing a pin-mode pin with ownership sync off tells the GM once that the sheet
  will refuse.
- **A first-run welcome and a what's-new dialog**, once per client, GM only. The empty
  Pinboard says what to do and offers to place a pin. A GM's first prop is Aged Parchment
  rather than no effect at all.
- **The Pinboard's `…` button is a real menu** with every verb the row has; a drag shows
  where the row will land; `Alt+↑↓` reorders from the keyboard; the bulk bar is always
  there so the list never jumps; the scroll survives a re-render, in the board and in a
  Studio tab.
- **Motion, as one system.** A single table of durations and curves shared by both
  tiers and kept equal by a test. The reveal plays where there is something to reveal —
  at the bind, with the preset's own curve and duration — instead of at the moment of
  the transition, when the mesh was unbound and it silently did nothing; the DOM tier no
  longer replays it on every mount. Every exit animates: the reader, the tooltip, the
  ghost, the HUD palettes. Peek eases on the canvas tier as it already did on the DOM
  tier. Warm light falls on a prop under the pointer. The ghost eases its steps, shows a
  solid border while placing free of the grid and a stamp mark while a run is armed, and
  holds until the pin exists.
- **One modifier vocabulary.** Click and Shift on every chip, taught by the tooltip;
  the ghost legend names the modifiers in the keyboard's own language and lights the
  held ones. One focus ring for every surface. The picker is a combobox driven from the
  search box. `Escape` on the HUD lets go of the pin. The intensity sliders preview as
  they move. Presets are reachable from both galleries and a user preset can be named.

### Changed

- **Pin payload schema 2.** `display.typeSize` (scene px) and `display.margin` (em) are
  stored per pin; margins are em of the type size rather than a fraction of the short
  edge, so a resize never moves them. `display.showLabel`, `display.labelPosition`,
  `interaction.openPage` and `interaction.clickThrough` were stored and read by nothing
  and are gone; a click-through pin becomes `open: "never"`, which it always was.
- The reader gate is the apparent **type** size, not the box's width: a small scrap with
  legible type is exactly the prop whose clipped tail the reader exists to scroll.
- The rendering setting is labelled by what it does — into the scene where the browser
  allows, for PDF pages, or always as an overlay.
- `Alt+Shift+F`, not `Alt+F`: that is Chrome's menu accelerator on Windows and Linux.
- The Studio's "remember who has discovered it" is gone: it was read only under an
  audience kind the tab does not offer.

### Fixed

- **A resized DOM prop kept its old card.** The card carried its own width, height and
  font size as inline pixels, so a resize moved the box and left the old card inside it,
  clipped or short, until an LOD boundary happened to be crossed.
- **`Flash` told every player where a hidden pin was.** A ping is drawn at coordinates on
  every client whether or not a pin is there. A hidden pin now pings this client only.
- **`Alt+M`, `Alt+Shift+V` and `Shift+P` did nothing in silence** with nothing selected or
  nothing placed. They act on the Pinboard's focused row, open the picker, or say so.
- The tooltip's fade never played, and there was no fade-out, because the element was
  created and removed on every hover. The HUD's "Some" with nobody chosen moved the focus
  and said nothing. The ghost's `sticky` was written and never read. A rotation step
  across zero turned the long way. The tooltip ignored a prop's rotation. Two strings
  nothing referenced, and three stale claims in comments, are gone.

## [0.1.8] — 2026-08-28

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

## [0.1.7] — 2026-08-28

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

## [0.1.6] — 2026-08-28

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

## [0.1.5] — 2026-08-28

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

## [0.1.4] — 2026-08-28

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

## [0.1.3] — 2026-08-27

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

## [0.1.2] — 2026-08-27

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

## [0.1.1] — 2026-08-27

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

## [0.1.0] — 2026-08-27

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

[Unreleased]: https://github.com/Heiiji/Documents-pinner/compare/v0.3.3...HEAD
[0.3.3]: https://github.com/Heiiji/Documents-pinner/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Heiiji/Documents-pinner/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Heiiji/Documents-pinner/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Heiiji/Documents-pinner/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/Heiiji/Documents-pinner/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/Heiiji/Documents-pinner/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.8...v0.2.0
[0.1.8]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.7...v0.1.8
[0.1.7]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.6...v0.1.7
[0.1.6]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Heiiji/Documents-pinner/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Heiiji/Documents-pinner/releases/tag/v0.1.0
