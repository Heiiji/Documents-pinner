# Documents Pinner

Pin any journal, page, actor, item or image onto the map — as a small **icon** players
click, or as a full-size **readable prop lying on the scene**.

Per-pin visibility the GM changes in one click. Foundry VTT **v14+**.

> **Beta.** Text props are drawn as an HTML layer over the canvas, not into it, so they
> are **not lit, fogged or occluded** and do not sort behind tokens. That was the plan, and
> it was not possible: an SVG containing a `foreignObject` tainted the canvas in every
> browser measured, so the texture upload was refused. Verified on Chromium 144, not just
> Safari — see [`docs/DESIGN.md`](docs/DESIGN.md) A10, and A21 for a measurement that may
> reopen it. **Pinned PDFs are the exception**
> and *are* drawn into the scene. Keep a backup.

*Version française plus bas.*

---

## Install

**Add-on Modules → Install Module**, paste into **Manifest URL**:

```
https://github.com/Heiiji/Documents-pinner/releases/latest/download/module.json
```

Enable it in **Manage Modules**. Nothing else to configure.

## Browsers

Foundry's desktop app is Chromium 144, so nothing here constrains it. In a browser this
module needs **Chrome or Edge 120+, or Firefox 129+** — Firefox ESR 140 yes, ESR 128 no.

Those two numbers are the newest CSS features the module actually uses: unprefixed
`mask-image`, which is what a torn or burnt edge is made of, and `@starting-style`, which
is what makes the reader settle rather than appear. `tests/css-baseline.test.ts` fails if a
stylesheet ever reaches past them, so the claim cannot quietly go stale.

**Firefox is checked by hand each release** against a live world and against
`tests/harness/effects.html`, a page that mounts every effect under the real stylesheet in
two engines side by side. Safari is deliberately not claimed: nobody has measured it since
the finding in [`docs/DESIGN.md`](docs/DESIGN.md) A17, and stating a number nobody has run
would be worse than saying nothing.

## Use

**Alt-drag** a journal, a page or an item from the sidebar or a compendium onto the map. A
ghost of the real prop follows the cursor; click to place.

**A new pin is visible to players the moment it lands.** That is the default of the
*Default visibility* setting. Press `V` while placing to put this one down hidden, or set
*Default visibility* to *Hidden until revealed* so every pin waits for you. With *Grant
document access on reveal* on, a visible pin also puts its document in the players'
sidebar — so if you prepare scenes while players are connected, change the default first.

| Placing | |
|---|---|
| wheel | rotate 15° · `Shift` 1° · `Alt` scale the box · `Shift+Alt` text size · `Ctrl`/`⌘` zoom |
| `Space` | icon ↔ prop |
| `E` / `V` / `R` / `F` | effect · audience · reset rotation · fit height to content |
| `Ctrl`/`⌘` | free placement (no grid snap) |
| click | place · `Shift+click` keeps placing · `Esc` or right-click cancels · right-drag pans |

| Anywhere | |
|---|---|
| `P` | Pinboard — every pin on the scene |
| `Shift+P` | place the last document again, no dialogs |
| `Alt+Shift+V` / `Alt+M` / `Alt+Shift+F` | cycle audience · switch shape · fit to content |
| hold `Alt` | peek: props fade so the map can be read (players too) |
| *Reveal the next hidden pin* | Reveal next from anywhere, in the Pinboard's view when it is open — no key until you give it one in Configure Controls |
| `/pin <name>` | place by name from chat — a world journal or page, then an actor, then an item, else a compendium document |

| Pinboard | |
|---|---|
| `↑↓` `Space` | move · reveal |
| `N` | reveal next: the first hidden row, in order, to the players it remembers — the footer names it, and says what is left |
| `Shift+Space` | reveal & spotlight: every player's view is pulled to it — only when it is for everyone |
| `Alt+↑↓` | reorder — row order is reveal order |
| `Enter` `L` `O` `Shift+S` `F` `M` | studio · locate · open · show to audience · flash · shape |
| effect · `…` | choose an effect · every verb the row has, each in a menu |
| bulk bar | reveal · hide · delete the selection — each pin to its own audience · *Reveal all* asks before showing more than one |
| `/` `Esc` | search · clear |

