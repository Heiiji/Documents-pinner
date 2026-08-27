# Documents Pinner

Pin any journal, document or image onto the map — as a small icon players click, or as a
full-size **readable prop lying on the scene**. Per-pin visibility the GM controls in one
click, and subtle, immersive effects.

> **Status: feature-complete, not yet verified in a live world.** Every layer described
> below is implemented and covered by 500+ tests running under Node — including an
> integration layer that drives the real ApplicationV2 render and action contracts, the
> canvas layers, the sanitiser against the parser a browser actually uses, and the
> ownership ledger against a document that merges the way Foundry's does.
>
> What has *not* happened yet is a session at a real table. The lighting, fog and
> occlusion behaviour, the frame rate under fifty props, and the ownership round-trip are
> argued for below and tested where a test can reach them, but they have not been watched
> working on a real scene. Treat it as a beta and keep a backup.

*Version française plus bas.*

---

## Installation

In Foundry, open **Add-on Modules → Install Module**, paste this into the **Manifest URL**
field and press Install:

```
https://github.com/Heiiji/Documents-pinner/releases/latest/download/module.json
```

Then enable **Documents Pinner** in your world's **Manage Modules**. There is nothing else
to configure — every setting has a working default, and the module probes your browser at
startup to decide how to draw props.

To install a specific version instead, use the manifest attached to that release on the
[Releases page](https://github.com/Heiiji/Documents-pinner/releases).

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
gives each pin its own audience — hidden, everyone, or specific players — with two
surfaces to change it:

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

From a tile's configuration sheet, a **Treat this tile as a pinned document** checkbox
adopts an existing tile, including one another module made. From a map note's sheet, a
button **converts it into a pinned document**.

### While placing

A ghost of the real prop at real size and with its real effect follows the cursor, so you
can see how big it is *here* and whether the effect reads against *this* map before
committing.

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
map, `O` opens it for you alone, `S` pushes it to every screen in its audience, `F`
flashes it, `M` switches shape, `/` searches, `Esc` clears. Shift-select a range, then reveal the lot in one gesture.

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
9. The "revealed on discovery" audience is not offered: persisting a discovery would need
   a player to write a pin's configuration, which the security model does not allow.

## Development

```bash
npm install
npm test          # unit and integration tests
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
> les couches décrites ci-dessous sont implémentées et couvertes par plus de 500 tests
> exécutés sous Node — dont une couche d'intégration qui exerce le vrai contrat de rendu
> et d'actions d'ApplicationV2, les couches de canevas, le nettoyeur HTML face à
> l'analyseur qu'un navigateur utilise réellement, et le registre de permissions face à un
> document qui fusionne comme ceux de Foundry.
>
> Ce qui n'a pas encore eu lieu, c'est une vraie séance : l'éclairage, le brouillard,
> l'occultation, la fluidité à cinquante accessoires et l'aller-retour des permissions sont
> argumentés et testés là où un test peut aller, mais n'ont pas été observés sur une scène
> réelle. Considérez-le comme une bêta et gardez une sauvegarde.

---

## Installation

Dans Foundry, ouvrez **Modules complémentaires → Installer un module**, collez ceci dans le
champ **URL du manifeste** et validez :

```
https://github.com/Heiiji/Documents-pinner/releases/latest/download/module.json
```

Activez ensuite **Documents Pinner** dans **Gérer les modules** de votre monde. Il n'y a
rien d'autre à configurer : chaque réglage a une valeur par défaut fonctionnelle, et le
module teste votre navigateur au démarrage pour décider comment dessiner les accessoires.

Pour installer une version précise, utilisez le manifeste attaché à cette version sur la
[page des versions](https://github.com/Heiiji/Documents-pinner/releases).

---

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
Ce module donne à chaque épingle son propre public — masquée, tout le monde, ou certains
joueurs — avec deux surfaces pour le changer :

- un **HUD** sur l'épingle sélectionnée, avec des pastilles par joueur (pleine = peut la
  voir, creuse = ne peut pas, glyphe de clé = peut la voir mais pas l'ouvrir) ;
- un **tableau de bord** listant toutes les épingles de la scène, pilotable au clavier,
  avec révélation groupée et un ordre des lignes trié à la main qui tient lieu de script
  de révélation.

En option, révéler élève aussi les permissions du document pour qu'il apparaisse dans la
barre latérale du joueur — et annuler la révélation **restaure exactement** les
permissions précédentes, y compris si vous les avez modifiées à la main entre-temps.

### Effets

Dix préréglages : Parchemin vieilli, Bords déchirés, Sceau de cire, Taché de sang, Flou,
Lueur arcanique, Cadre holographique, Balayage cathodique, Glitch, et Aucun. Chacun a un
curseur d'intensité, et vous pouvez créer, exporter et partager les vôtres.

Chaque préréglage possède une variante `réduite` qui conserve son identité statique —
teinte, cadre, texture, forme des bords — et ne coupe que le mouvement. Le mouvement réduit
ne transforme jamais un accessoire en rectangle gris : personne n'a besoin de désactiver le
réglage pour que la partie reste lisible.

---

## Poser un document sur la carte

Six entrées, dont aucune ne change ce que faire glisser un journal sur le canevas fait
déjà — ce geste crée toujours une note de carte ordinaire, parce que d'autres modules
s'appuient dessus.

| | |
|---|---|
| **Alt-glisser** un journal ou une page depuis la barre latérale | le geste principal ; le modificateur est configurable |
| **Épingler sur la scène** dans l'en-tête d'une fiche de journal | |
| **Épingler un document** / **Tableau de bord** dans les outils Notes | |
| Clic droit sur un journal ou une page dans la barre latérale | |
| `Maj+P` | pose le dernier document utilisé, avec le dernier effet, sans aucune boîte de dialogue |
| `/pin <nom>` dans le chat | |

Depuis la fiche de configuration d'une tuile, une case **Traiter cette tuile comme un
document épinglé** adopte une tuile existante, y compris une créée par un autre module.
Depuis celle d'une note de carte, un bouton la **convertit en document épinglé**.

### Pendant le placement

Un fantôme de l'accessoire réel, à sa taille réelle et avec son effet, suit le curseur :
vous voyez sa taille *ici* et si l'effet fonctionne sur *cette* carte avant de valider.

| | |
|---|---|
| molette | pivoter de 15° · `Maj` pour 1° · `Alt` pour redimensionner |
| `Espace` | basculer entre épingle et accessoire |
| `E` / `V` | faire défiler l'effet / le public |
| `R` | réinitialiser la rotation |
| `Ctrl` | suspendre l'aimantation à la grille |
| clic | poser · `Maj+clic` pose et reste armé |
| `Échap`, clic droit | annuler |

### Une fois posé

| | |
|---|---|
| `P` | ouvrir le tableau de bord |
| `Alt+Maj+V` | faire défiler le public des épingles sélectionnées |
| `Alt+M` | basculer les épingles sélectionnées entre épingle et accessoire |
| `Alt` maintenu | **coup d'œil** — chaque accessoire s'estompe pour laisser lire la carte dessous. Les joueurs en disposent aussi |

Dans le tableau de bord : `↑↓` se déplacent, `Espace` révèle, `Entrée` ouvre le Studio
d'épingle, `L` la localise sur la carte, `O` l'ouvre pour vous seul, `S` la pousse sur tous
les écrans de son public, `F` la fait clignoter, `M` change de forme, `/` recherche, `Échap`
efface. Sélectionnez une plage avec `Maj`, puis révélez le tout d'un seul geste.

---

## Réglages

Tout ce qui concerne votre machine est par client ; tout ce qui concerne la façon dont la
table joue est par monde.

| Réglage | Portée | |
|---|---|---|
| Rendu des accessoires | client | Canvas (éclairé, embrumé, occulté) ou DOM (compatibilité) |
| Niveau d'effets | client | Automatique, complet, réduit ou désactivé |
| Budget mémoire des textures | client | Au-delà, les accessoires que vous n'avez pas regardés depuis le plus longtemps passent en basse définition |
| Réduire le détail automatiquement | client | Baisse d'un cran tous les niveaux de détail si les épingles coûtent trop cher par image, une fois, avec une notification |
| Modificateur de glisser-épingler | client | Alt, Ctrl, Maj, ou aucun |
| Forme / visibilité par défaut | monde | Ce que devient un document nouvellement posé |
| Accorder l'accès au document à la révélation | monde | Si révéler élève aussi les permissions |

---

## Prérequis

Foundry VTT **v14** ou supérieur. Aucune dépendance, aucun socket.

Le rendu des accessoires dans la scène nécessite que le navigateur rastérise du HTML via
un `foreignObject` SVG. Chromium — utilisé par l'application de bureau Foundry — le fait.
**WebKit (Safari) refuse.** Le module le détecte au démarrage et bascule seul sur le rendu
DOM : les accessoires fonctionnent toujours, mais ne sont ni éclairés, ni masqués par le
brouillard, ni occultés.

## Visibilité et confidentialité — à lire

La visibilité des épingles est appliquée **au même niveau que Foundry lui-même, pas
au-dessus**. Foundry applique `Tile#hidden` côté client également : un joueur déterminé
avec une console de navigateur peut détecter une épingle masquée exactement comme il peut
détecter n'importe quelle tuile masquée aujourd'hui.

La seule chose réellement *retirée* plutôt que masquée, ce sont les sections `secret` d'une
page de journal : chaque client fabrique sa propre copie, et les secrets sont retirés du
rendu pour quiconque n'est pas propriétaire. Ils n'atteignent jamais le navigateur du
joueur.

Si vous avez besoin d'un vrai secret, gardez le document hors du monde jusqu'au moment où
vous voulez qu'il soit vu.

---

## Limitations connues

1. Le texte d'un accessoire est une image rastérisée : ni sélectionnable, ni lisible par un
   lecteur d'écran, et ses liens ne sont pas cliquables. Un clic ouvre le lecteur de mise au
   point, qui restitue les trois, et la fiche du document reste à un clic de plus.
2. La rastérisation intègre polices et images. Ce que le contexte SVG ne peut pas résoudre
   s'affiche en repli : du CSS exotique dans le HTML d'un journal ne survivra pas.
3. Une vidéo n'affiche qu'une seule image. Le contenu animé dans un accessoire est hors
   périmètre.
4. Les modifications de la source sont regroupées sur environ un quart de seconde, pas
   appliquées à chaque frappe.
5. Le lecteur de mise au point n'est délibérément ni éclairé ni occulté : au moment où vous
   le lisez, c'est une surface d'interface, pas un objet de la scène.
6. Supprimer un document épinglé laisse l'épingle sur un substitut. Elle n'est jamais
   supprimée automatiquement : ce serait destructeur et irréversible.
7. Les permissions d'un compendium sont liées au rôle et valent pour tout le pack : il n'y a
   pas d'octroi par joueur pour une épingle dont la source vit dans un compendium.
   L'épingle révèle quand même son contenu.
8. Les épingles sont de vraies tuiles et apparaissent dans `scene.tiles` aux autres modules,
   par conception.
9. Le public « révélé à la découverte » n'est pas proposé : sa persistance exigerait qu'un
   joueur écrive la configuration d'une épingle, ce que le modèle de sécurité interdit.

---

## Développement

```bash
npm install
npm test          # tests unitaires et d'intégration
npm run build     # -> dist/documents-pinner.mjs
npm run watch     # reconstruit à chaque modification
```

Créez un lien symbolique du dépôt dans votre répertoire de données Foundry sous
`Data/modules/documents-pinner`, lancez `npm run watch`, puis appuyez sur `F5` dans
Foundry. Le CSS ne fait pas partie de la construction : modifier une feuille de style ne
demande aucune reconstruction.

Les notes de conception, le modèle de sécurité, les découvertes sur l'API v14 et les
critères d'acceptation vivent dans [`docs/DESIGN.md`](docs/DESIGN.md).

---

## Licence

MIT — voir [LICENSE](LICENSE).
