# Documents Pinner

Pin any journal, document or image onto the map — as a small icon players click, or as a
full-size **readable prop lying on the scene**. Per-pin visibility the GM controls in one
click, and subtle, immersive effects.

> **Status: early development.** The pure core (visibility model, ownership ledger,
> transform maths, effect presets) is implemented and unit-tested. The Foundry-facing
> canvas and UI layers are in progress. Not yet installable as a working module.

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

## Requirements

Foundry VTT **v14** or later. No dependencies, no libWrapper, no sockets.

## Visibility and privacy — read this

Pin visibility is enforced **at parity with core Foundry, not above it**. Core enforces
`Tile#hidden` on the client too; a determined player with a browser console can detect a
hidden pin exactly as they can detect any hidden tile today.

The one thing that is genuinely *removed* rather than hidden is a journal page's
`secret` sections: each client renders its own copy, and secrets are stripped from the
output for anyone who is not an owner. They never reach a player's browser.

If you need real secrecy, keep the document out of the world until you want it seen.

---

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

> **État : développement précoce.** Le cœur pur (modèle de visibilité, registre de
> permissions, calculs de transformation, préréglages d'effets) est implémenté et testé.
> Les couches canvas et interface sont en cours. Pas encore installable.

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

Foundry VTT **v14** ou supérieur. Aucune dépendance.

## Visibilité et confidentialité

La visibilité des épingles est appliquée **au même niveau que Foundry lui-même, pas
au-dessus**. En revanche, les sections `secret` d'une page de journal sont réellement
*retirées* du rendu pour les non-propriétaires : elles n'atteignent jamais le navigateur
du joueur.

## Licence

MIT — voir [LICENSE](LICENSE).