Press `?` while placing, on the Pinboard or on a pin's HUD — or click their `?` button —
to see that surface's keys, named as your keyboard names them and as you bound them in
Configure Controls.

**Click a pin on the Notes layer to grab it.** Pins are Tiles, and Foundry only lets you
drag one from the Tiles layer — so a press on a prop from the Notes layer, where the
module's tools leave you, switches layer and selects it for you; the next press drags,
and the corner grip resizes. The frame and the grip are drawn on the paper itself, and
what you drag is the paper. The Pinboard's `L` (locate) does the same from a distance.

**A prop is a window onto its document.** Resizing it shows more or less of the page at
the same text size; text that does not fit fades out at the bottom edge. *Fit to content*
(Pin Studio, `Alt+Shift+F`, or `F` while placing) sets the height so the whole
page shows at the current width. *Text size* and *Margins* are in Pin Studio, with the
width and height in grid squares and a ratio lock. So is a pin's **icon** — one of core's
map-note icons or any image — and hovering a pin names it.

**A prop's lettering and its arrival are yours to choose.** Pin Studio's Appearance tab
sets a typeface — serif, sans serif, typewriter, handwriting, or any font your world has,
including one added in Foundry's Font Config — and a reveal sound. Otherwise the effect
decides: CRT Scanlines, Projected Readout, Tagged and Signal Loss type in monospace, Aged
Parchment and Sealed & Wax in a serif, and the Preset Studio's *Type* and *Reveal* groups
set an effect's own face, arrival, duration and sound. *Fit to content* measures in the
chosen face. A reveal sound plays for each player as the prop appears on their screen, at
their Environment volume — you hear it through ▶, since your own screen never sees it
arrive — and must be a file on your own server: a shared preset naming a web address is
refused on import.

**An actor becomes a wanted poster, an item a found object.** The prop shows its picture
— an actor's portrait, else its token's — its name, and one of its texts: Pin Studio's
*Text shown* lists every rich-text field your game system gives that kind of actor or
item, and *Automatic* picks public text first, then a biography or a description, never a
field named for the GM. Its secret sections reach only its owners and you. Revealing an
actor shares it at Limited at most, and a new actor pin — or a pin pointed at an actor
from Pin Studio — starts with *Grant document access* off: the poster reads in place
without it. An actor is pinned from its context menu, its sheet, *Pin a document* or
`/pin`; dragging one onto the map stays Foundry's token unless the drag modifier is Ctrl
or Shift.

*Pin a document* searches journals, actors and items — the world's, then every
compendium's from two letters — with a chip to show one kind alone.

Also: a header button on journal, actor and item sheets, the Notes scene controls,
context menus in the sidebar and in compendium windows, a checkbox on any tile's config
sheet to adopt it, and a button on a map note to convert it.

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
| Drag-to-pin modifier | client | Alt, Ctrl, Shift, none — an actor only with Ctrl or Shift |
| Default shape / visibility | world | What a newly placed document becomes — a prop, visible to everyone, until you change it |
| Grant document access on reveal | world | Whether revealing also raises ownership |

## Visibility and privacy — read this

Pin visibility is enforced **at parity with core Foundry, not above it**. Core enforces
`Tile#hidden` on the client too; a determined player with a browser console can detect a
hidden pin exactly as they can detect any hidden tile today.

The one thing genuinely *removed* rather than hidden is a page's `secret` sections. Each
client renders its own copy and secrets are stripped for anyone who is not an owner, so
they never reach a player's browser.

If you need real secrecy, keep the document out of the world until you want it seen.

