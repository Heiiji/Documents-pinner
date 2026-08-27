# Documents Pinner

Pin any journal, document or image onto the map — as a small icon players click, or as a
full-size **readable prop lying on the scene**. Per-pin visibility the GM controls in one
click, and subtle, immersive effects.

> **Status: feature-complete, not yet verified in a live world.** Every layer described
> below is implemented, and the logic behind it is covered by 400+ unit tests running
> under Node. What has *not* happened yet is a session at a real table: the lighting,
> fog and occlusion behaviour, the frame rate under fifty props, and the ownership
> round-trip are all argued for below and tested where a test can reach them, but they
> have not been watched working on a real scene. Treat it as a beta and keep a backup.

*Version française plus bas.*

---

## What it does

A GM alt-drags a journal page onto the scene. A ghost of the actual letter follows the
cursor — the wheel rotates it, `Space` switches between a pin and a full prop, a click
places it. It stays invisible to players until the GM clicks one eye icon.

When it appears, it is a parchment lying on the table: **darkened by the room's lighting,
hidden by fog they have not explored, and behind the token standing on it.**

### Two display modes

- **Pin** — a small icon on the map. Players click to open the document.
- **Prop** — the document laid out full size and readable in place. Click it and it comes
  into focus: selectable text, working document links, live inline rolls.

### Visibility you can actually drive mid-session

Core Foundry ties Map Note visibility to the linked journal's *permissions*, which is
exactly the wrong coupling for "reveal the letter the moment they find it". This module
gives each pin its own audience — hidden, everyone, specific players, or revealed on
discovery — with two surfaces to change it:

- a **HUD** on the selected pin with per-player avatar chips (filled = can see, hollow =
  cannot, key glyph = can see it but cannot open it);
- a **Pinboard** listing every pin on the scene, keyboard-driven, with bulk reveal and a
  hand-sorted row order that doubles as your reveal script.

Optionally, revealing also raises the document's ownership so it lands in the player's
sidebar — and un-revealing restores the previous permissions **exactly**, including when
you have edited them by hand in between.

### Effects

Ten presets: Aged Parchment, Torn Edges, Sealed & Wax, Bloodstained, Out of Focus,
Arcane Glow, Holographic Frame, CRT Scanlines, Glitch, and None. Each has an intensity
slider, and you can author, export and share your own.

Every preset has a `reduced` rendition that keeps its static identity — tint, frame,
texture, edge shape — and stops only the motion. Reduced motion never turns a prop into a
grey box, so nobody has to switch the setting off to keep the game readable.

---

## Getting a document onto the map

Six ways in, none of which changes what dragging a journal onto the canvas already does
— that gesture still makes an ordinary map note, because other modules build on it.

| | |
|---|---|
| **Alt-drag** a journal or page from the sidebar | the primary gesture; the modifier is configurable |
| **Pin to scene** in a journal sheet's header | |
| **Pin a document** / **Pinboard** in the Notes controls | |
| Right-click a journal or page in the sidebar | |
| `Shift+P` | place the last document you used, with the last effect, no dialogs |
| `/pin <name>` in chat | |

### While placing

A ghost of the real prop at real size follows the cursor, so you can see how big it is
*here* and whether the effect reads against *this* map before committing.

| | |
|---|---|
| wheel | rotate 15° · `Shift` for 1° · `Alt` to scale |
| `Space` | switch between pin and prop |
| `E` / `V` | cycle effect / audience |
| `R` | reset rotation |
| `Ctrl` | suspend grid snapping |
| click | place · `Shift+click` places and stays armed |
| `Esc`, right-click | cancel |

### Once placed

| | |
|---|---|
| `P` | open the Pinboard |
| `Alt+Shift+V` | cycle the selected pins' audience |
| `Alt+M` | switch the selected pins between pin and prop |
| hold `Alt` | **peek** — every prop fades so the map underneath can be read. Players get this too |

In the Pinboard: `↑↓` move, `Space` reveals, `Enter` opens Pin Studio, `L` finds it on the
map, `O` opens it for you alone, `F` flashes it on every screen, `M` switches shape, `/`
searches, `Esc` clears. Shift-select a range, then reveal the lot in one gesture.

## Settings

Anything about your machine is per-client; anything about how the table plays is
per-world.

| Setting | Scope | |
|---|---|---|
| Prop rendering | client | Canvas (lit, fogged, occluded) or DOM (compatibility) |
| Effect level | client | Automatic, full, reduced or off |
| Texture memory budget | client | Past it, the props you have not looked at longest drop to low detail |
| Reduce detail automatically | client | Lowers every detail level one step if pins start costing too much per frame, once, with a notification |
| Drag-to-pin modifier | client | Alt, Ctrl, Shift, or none |
| Default shape / visibility | world | What a newly placed document becomes |
| Grant document access on reveal | world | Whether revealing also raises ownership |

## Requirements

Foundry VTT **v14** or later. No dependencies, no libWrapper, no sockets, no monkey-patching.

Rendering props into the scene needs the browser to rasterise HTML through an SVG
`foreignObject`. Chromium — which the Foundry desktop app uses — does this. **WebKit
(Safari) refuses**, tainting the canvas. The module probes for this at startup and falls
back to DOM rendering on its own; props still work there, but they are not lit, fogged or
occluded, because that is a property of being drawn into the scene rather than over it.

## Visibility and privacy — read this

Pin visibility is enforced **at parity with core Foundry, not above it**. Core enforces
`Tile#hidden` on the client too; a determined player with a browser console can detect a
hidden pin exactly as they can detect any hidden tile today.

