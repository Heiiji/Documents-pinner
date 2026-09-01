# Documents Pinner

Pin any journal, page or image onto the map — as a small icon players click, or as a
full-size **readable prop lying on the scene**.

Per-pin visibility the GM changes in one click. Foundry VTT **v14+**.

> **Beta.** Journal props are drawn as an HTML layer over the canvas, not into it, so they
> are **not lit, fogged or occluded** and do not sort behind tokens. That was the plan, and
> it is not possible: an SVG containing a `foreignObject` taints the canvas in every
> current browser, so the texture upload is refused. Verified on Chromium 144, not just
> Safari — see [`docs/DESIGN.md`](docs/DESIGN.md) A10. **Pinned PDFs are the exception**
> and *are* drawn into the scene. Keep a backup.

*Version française plus bas.*

---

## Install

**Add-on Modules → Install Module**, paste into **Manifest URL**:

```
https://github.com/Heiiji/Documents-pinner/releases/latest/download/module.json
```

Enable it in **Manage Modules**. Nothing else to configure.

## Use

**Alt-drag** a journal or page from the sidebar onto the map. A ghost of the real prop
follows the cursor; click to place. It stays hidden from players until you reveal it.

| Placing | |
|---|---|
| wheel | rotate 15° · `Shift` 1° · `Alt` scale the box · `Shift+Alt` text size |
| `Space` | pin ↔ prop |
| `E` / `V` / `R` / `F` | effect · audience · reset rotation · fit height to content |
| `Ctrl` | free placement (no grid snap) |
| click | place · `Shift+click` keeps placing · `Esc` cancels |

| Anywhere | |
|---|---|
| `P` | Pinboard — every pin on the scene |
| `Shift+P` | place the last document again, no dialogs |
| `Alt+Shift+V` / `Alt+M` / `Alt+Shift+F` | cycle audience · switch shape · fit to content |
| hold `Alt` | peek: props fade so the map can be read (players too) |
| `/pin <name>` | place by name from chat |

| Pinboard | |
|---|---|
| `↑↓` `Space` | move · reveal |
| `Alt+↑↓` | reorder — row order is reveal order |
| `Enter` `L` `O` `S` `F` `M` | studio · locate · open · show to audience · flash · shape |
| `…` | every verb the row has, in a menu |
| `/` `Esc` | search · clear |

**Click a pin on the Notes layer to grab it.** Pins are Tiles, and Foundry only lets you
drag one from the Tiles layer — so a press on a prop from the Notes layer, where the
module's tools leave you, switches layer and selects it for you; the next press drags,
and the corner handles resize. The Pinboard's `L` (locate) does the same from a distance.

**A prop is a window onto its document.** Resizing it shows more or less of the page at
the same text size; text that does not fit fades out at the bottom edge. *Fit to content*
(Pin Studio, the HUD, `Alt+Shift+F`, or `F` while placing) sets the height so the whole
page shows at the current width. *Text size* and *Margins* are in Pin Studio, with the
width and height in grid squares and a ratio lock.

Also: a journal sheet header button, the Notes scene controls, sidebar context menus, a
checkbox on any tile's config sheet to adopt it, and a button on a map note to convert it.

**Two surfaces for visibility.** The HUD on a selected pin answers *this one, now*; the
Pinboard answers *the whole scene*, with bulk select and a hand-sorted order that doubles
as your reveal script. Avatar chips read: filled = can see it, hollow = cannot, key glyph
= can see it but cannot open it.

Optionally, revealing also raises the document's ownership so it lands in the player's
sidebar. Un-revealing restores the previous permissions exactly, including when you edited
them by hand in between.

## Settings

Anything about your machine is per-client; anything about how the table plays is per-world.

| | Scope | |
|---|---|---|
| Prop rendering | client | Into the scene where the browser allows (PDF pages), or always as an overlay |
| Effect level | client | Auto, full, reduced, off |
| Texture memory budget | client | Past it, the least-recently-seen props drop detail |
| Reduce detail automatically | client | One step down if the frame rate will not hold |
| Console detail | client | `Debug` is what a useful bug report needs |
| Drag-to-pin modifier | client | Alt, Ctrl, Shift, none |
| Default shape / visibility | world | What a newly placed document becomes |
| Grant document access on reveal | world | Whether revealing also raises ownership |

## Visibility and privacy — read this

Pin visibility is enforced **at parity with core Foundry, not above it**. Core enforces
`Tile#hidden` on the client too; a determined player with a browser console can detect a
hidden pin exactly as they can detect any hidden tile today.

The one thing genuinely *removed* rather than hidden is a page's `secret` sections. Each
client renders its own copy and secrets are stripped for anyone who is not an owner, so
they never reach a player's browser.

If you need real secrecy, keep the document out of the world until you want it seen.

## Known limitations