**Spotlight moves views only for a pin that is for everyone.** A Foundry ping reaches
every connected player, whoever the pin is for, so pulling the table to a note meant for
one player would walk everyone else to where it lies. *Reveal & spotlight* (the HUD,
`Shift+Space` or the row menu in the Pinboard) reveals a pin to its own audience either
way, and pulls every view only when that audience is everyone; otherwise it points at the
pin on your screen alone, and says so. *Reveal next* never moves a view, and pulses on the
players' maps only for a pin that is for everyone. *Flash* still pulses on every player's
map for any visible pin, as its label says.

## Known limitations

1. Video renders as a single frame.
2. A pinned **PDF** renders its page, and is the one prop type drawn *into* the scene —
   so it is lit, fogged, occluded and behind tokens, unlike a journal page. Which page it
   shows is set in Pin Studio.
3. A pin on a **whole journal whose first page is a PDF** shows a placeholder rather than
   the page: the module asks the resolved source's type, and that is the journal. Choose
   the page explicitly in Pin Studio and it is drawn.
4. Images referenced by a journal page are inlined; anything the module cannot fetch is
   dropped rather than left broken.
5. **Text props darken with the scene, but are not lit by its lights, fogged, occluded,
   or sorted behind tokens.** Drawing them into the scene needs an HTML-to-texture step:
   an SVG with a `foreignObject`, which tainted the canvas in every browser measured, so
   the WebGL upload threw. The module probes for this at startup and draws props as an
   HTML layer over the canvas instead, dimmed by the scene's global darkness level and by
   nothing else — except on the Projection stock, which is light and stays bright. So a
   revealed text prop shows through fog a player has not explored: reveal it when they
   reach it — Pin Studio's Audience tab says so. *That probe now passes on current Chrome
   and Firefox* — see [`docs/DESIGN.md`](docs/DESIGN.md) A21 — so the tier may be
   reachable again; nothing has been changed on that until the whole pipeline is measured
   in a real world, not just the probe.
6. Deleting a pinned document leaves the pin showing a placeholder — never auto-deleted.
7. A compendium document can be pinned, and shows to the players whose role can open
   that compendium — Observer for their role. Anyone else sees a placeholder that says
   why, and you are told so when you place it: *Pin a document* greys such a row and
   offers *Import & pin*, which makes a copy — of a journal, an actor or an item — in a
   "Documents Pinner" folder of its kind, which you share like anything else in your
   world. Compendium permissions are per role and pack-wide, so a reveal never changes
   them and adds nothing to anyone's sidebar. A PDF page from a compendium is drawn as a
   card. A hidden pin on a compendium your players can open shows the key glyph on their
   chips: they can already read it in the compendium.
8. Pins are real Tiles and appear in `scene.tiles` to other modules, by design.
9. *Fit to content* cannot measure a bare image pin — an image has no text to measure —
   so it leaves that one's height alone and says so.
10. An actor's portrait or an item's picture hosted on another server — an asset host, a
    CDN — shows on the HTML layer, but is dropped wherever a prop is drawn into the scene,
    like any image the module cannot fetch (4).
11. An actor is shared at Limited at most. What a Limited sheet shows — the portrait, the
    biography, or the whole sheet — is your game system's choice, not this module's.
    *Show to players* opens journals only: an actor's or an item's pin is shown by
    revealing it.
12. An item an actor owns and a token's own actor cannot be pinned: their permissions are
    their owner's. Pin the actor, or the item from the sidebar.
13. With Alt as the drag modifier — the default — Alt-dragging an actor still places
    Foundry's hidden token, and with no modifier set an actor drag still places a token.
    Set the modifier to Ctrl or Shift to pin actors by dragging them.

## Development

```bash
npm install
npm test        # unit and integration tests
npm run build   # -> dist/documents-pinner.mjs
npm run watch
npm run harness # -> tests/harness/effects.html, opened in two browsers to compare
```

Symlink the repository into `Data/modules/documents-pinner` and press `F5` in Foundry. CSS
is not part of the build, so stylesheet edits need no rebuild.