The one thing that is genuinely *removed* rather than hidden is a journal page's
`secret` sections: each client renders its own copy, and secrets are stripped from the
output for anyone who is not an owner. They never reach a player's browser.

If you need real secrecy, keep the document out of the world until you want it seen.

---

## Known limitations

1. Prop text is a rasterised picture: not selectable, not readable by a screen reader,
   and its links are not clickable. Clicking the prop opens the focus reader, which
   restores all three, and the document sheet is always one more click away.
2. Rasterisation inlines fonts and images. Anything the SVG context cannot resolve
   renders as a fallback, so exotic CSS inside journal HTML will not survive.
3. Video renders as a single frame. Animated content inside a prop is out of scope.
4. Source edits are coalesced over about a quarter of a second, not applied per keystroke.
5. The focus reader is deliberately never lit or occluded — at the moment you are reading
   it, it is a UI surface rather than a scene object.
6. Deleting a pinned document leaves the pin showing a placeholder. It is never deleted
   automatically; that would be destructive and unrecoverable.
7. Compendium ownership is role-based and pack-wide, so there is no per-user grant for a
   pin whose source lives in a compendium. The pin still reveals its content.
8. Pins are real Tiles and appear in `scene.tiles` to other modules, by design.

## Development

```bash
npm install
npm test          # unit tests over the pure modules
npm run build     # -> dist/documents-pinner.mjs
npm run watch     # rebuild on change
```

Symlink the repository into your Foundry data directory as
`Data/modules/documents-pinner`, run `npm run watch`, and press `F5` in Foundry. CSS is
not part of the build, so stylesheet edits need no rebuild at all.

Design notes, the security model, the v14 API findings and the acceptance criteria live
in [`docs/DESIGN.md`](docs/DESIGN.md).

---
---

# Documents Pinner (français)

Épinglez n'importe quel journal, document ou image sur la carte — sous forme d'une petite
icône sur laquelle les joueurs cliquent, ou d'un **accessoire lisible posé à même la
scène**. Une visibilité que le MJ contrôle en un clic, et des effets discrets et immersifs.

> **État : fonctionnellement complet, pas encore vérifié en conditions réelles.** Toutes
> les couches décrites ci-dessous sont implémentées et couvertes par plus de 400 tests
> unitaires. Ce qui n'a pas encore eu lieu, c'est une vraie séance : l'éclairage, le
> brouillard, l'occultation, la fluidité à cinquante accessoires et l'aller-retour des
> permissions sont argumentés et testés là où un test peut aller, mais n'ont pas été
> observés sur une scène réelle. Considérez-le comme une bêta et gardez une sauvegarde.

## Ce que ça fait

Le MJ fait glisser une page de journal sur la scène en maintenant `Alt`. Un fantôme de la
lettre suit le curseur — la molette la fait pivoter, `Espace` bascule entre épingle et
accessoire, un clic la pose. Elle reste invisible aux joueurs jusqu'à ce que le MJ clique
sur une icône d'œil.

Quand elle apparaît, c'est un parchemin posé sur la table : **assombri par l'éclairage de
la pièce, masqué par le brouillard non exploré, et derrière le pion qui se tient dessus.**

### Deux modes d'affichage

- **Épingle** — une petite icône. Les joueurs cliquent pour ouvrir le document.
- **Accessoire** — le document affiché en taille réelle et lisible sur place. Un clic le
  met au point : texte sélectionnable, liens fonctionnels, jets en ligne actifs.

### Une visibilité réellement pilotable en séance

Foundry lie la visibilité des notes de carte aux *permissions* du journal, ce qui est
précisément le mauvais couplage pour « révéler la lettre au moment où ils la trouvent ».
Ce module donne à chaque épingle son propre public — masqué, tout le monde, certains
joueurs, ou révélé à la découverte — avec deux surfaces pour le changer : un **HUD** avec
des pastilles par joueur, et un **tableau de bord** listant toutes les épingles de la
scène, pilotable au clavier, avec révélation groupée.

En option, révéler élève aussi les permissions du document pour qu'il apparaisse dans la
barre latérale du joueur — et annuler la révélation **restaure exactement** les
permissions précédentes, y compris si vous les avez modifiées à la main entre-temps.

### Effets

Dix préréglages : Parchemin vieilli, Bords déchirés, Sceau de cire, Taché de sang, Flou,
Lueur arcanique, Cadre holographique, Balayage cathodique, Glitch, et Aucun. Chacun a un
curseur d'intensité, et vous pouvez créer, exporter et partager les vôtres.

Chaque préréglage possède une variante `réduite` qui conserve son identité statique —
teinte, cadre, texture, forme des bords — et ne coupe que le mouvement.

## Prérequis

Foundry VTT **v14** ou supérieur. Aucune dépendance, aucun socket.

Le rendu des accessoires dans la scène nécessite que le navigateur rastérise du HTML via
un `foreignObject` SVG. Chromium — utilisé par l'application de bureau Foundry — le fait.
**WebKit (Safari) refuse.** Le module le détecte au démarrage et bascule seul sur le rendu
DOM : les accessoires fonctionnent toujours, mais ne sont ni éclairés, ni masqués par le
brouillard, ni occultés.

## Visibilité et confidentialité

La visibilité des épingles est appliquée **au même niveau que Foundry lui-même, pas
au-dessus**. En revanche, les sections `secret` d'une page de journal sont réellement
*retirées* du rendu pour les non-propriétaires : elles n'atteignent jamais le navigateur
du joueur.

## Licence

MIT — voir [LICENSE](LICENSE).