1. Video renders as a single frame.
2. A pinned **PDF** renders its page, and is the one prop type drawn *into* the scene —
   so it is lit, fogged, occluded and behind tokens, unlike a journal page. Multi-page
   PDFs show page 1.
3. Images referenced by a journal page are inlined; anything the module cannot fetch is
   dropped rather than left broken.
4. **Props are not lit, fogged, occluded, or sorted behind tokens.** Drawing them into the
   scene needs an HTML-to-texture step that every current browser refuses — an SVG with a
   `foreignObject` taints the canvas, so the WebGL upload throws. The module detects this
   at startup and draws props as an HTML layer over the canvas instead.
5. Deleting a pinned document leaves the pin showing a placeholder — never auto-deleted.
6. Compendium ownership is pack-wide, so there is no per-user grant for a compendium
   source. The pin still reveals its content.
7. Pins are real Tiles and appear in `scene.tiles` to other modules, by design.
8. *Fit to content* cannot measure a bare image pin — an image has no text to measure —
   so it leaves that one's height alone and says so.

## Development

```bash
npm install
npm test        # unit and integration tests
npm run build   # -> dist/documents-pinner.mjs
npm run watch
```

Symlink the repository into `Data/modules/documents-pinner` and press `F5` in Foundry. CSS
is not part of the build, so stylesheet edits need no rebuild.

Design notes, the security model and the acceptance criteria are in
[`docs/DESIGN.md`](docs/DESIGN.md).

MIT — see [LICENSE](LICENSE).

---

# Documents Pinner (français)

Épinglez n'importe quel journal, page ou image sur la carte — sous forme d'une petite icône
sur laquelle les joueurs cliquent, ou d'un **accessoire lisible posé à même la scène**.

Une visibilité que le MJ change en un clic. Foundry VTT **v14+**.

> **Bêta.** Les accessoires issus d'un journal sont dessinés en HTML par-dessus le canevas,
> pas dedans : ils ne sont donc **ni éclairés, ni embrumés, ni occultés**, et ne passent pas
> derrière les pions. C'était le plan, et c'est impossible : un SVG contenant un
> `foreignObject` « contamine » le canevas dans tous les navigateurs actuels, si bien que
> l'envoi de la texture est refusé. Vérifié sur Chromium 144, pas seulement Safari — voir
> [`docs/DESIGN.md`](docs/DESIGN.md) A10. **Les PDF épinglés font exception** et sont bien
> dessinés dans la scène. Gardez une sauvegarde.

## Installation

**Modules complémentaires → Installer un module**, collez dans **URL du manifeste** :

```
https://github.com/Heiiji/Documents-pinner/releases/latest/download/module.json
```

Activez-le dans **Gérer les modules**. Rien d'autre à configurer.

## Utilisation

**Alt-glissez** un journal ou une page depuis la barre latérale sur la carte. Un fantôme de
l'accessoire réel suit le curseur ; cliquez pour poser. Il reste masqué aux joueurs jusqu'à
ce que vous le révéliez.

| Placement | |
|---|---|
| molette | pivoter 15° · `Maj` 1° · `Alt` redimensionner le cadre · `Maj+Alt` taille du texte |
| `Espace` | épingle ↔ accessoire |
| `E` / `V` / `R` / `F` | effet · public · réinitialiser la rotation · ajuster la hauteur au contenu |
| `Ctrl` | placement libre (sans aimantation) |
| clic | poser · `Maj+clic` enchaîne · `Échap` annule |

| Partout | |
|---|---|
| `P` | tableau de bord — toutes les épingles de la scène |
| `Maj+P` | reposer le dernier document, sans dialogue |
| `Alt+Maj+V` / `Alt+M` / `Alt+Maj+F` | faire défiler le public · changer de forme · ajuster au contenu |
| `Alt` maintenu | coup d'œil : les accessoires s'estompent (les joueurs aussi) |
| `/pin <nom>` | poser par son nom depuis le chat |

| Tableau de bord | |
|---|---|
| `↑↓` `Espace` | se déplacer · révéler |
| `Alt+↑↓` | réordonner — l'ordre des lignes est l'ordre de révélation |
| `Entrée` `L` `O` `S` `F` `M` | studio · localiser · ouvrir · montrer au public · faire clignoter · forme |
| `…` | tous les verbes de la ligne, dans un menu |
| `/` `Échap` | rechercher · effacer |

**Cliquez une épingle sur le calque Notes pour la saisir.** Les épingles sont des tuiles,
et Foundry ne permet de les déplacer que depuis le calque Tuiles — alors un clic sur un
accessoire depuis le calque Notes, là où les outils du module vous laissent, change de
calque et le sélectionne pour vous ; le clic suivant le déplace, et les poignées d'angle
le redimensionnent. Le `L` du tableau de bord (localiser) fait de même à distance.