Design notes, the security model and the acceptance criteria are in
[`docs/DESIGN.md`](docs/DESIGN.md).

MIT — see [LICENSE](LICENSE).

---

# Documents Pinner (français)

Épinglez n'importe quel journal, page, acteur, objet ou image sur la carte — sous forme
d'une petite **icône** sur laquelle les joueurs cliquent, ou d'un **accessoire lisible posé
à même la scène**.

Une visibilité que le MJ change en un clic. Foundry VTT **v14+**.

> **Bêta.** Les accessoires de texte sont dessinés en HTML par-dessus le canevas,
> pas dedans : ils ne sont donc **ni éclairés, ni embrumés, ni occultés**, et ne passent pas
> derrière les pions. C'était le plan, et ce ne l'était pas : un SVG contenant un
> `foreignObject` « contaminait » le canevas dans tous les navigateurs mesurés, si bien que
> l'envoi de la texture était refusé. Vérifié sur Chromium 144, pas seulement Safari — voir
> [`docs/DESIGN.md`](docs/DESIGN.md) A10, et A21 pour une mesure qui pourrait rouvrir la
> voie. **Les PDF épinglés font exception** et sont bien dessinés dans la scène. Gardez une
> sauvegarde.

## Installation

**Modules complémentaires → Installer un module**, collez dans **URL du manifeste** :

```
https://github.com/Heiiji/Documents-pinner/releases/latest/download/module.json
```

Activez-le dans **Gérer les modules**. Rien d'autre à configurer.

## Navigateurs

L'application de bureau de Foundry est Chromium 144 : rien ici ne la contraint. Dans un
navigateur, ce module demande **Chrome ou Edge 120+, ou Firefox 129+** — Firefox ESR 140
oui, ESR 128 non.

Ces deux nombres sont les fonctionnalités CSS les plus récentes que le module utilise
réellement : `mask-image` sans préfixe, dont sont faits les bords déchirés ou brûlés, et
`@starting-style`, qui fait que la liseuse se pose au lieu d'apparaître.
`tests/css-baseline.test.ts` échoue si une feuille de style dépasse ces versions, pour que
l'affirmation ne devienne pas silencieusement fausse.

**Firefox est vérifié à la main à chaque version**, sur un monde réel et sur
`tests/harness/effects.html`, une page qui monte tous les effets sous la vraie feuille de
style dans les deux moteurs, côte à côte. Safari n'est délibérément pas revendiqué :
personne ne l'a mesuré depuis la découverte décrite dans
[`docs/DESIGN.md`](docs/DESIGN.md) A17, et annoncer un nombre que personne n'a essayé
serait pire que de ne rien dire.

## Utilisation

**Alt-glissez** un journal, une page ou un objet depuis la barre latérale ou un compendium
sur la carte. Un fantôme de l'accessoire réel suit le curseur ; cliquez pour poser.

**Une nouvelle épingle est visible des joueurs dès qu'elle est posée.** C'est la valeur par
défaut du réglage *Visibilité par défaut*. Appuyez sur `V` pendant le placement pour poser
celle-ci masquée, ou réglez *Visibilité par défaut* sur *Masquée jusqu'à révélation* pour
que chaque épingle vous attende. Avec *Accorder l'accès au document lors de la révélation*
activé, une épingle visible place aussi son document dans la barre latérale des joueurs :
si vous préparez vos scènes pendant que des joueurs sont connectés, changez d'abord ce
réglage.

| Placement | |
|---|---|
| molette | pivoter 15° · `Maj` 1° · `Alt` redimensionner le cadre · `Maj+Alt` taille du texte · `Ctrl`/`⌘` zoom |
| `Espace` | icône ↔ accessoire |
| `E` / `V` / `R` / `F` | effet · public · réinitialiser la rotation · ajuster la hauteur au contenu |
| `Ctrl`/`⌘` | placement libre (sans aimantation) |
| clic | poser · `Maj+clic` enchaîne · `Échap` ou clic droit annule · glisser clic droit déplace la vue |

| Partout | |
|---|---|
| `P` | tableau de bord — toutes les épingles de la scène |
| `Maj+P` | reposer le dernier document, sans dialogue |
| `Alt+Maj+V` / `Alt+M` / `Alt+Maj+F` | faire défiler le public · changer de forme · ajuster au contenu |
| `Alt` maintenu | coup d'œil : les accessoires s'estompent (les joueurs aussi) |
| *Révéler l'épingle masquée suivante* | révéler la suivante de n'importe où, dans la vue du tableau de bord s'il est ouvert — sans touche tant que vous ne lui en donnez pas une dans Configurer les contrôles |
| `/pin <nom>` | poser par son nom depuis le chat — un journal ou une page du monde, puis un acteur, puis un objet, sinon un document de compendium |

| Tableau de bord | |
|---|---|
| `↑↓` `Espace` | se déplacer · révéler |
| `N` | révéler la suivante : la première ligne masquée, dans l'ordre, aux joueurs dont elle se souvient — le pied du tableau la nomme, et dit ce qui reste |
| `Maj+Espace` | révéler et mettre en lumière : la vue de chaque joueur est amenée sur elle — seulement si elle est pour tout le monde |
| `Alt+↑↓` | réordonner — l'ordre des lignes est l'ordre de révélation |
| `Entrée` `L` `O` `Maj+S` `F` `M` | studio · localiser · ouvrir · montrer au public · faire clignoter · forme |
| effet · `…` | choisir un effet · tous les verbes de la ligne, chacun dans un menu |
| barre groupée | révéler · masquer · supprimer la sélection — chaque épingle à son propre public · *Tout révéler* demande confirmation avant d'en montrer plus d'une |
| `/` `Échap` | rechercher · effacer |

Appuyez sur `?` pendant le placement, dans le tableau de bord ou sur les commandes d'une
épingle — ou cliquez leur bouton `?` — pour voir les touches de cet endroit, nommées comme
votre clavier les nomme et comme vous les avez réglées dans Configurer les contrôles.

**Cliquez une épingle sur le calque Notes pour la saisir.** Les épingles sont des tuiles,
et Foundry ne permet de les déplacer que depuis le calque Tuiles — alors un clic sur un
accessoire depuis le calque Notes, là où les outils du module vous laissent, change de
calque et le sélectionne pour vous ; le clic suivant le déplace, et la poignée d'angle
le redimensionne. Le cadre et la poignée sont dessinés sur le papier lui-même, et ce que
vous déplacez, c'est le papier. Le `L` du tableau de bord (localiser) fait de même à
distance.

**Un accessoire est une fenêtre sur son document.** Le redimensionner montre plus ou
moins de la page à la même taille de texte ; le texte qui ne tient pas s'estompe au bord
inférieur. *Ajuster au contenu* (Pin Studio, `Alt+Maj+F`, ou `F` pendant le
placement) règle la hauteur pour que toute la page tienne à la largeur actuelle. *Taille
du texte* et *Marges* sont dans Pin Studio, avec la largeur et la hauteur en cases et un
verrou de ratio. L'**icône** d'une épingle aussi — une icône de note de carte de Foundry
ou n'importe quelle image — et survoler une épingle affiche son nom.

**L'écriture d'un accessoire et son apparition se choisissent.** L'onglet Apparence du
Studio règle une police — avec empattements, sans empattements, machine à écrire,
manuscrite, ou toute police de votre monde, y compris une police ajoutée dans la
configuration des polices de Foundry — et un son de révélation. Sinon, l'effet décide :
Balayage cathodique, Relevé projeté, Balisé et Perte de signal écrivent en chasse fixe,
Parchemin vieilli et Sceau de cire avec empattements, et les groupes *Typographie* et
*Révélation* du Studio de préréglages règlent la police, l'apparition, la durée et le son
d'un effet. *Ajuster au contenu* mesure dans la police choisie. Un son de révélation est
joué pour chaque joueur quand l'accessoire apparaît sur son écran, au volume Environnement
— vous l'entendez avec ▶, votre écran ne le voyant jamais apparaître — et doit être un
fichier de votre propre serveur : un préréglage partagé qui nomme une adresse web est
refusé à l'import.