**Un accessoire est une fenêtre sur son document.** Le redimensionner montre plus ou
moins de la page à la même taille de texte ; le texte qui ne tient pas s'estompe au bord
inférieur. *Ajuster au contenu* (Pin Studio, le HUD, `Alt+Maj+F`, ou `F` pendant le
placement) règle la hauteur pour que toute la page tienne à la largeur actuelle. *Taille
du texte* et *Marges* sont dans Pin Studio, avec la largeur et la hauteur en cases et un
verrou de ratio.

Également : un bouton dans l'en-tête d'une fiche de journal, les contrôles de scène Notes,
les menus contextuels de la barre latérale, une case sur la fiche de n'importe quelle tuile
pour l'adopter, et un bouton sur une note de carte pour la convertir.

**Deux surfaces pour la visibilité.** Le HUD d'une épingle sélectionnée répond *celle-ci,
maintenant* ; le tableau de bord répond *toute la scène*, avec sélection groupée et un ordre
trié à la main qui tient lieu de script de révélation. Les pastilles se lisent ainsi :
pleine = peut la voir, creuse = ne peut pas, glyphe de clé = peut la voir mais pas l'ouvrir.

En option, révéler élève aussi les permissions du document pour qu'il apparaisse dans la
barre latérale du joueur. Annuler la révélation restaure exactement les permissions
précédentes, y compris si vous les avez modifiées à la main entre-temps.

## Réglages

Tout ce qui concerne votre machine est par client ; tout ce qui concerne la table est par
monde.

| | Portée | |
|---|---|---|
| Rendu des accessoires | client | Dans la scène quand le navigateur le permet (pages PDF), ou toujours en surimpression |
| Niveau d'effets | client | Auto, complet, réduit, désactivé |
| Budget mémoire des textures | client | Au-delà, les accessoires les plus anciens perdent en détail |
| Réduire le détail automatiquement | client | Un cran plus bas si la fluidité ne tient pas |
| Détail de la console | client | `Débogage` est ce dont un rapport de bogue a besoin |
| Modificateur de glisser-épingler | client | Alt, Ctrl, Maj, aucun |
| Forme / visibilité par défaut | monde | Ce que devient un document nouvellement posé |
| Accorder l'accès au document à la révélation | monde | Si révéler élève aussi les permissions |

## Visibilité et confidentialité — à lire

La visibilité des épingles est appliquée **au même niveau que Foundry lui-même, pas
au-dessus**. Foundry applique `Tile#hidden` côté client également : un joueur déterminé avec
une console peut détecter une épingle masquée exactement comme n'importe quelle tuile
masquée aujourd'hui.

La seule chose réellement *retirée* plutôt que masquée, ce sont les sections `secret` d'une
page. Chaque client fabrique sa propre copie et les secrets sont retirés pour quiconque
n'est pas propriétaire : ils n'atteignent jamais le navigateur du joueur.

Si vous avez besoin d'un vrai secret, gardez le document hors du monde jusqu'au moment
voulu.

## Limitations connues

1. Une vidéo n'affiche qu'une seule image.
2. Un **PDF** épinglé affiche sa page, et c'est le seul type d'accessoire dessiné *dans*
   la scène : il est donc éclairé, embrumé, occulté et passe derrière les pions,
   contrairement à une page de journal. Les PDF multipages affichent la page 1.
3. Les images référencées par une page de journal sont intégrées ; ce que le module ne peut
   pas récupérer est retiré plutôt que laissé cassé.
4. **Les accessoires ne sont ni éclairés, ni embrumés, ni occultés, ni placés derrière les
   pions.** Les dessiner dans la scène exige une conversion HTML → texture que tous les
   navigateurs actuels refusent : un SVG avec `foreignObject` contamine le canevas, et
   l'envoi WebGL échoue. Le module le détecte au démarrage et dessine les accessoires en
   HTML par-dessus le canevas.
5. Supprimer un document épinglé laisse l'épingle sur un substitut — jamais supprimée
   automatiquement.
6. Les permissions d'un compendium valent pour tout le pack : pas d'octroi par joueur. Le
   contenu est quand même révélé.
7. Les épingles sont de vraies tuiles et apparaissent dans `scene.tiles` aux autres modules,
   par conception.
8. *Ajuster au contenu* ne peut pas mesurer une épingle d'image nue — une image n'a pas
   de texte à mesurer — et laisse alors sa hauteur inchangée en le disant.

## Développement

```bash
npm install
npm test        # tests unitaires et d'intégration
npm run build   # -> dist/documents-pinner.mjs
npm run watch
```

Créez un lien symbolique du dépôt dans `Data/modules/documents-pinner` et appuyez sur `F5`
dans Foundry. Le CSS ne fait pas partie de la construction.

Les notes de conception, le modèle de sécurité et les critères d'acceptation sont dans
[`docs/DESIGN.md`](docs/DESIGN.md).

MIT — voir [LICENSE](LICENSE).