**Un acteur devient un avis de recherche, un objet une trouvaille.** L'accessoire montre
son image — le portrait d'un acteur, sinon celui de son jeton —, son nom, et l'un de ses
textes : *Texte affiché*, dans le Studio, liste chaque champ de texte enrichi que votre
système de jeu donne à ce type d'acteur ou d'objet, et *Automatique* choisit d'abord un
texte public, puis une biographie ou une description, jamais un champ que son nom réserve
au MJ. Ses sections secrètes n'atteignent que ses propriétaires et vous. Révéler un acteur
le partage en accès Limité au plus, et une nouvelle épingle d'acteur — ou une épingle
dirigée vers un acteur depuis le Studio — commence avec *Accorder l'accès au document*
désactivé : l'avis se lit sur place sans lui. Un acteur s'épingle depuis son menu
contextuel, sa fiche, *Épingler un document* ou `/pin` ; le glisser sur la carte reste le
jeton de Foundry, sauf si la touche de glisser-épingler est Ctrl ou Maj.

*Épingler un document* cherche dans les journaux, les acteurs et les objets — ceux du
monde, puis ceux de chaque compendium dès deux lettres — avec une pastille pour n'en
montrer qu'un type.

Également : un bouton dans l'en-tête des fiches de journal, d'acteur et d'objet, les
contrôles de scène Notes, les menus contextuels de la barre latérale et des fenêtres de
compendium, une case sur la fiche de n'importe quelle tuile pour l'adopter, et un bouton
sur une note de carte pour la convertir.

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
| Modificateur de glisser-épingler | client | Alt, Ctrl, Maj, aucun — un acteur seulement avec Ctrl ou Maj |
| Forme / visibilité par défaut | monde | Ce que devient un document nouvellement posé — un accessoire visible de tous, tant que vous ne le changez pas |
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

**La mise en lumière ne déplace les vues que pour une épingle destinée à tous.** Un ping
de Foundry atteint chaque joueur connecté, quel que soit le public de l'épingle : amener
toute la table sur une note destinée à un seul joueur montrerait aux autres où elle se
trouve. *Révéler et mettre en lumière* (le HUD, `Maj+Espace` ou le menu de ligne du tableau
de bord) révèle l'épingle à son propre public dans tous les cas, et n'amène les vues que si
ce public est tout le monde ; sinon elle la désigne sur votre seul écran, et le dit.
*Révéler la suivante* ne déplace jamais de vue, et ne pulse sur la carte des joueurs que
pour une épingle destinée à tous. *Faire clignoter* pulse toujours sur la carte de chaque
joueur pour toute épingle visible, comme son libellé l'indique.

## Limitations connues

1. Une vidéo n'affiche qu'une seule image.
2. Un **PDF** épinglé affiche sa page, et c'est le seul type d'accessoire dessiné *dans*
   la scène : il est donc éclairé, embrumé, occulté et passe derrière les pions,
   contrairement à une page de journal. La page affichée se choisit dans le Studio.
3. Une épingle posée sur un **journal entier dont la première page est un PDF** affiche un
   substitut plutôt que la page : le module interroge le type de la source résolue, et
   c'est le journal. Choisissez la page explicitement dans le Studio et elle est dessinée.
4. Les images référencées par une page de journal sont intégrées ; ce que le module ne peut
   pas récupérer est retiré plutôt que laissé cassé.
5. **Les accessoires de texte s'assombrissent avec la scène, mais ne sont ni éclairés par
   ses lumières, ni embrumés, ni occultés, ni placés derrière les pions.** Les dessiner
   dans la scène exige une conversion HTML → texture : un SVG avec `foreignObject`, qui
   contaminait le canevas dans tous les navigateurs mesurés, si bien que l'envoi WebGL
   échouait. Le module teste cela au démarrage et dessine les accessoires en HTML
   par-dessus le canevas, assombris par le niveau d'obscurité global de la scène et par
   rien d'autre — sauf sur le support Projection, qui est de la lumière et reste vif. Un
   accessoire de texte révélé se voit donc à travers un brouillard que le joueur n'a pas
   exploré : révélez-le quand ils l'atteignent — l'onglet Audience du Studio le rappelle.
   *Ce test réussit désormais sur Chrome et Firefox actuels* — voir
   [`docs/DESIGN.md`](docs/DESIGN.md) A21 — la voie est donc peut-être rouverte ; rien
   n'a été changé tant que toute la chaîne n'aura pas été mesurée dans un vrai monde, et
   pas seulement le test.
6. Supprimer un document épinglé laisse l'épingle sur un substitut — jamais supprimée
   automatiquement.
7. Un document de compendium peut être épinglé, et s'affiche pour les joueurs dont le
   rôle peut ouvrir ce compendium — Observateur pour leur rôle. Les autres voient un
   substitut qui dit pourquoi, et vous en êtes prévenu en le posant : *Épingler un
   document* grise une telle ligne et propose *Importer et épingler*, qui en crée une copie
   — d'un journal, d'un acteur ou d'un objet — dans un dossier « Documents Pinner » de son
   type, que vous partagez comme tout autre document de votre monde. Les permissions d'un
   compendium valent par rôle et pour tout le pack : une révélation ne les change jamais
   et n'ajoute rien à la barre latérale de quiconque. Une page PDF d'un compendium est
   dessinée comme une carte. Une épingle masquée sur un compendium que vos joueurs peuvent
   ouvrir porte le glyphe de clé sur leurs pastilles : ils peuvent déjà la lire dans le
   compendium.
8. Les épingles sont de vraies tuiles et apparaissent dans `scene.tiles` aux autres modules,
   par conception.
9. *Ajuster au contenu* ne peut pas mesurer une épingle d'image nue — une image n'a pas
   de texte à mesurer — et laisse alors sa hauteur inchangée en le disant.
10. Le portrait d'un acteur ou l'image d'un objet hébergés sur un autre serveur — un
    hébergeur de fichiers, un CDN — s'affichent sur la couche HTML, mais sont retirés là
    où un accessoire est dessiné dans la scène, comme toute image que le module ne peut pas
    récupérer (4).
11. Un acteur est partagé en accès Limité au plus. Ce que montre une fiche en accès Limité
    — le portrait, la biographie ou toute la fiche — dépend de votre système de jeu, pas
    de ce module. *Montrer aux joueurs* n'ouvre que des journaux : l'épingle d'un acteur
    ou d'un objet se montre en la révélant.
12. Un objet possédé par un acteur et l'acteur propre d'un jeton ne peuvent pas être
    épinglés : leurs permissions sont celles de leur propriétaire. Épinglez l'acteur, ou
    l'objet depuis la barre latérale.
13. Avec Alt comme touche de glisser-épingler — la valeur par défaut —, glisser un acteur
    avec Alt pose toujours le jeton caché de Foundry, et sans touche réglée, glisser un
    acteur pose toujours un jeton. Réglez la touche sur Ctrl ou Maj pour épingler un
    acteur en le glissant.

## Développement

```bash
npm install
npm test        # tests unitaires et d'intégration
npm run build   # -> dist/documents-pinner.mjs
npm run watch
npm run harness # -> tests/harness/effects.html, à ouvrir dans deux navigateurs
```

Créez un lien symbolique du dépôt dans `Data/modules/documents-pinner` et appuyez sur `F5`
dans Foundry. Le CSS ne fait pas partie de la construction.

Les notes de conception, le modèle de sécurité et les critères d'acceptation sont dans
[`docs/DESIGN.md`](docs/DESIGN.md).

MIT — voir [LICENSE](LICENSE).
