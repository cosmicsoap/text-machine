# Lire le code de Text Machine

Ce guide est fait pour quelqu'un qui découvre la programmation et veut
comprendre comment Text Machine est construit. Pas besoin de tout lire :
suivez la visite dans l'ordre, et ouvrez les fichiers au fur et à mesure.
Chaque fichier commence par un commentaire qui dit à quoi il sert.

**Sommaire**

1. [L'idée générale en une image](#1-lidée-générale-en-une-image)
2. [Les trois langages](#2-les-trois-langages)
3. [Le plan des dossiers](#3-le-plan-des-dossiers)
4. [Par où commencer : une visite en 8 étapes](#4-par-où-commencer--une-visite-en-8-étapes)
5. [Le voyage d'une touche : de la frappe au fichier enregistré](#5-le-voyage-dune-touche--de-la-frappe-au-fichier-enregistré)
6. [Le voyage inverse : ouvrir un fichier Word](#6-le-voyage-inverse--ouvrir-un-fichier-word)
7. [Où trouver chaque fonctionnalité](#7-où-trouver-chaque-fonctionnalité)
8. [Comment lire un fichier Rust](#8-comment-lire-un-fichier-rust)
9. [Comment lire un fichier TypeScript](#9-comment-lire-un-fichier-typescript)
10. [Lancer l'application et les tests soi-même](#10-lancer-lapplication-et-les-tests-soi-même)
11. [Lexique](#11-lexique)

---

## 1. L'idée générale en une image

Text Machine est une **application de bureau** faite de deux moitiés qui se
parlent :

```
┌────────────────────────────── Fenêtre de Text Machine ─────────────────────────────┐
│                                                                                     │
│   L'ÉDITEUR (dossier app/src)                       LE CŒUR (dossiers crates/ et    │
│   TypeScript, dans une page web                      app/src-tauri), en Rust        │
│                                                                                     │
│   • ce que vous voyez : menus, pages, onglets        • lit et écrit les fichiers    │
│   • la saisie du texte (bibliothèque TipTap)          Word, Markdown, texte         │
│   • la mise en forme, les commentaires,              • compte les mots              │
│     les suggestions, la pagination…                  • exporte en PDF               │
│                                                      • se souvient des fichiers     │
│                 ───── invoke("save_document", …) ────▶  récents, des versions…      │
│                 ◀──────────── réponse ───────────────                               │
│                                                                                     │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **L'éditeur** est une vraie page web (HTML, CSS, TypeScript), affichée
  dans la fenêtre par le moteur web du système (WebKit sur Mac, celui de
  Safari ; WebView2 sur Windows, celui d'Edge). On n'embarque pas de
  navigateur complet : c'est pourquoi l'application est légère.
- **Le cœur** est un programme Rust. Il a accès au disque dur, ce qu'une
  page web ne peut pas faire seule.
- **Tauri** est le « pont » entre les deux : il ouvre la fenêtre, y met la
  page web, et permet à la page d'appeler des fonctions Rust avec
  `invoke("nom_de_la_fonction", { paramètres })`.

Entre les deux moitiés, le document voyage sous forme de **JSON** (du texte
structuré, voir le lexique). Le même JSON est compris des deux côtés : c'est
le format de TipTap, l'éditeur de texte utilisé dans la page.

Le cœur est découpé en **crates** (des bibliothèques Rust) qui ne savent
rien de l'interface : un jour, on pourra remplacer la page web par une
interface 100 % Rust sans toucher à la lecture des fichiers Word.

## 2. Les trois langages

| Langage | Extension | Où | Rôle |
|---|---|---|---|
| **Rust** | `.rs` | `crates/`, `app/src-tauri/src/` | Le cœur : fichiers, calculs, PDF. Langage rapide et très strict : s'il compile, il plante rarement. |
| **TypeScript** | `.ts` | `app/src/` | L'éditeur : tout ce qui réagit aux clics et aux touches. C'est du JavaScript avec des **types** (on écrit `n: number` pour dire que `n` est un nombre), vérifiés avant le lancement. |
| **HTML / CSS** | `.html`, `.css` | `app/index.html`, `app/src/styles.css` | La structure de la fenêtre (boutons, menus, boîtes de dialogue) et son apparence (couleurs, tailles, marges). |

Il y a aussi quelques fichiers de **réglages** : `Cargo.toml` (Rust),
`package.json` (JavaScript), `tauri.conf.json` (Tauri) et les fichiers
`.yml` de `.github/workflows/` (les robots de GitHub).

## 3. Le plan des dossiers

```
text-machine/
├── README.md                 Présentation du projet (fonctionnalités, téléchargement)
├── LIRE-LE-CODE.md           Ce guide
├── CHANGELOG.md              Nouveautés, version par version (onglet « Nouveautés » du guide intégré)
├── CLAUDE.md                 Consignes pour Claude, qui écrit le code
├── Cargo.toml                Liste des crates Rust du projet (« l'espace de travail »)
├── docs/
│   └── guide.md              Le guide intégré (Aide > Guide de Text Machine)
│
├── crates/                   LE CŒUR RUST, indépendant de toute interface
│   ├── tm-model/             À quoi ressemble un document (paragraphes, titres, onglets, styles…)
│   ├── tm-ops/               Opérations sur un document + annuler/rétablir (pas encore branché à l'éditeur)
│   ├── tm-io-native/         Le format interne .tmd (utilisé pour le brouillon)
│   ├── tm-io-docx/           Lecture et écriture des fichiers Word (.docx)
│   └── tm-io-markdown/       Lecture et écriture Markdown (.md) et texte brut (.txt)
│
├── app/                      L'APPLICATION
│   ├── index.html            La fenêtre : menus, barre d'outils, panneaux, boîtes de dialogue
│   ├── package.json          Les bibliothèques JavaScript utilisées (TipTap, Tauri…)
│   ├── vite.config.ts        Réglages de Vite, l'outil qui assemble la page web
│   ├── src/                  L'ÉDITEUR (TypeScript)
│   │   ├── main.ts           Le chef d'orchestre : crée l'éditeur et relie tout
│   │   ├── schema.ts         Ce qu'un document peut contenir (liste des extensions TipTap)
│   │   ├── extensions/       Les ajouts à TipTap : pagination, notes, suggestions, commentaires…
│   │   ├── tabs.ts           Les onglets du document
│   │   ├── menus.ts          La barre de menus
│   │   ├── stylesheet.ts     La feuille de styles (Texte normal, Titre 1…)
│   │   ├── fonts.ts          Les polices
│   │   ├── comments.ts       Les commentaires dans la marge
│   │   ├── compare.ts        La comparaison côte à côte des versions
│   │   ├── …                 (un fichier par grande fonctionnalité, voir la partie 7)
│   │   └── styles.css        L'apparence de toute l'interface
│   └── src-tauri/            LE PONT (Rust) entre l'éditeur et les crates
│       ├── tauri.conf.json   Nom de l'application, taille de la fenêtre, icônes, mises à jour
│       ├── capabilities/     Ce que la page web a le droit de demander (ouvrir un fichier…)
│       └── src/
│           ├── main.rs       Le point de départ du programme (3 lignes)
│           ├── lib.rs        Toutes les « commandes » que l'éditeur peut appeler
│           ├── formats.rs    Choisit Word, Markdown ou texte d'après l'extension du fichier
│           ├── session.rs    Fichiers récents, dernier fichier, brouillon
│           ├── versions.rs   Versions enregistrées (Fichier > Versions)
│           ├── fonts.rs      Polices de l'ordinateur et polices importées
│           ├── pdf.rs        Export PDF
│           └── guide.rs      Fabrique le guide intégré
│
└── .github/workflows/        LES ROBOTS DE GITHUB
    ├── tests.yml             À chaque modification : lance les tests
    └── applications.yml      Fabrique le .dmg (Mac) et le .exe (Windows) et les publie
```

Le dossier `target/` (et `app/node_modules/`, `app/dist/`) n'est pas dans
le dépôt : il est créé à la compilation et contient les programmes
fabriqués et les bibliothèques téléchargées.

## 4. Par où commencer : une visite en 8 étapes

Comptez une petite heure. Pour chaque étape : le fichier, et ce qu'il faut
y regarder.

1. **[crates/tm-model/src/lib.rs](crates/tm-model/src/lib.rs)**, juste le
   début (jusqu'à la fin de `enum Block`). C'est la définition d'un document : un
   `Document` contient des `Block` (paragraphe, titre, liste, tableau…),
   et un bloc de texte contient des `Inline` (du texte, avec ses `Mark` :
   gras, italique, lien…). Tout le reste du programme manipule ces formes.
   Le test [crates/tm-model/tests/tiptap.rs](crates/tm-model/tests/tiptap.rs)
   et son fichier [fixtures/tiptap-starterkit.json](crates/tm-model/tests/fixtures/tiptap-starterkit.json)
   montrent un vrai document au format JSON.

2. **[app/src-tauri/src/main.rs](app/src-tauri/src/main.rs)** puis
   **[app/src-tauri/src/lib.rs](app/src-tauri/src/lib.rs)**. Le
   programme démarre dans `main`, qui appelle `run()`, tout en bas de
   `lib.rs`. Plus haut, chaque fonction marquée `#[tauri::command]` est
   une porte que l'éditeur peut ouvrir. Lisez `open_document` et
   `save_document` : quatre lignes chacune.

3. **[app/src-tauri/src/formats.rs](app/src-tauri/src/formats.rs)**,
   fonctions `read` et `write`. Selon l'extension (`.docx`, `.md`,
   `.txt`), on passe la main au bon crate.

4. **[app/index.html](app/index.html)**. Survolez : vous reconnaîtrez la
   fenêtre (la barre d'outils, le panneau de gauche, la page, les boîtes de
   dialogue). Chaque élément a un `id` (par exemple `id="toolbar"`) que le
   TypeScript retrouve pour le faire réagir.

5. **[app/src/main.ts](app/src/main.ts)**. C'est le plus gros fichier.
   Lisez le plan en tête du fichier, puis la création de l'éditeur
   (`const editor = new Editor({ … })`), puis la partie
   « Fichiers » (`markDirty`, `autosave`, `writeFile`, `loadFile`) et,
   tout à la fin, « Démarrage ».

6. **[app/src/schema.ts](app/src/schema.ts)**. La liste de tout ce qu'un
   document peut contenir côté éditeur. Chaque ligne est une
   **extension** TipTap : certaines viennent de TipTap (gras, tableaux,
   images), d'autres sont à nous (dossier `extensions/`).

7. **Une extension simple** :
   [app/src/extensions/focus-paragraph.ts](app/src/extensions/focus-paragraph.ts)
   (40 lignes, le paragraphe en cours reste net, les autres pâlissent),
   puis une plus riche :
   [app/src/extensions/pagination.ts](app/src/extensions/pagination.ts)
   (comment on découpe le texte en pages à l'écran).

8. **[app/src/tabs.ts](app/src/tabs.ts)**. Une seule zone d'édition sert
   à tous les onglets : changer d'onglet, c'est ranger l'état de l'onglet
   actuel et sortir celui du suivant (fonction `show`).

Ensuite, suivez votre curiosité avec la partie 7.

## 5. Le voyage d'une touche : de la frappe au fichier enregistré

Vous tapez la lettre « a » dans un document `Roman.docx`. Voici ce qui se
passe, étape par étape :

1. **La page web reçoit la touche.** La zone de texte est gérée par
   **ProseMirror**, le moteur sur lequel TipTap est construit. Il ne
   laisse pas le navigateur modifier la page tout seul : il crée une
   **transaction** (« insérer "a" à la position 1234 »), calcule le
   nouveau document, et redessine seulement ce qui a changé.

2. **Les extensions regardent la transaction.** Par exemple, en mode
   suggestion, [extensions/suggestions.ts](app/src/extensions/suggestions.ts)
   ajoute la marque « ajouté » au « a ». La pagination
   ([extensions/pagination.ts](app/src/extensions/pagination.ts)) mesure
   de nouveau les paragraphes et décale à la page suivante ceux qui ne
   tiennent plus.

3. **L'éditeur prévient `main.ts`.** Dans [main.ts](app/src/main.ts),
   l'option `onUpdate` de `new Editor({ … })` est appelée. Elle lance
   `markDirty()` : le titre affiche « Modifications non enregistrées » et
   un minuteur de 1,5 seconde démarre. Chaque nouvelle touche relance le
   minuteur : on n'enregistre pas à chaque lettre, seulement quand vous
   faites une pause.

4. **Le minuteur arrive au bout : `autosave()`.** Le document a un nom,
   donc on appelle `writeFile(chemin)`. Sinon (document « Sans titre »),
   on enregistre un brouillon.

5. **On rassemble le document : `fileData()`.** Il demande à chaque
   onglet son contenu en JSON (`tabs.toData()`), et y joint le format de
   page et la feuille de styles. Ça donne un objet de la forme :

   ```json
   {
     "tabs": [{ "title": "Onglet 1", "document": { "type": "doc", "content": [ … ] } }],
     "page": { "size": "A4", "margins": { … }, … },
     "styles": { "normal": { … }, … }
   }
   ```

6. **On passe le pont : `invoke("save_document", { path, file })`.**
   Tauri transforme cet objet en texte JSON, le transmet au programme
   Rust, et appelle la fonction `save_document` de
   [src-tauri/src/lib.rs](app/src-tauri/src/lib.rs).

7. **Rust relit le JSON.** Grâce à la bibliothèque **serde**, le JSON
   devient automatiquement une valeur Rust de type `NativeFile` (défini
   dans [tm-io-native](crates/tm-io-native/src/lib.rs)), avec ses
   `Tab`, `Document`, `Block`… de [tm-model](crates/tm-model/src/lib.rs).
   Si le JSON ne correspond pas à la forme attendue, l'erreur remonte à
   l'éditeur.

8. **On choisit le format : `formats::write`.** L'extension est `.docx`,
   donc [formats.rs](app/src-tauri/src/formats.rs) appelle
   `tm_io_docx::export`. Word ne connaît pas les onglets : ils sont mis à
   la suite (`flattened()`), chacun précédé d'un titre de style
   « TM Onglet ».

9. **On fabrique le fichier Word.** Un `.docx` est en réalité un dossier
   compressé (ZIP) de fichiers XML. [tm-io-docx](crates/tm-io-docx/src/lib.rs)
   traduit chaque paragraphe, chaque mise en forme, chaque style en XML
   Word, avec l'aide de la bibliothèque `docx-rs`. Notes de bas de page et
   commentaires sont ajoutés ensuite (`notes.rs`, `comments.rs`).

10. **On écrit sur le disque, sans risque.** Le fichier est d'abord écrit
    sous un nom temporaire (`Roman.docx.tm-tmp`), puis renommé. Si
    l'ordinateur s'éteint au milieu, l'ancien fichier reste intact.

11. **La réponse revient.** `save_document` note le fichier dans les
    récents (`session.rs`), puis répond « c'est fait ». Côté éditeur,
    `writeFile` affiche « Enregistré ».

Le tout prend une fraction de seconde.

## 6. Le voyage inverse : ouvrir un fichier Word

1. Fichier > Ouvrir : `openFile()` dans [main.ts](app/src/main.ts) ouvre
   la fenêtre de choix du système (module `plugin-dialog` de Tauri).
2. `openPath(chemin)` appelle `invoke("open_document", { path })`.
3. Côté Rust, `formats::read` appelle `tm_io_docx::open`
   ([import.rs](crates/tm-io-docx/src/import.rs)), qui lit le XML de Word
   et reconstruit un `Document`.
4. `NativeFile::from_flat` redécoupe le document en onglets aux titres
   « TM Onglet » (`split_tabs` dans tm-model).
5. Le résultat revient en JSON à l'éditeur, et `loadFile()` le répartit :
   onglets (`tabs.load`), styles (`setStyles`), format de page
   (`setPageSetup`).

## 7. Où trouver chaque fonctionnalité

| Fonctionnalité | Éditeur (TypeScript) | Cœur (Rust) |
|---|---|---|
| Saisie et mise en forme de base | `schema.ts` (TipTap), `main.ts` (barre d'outils, `refreshToolbar`) | `tm-model` |
| Pages, marges, sauts de page | `extensions/pagination.ts`, `main.ts` (« Pages… ») | `PageSetup` dans `tm-model` |
| En-têtes et pieds de page | `headers.ts` | `tm-io-docx` |
| Onglets | `tabs.ts`, `main.ts` (« Panneau de gauche ») | `Tab`, `flatten_tabs`, `split_tabs` dans `tm-model` |
| Styles de paragraphe et de caractère | `stylesheet.ts`, `extensions/custom-styles.ts`, `main.ts` (« Feuille de styles ») | `StyleSheet` dans `tm-model`, styles Word dans `tm-io-docx` |
| Polices | `fonts.ts` | `src-tauri/src/fonts.rs` |
| Interligne, retraits | `extensions/paragraph-format.ts` | `BlockStyle` dans `tm-model` |
| Notes de bas de page | `extensions/footnote.ts`, `notes.ts` | `tm-io-docx/src/notes.rs` |
| Table des matières | `extensions/toc.ts` | `headings_by_tab` dans `tm-model` |
| Commentaires | `extensions/comments.ts`, `comments.ts` | `tm-io-docx/src/comments.rs` |
| Mode suggestion | `extensions/suggestions.ts`, `main.ts` (« Mode suggestion ») | marques `Insertion`/`Deletion` |
| Versions et comparaison | `compare.ts`, `diff.ts`, `extensions/diff-highlight.ts` | `src-tauri/src/versions.rs` |
| Rechercher / remplacer | `extensions/search.ts` | — |
| Nombre de mots | `main.ts` (« Nombre de mots ») | `TextStats` dans `tm-model` |
| Plein écran, sans distraction | `focus.ts`, `extensions/focus-paragraph.ts` | — |
| Menus | `menus.ts` (affichage), `main.ts` (contenu des menus) | — |
| Barre d'outils trop large | `toolbar-overflow.ts` | — |
| Mac / Windows (raccourcis) | `platform.ts` | — |
| Enregistrement, brouillon, récents | `main.ts` (« Fichiers ») | `src-tauri/src/session.rs`, `formats.rs` |
| Markdown | — | `tm-io-markdown` |
| Export PDF | `main.ts` (`exportPdf`) | `src-tauri/src/pdf.rs` |
| Guide intégré | `main.ts` (« Guide intégré ») | `src-tauri/src/guide.rs`, `docs/guide.md`, `CHANGELOG.md` |
| Mises à jour automatiques | `updates.ts` | `tauri.conf.json`, `.github/workflows/applications.yml` |
| Double-clic sur un fichier | `main.ts` (`openRequestedFiles`) | `lib.rs` (« Fichiers ouverts d'un double-clic ») |

Astuce : sur GitHub, appuyez sur la touche `t` dans le dépôt pour chercher
un fichier par son nom, et utilisez la loupe en haut pour chercher un mot
dans tout le code (par exemple `markDirty`).

## 8. Comment lire un fichier Rust

Un petit exemple, tiré de `lib.rs` :

```rust
/// Exporte une copie (Word, Markdown, texte…) sans changer le fichier ouvert.
#[tauri::command]
fn export_document(path: String, file: NativeFile) -> Result<(), String> {
    formats::write(&path, &file)
}
```

- `///` : un commentaire de documentation (il décrit ce qui suit). `//!`
  en tête de fichier décrit le fichier entier, et `//` est un commentaire
  ordinaire.
- `#[tauri::command]` : un **attribut**, une étiquette posée sur la
  fonction. Celui-ci dit à Tauri « l'éditeur a le droit d'appeler cette
  fonction ».
- `fn export_document(path: String, file: NativeFile)` : une fonction
  (`fn`) qui reçoit un texte (`String`) et un `NativeFile`.
- `-> Result<(), String>` : ce qu'elle renvoie. `Result` veut dire « soit
  ça a marché (`Ok(…)`), soit une erreur (`Err(…)`) ». Ici, en cas de
  succès il n'y a rien à renvoyer (`()`, « rien »), et l'erreur est un
  texte qui sera affiché.
- `&path` : on **prête** `path` à `formats::write` sans le lui donner
  (le `&`). Rust surveille qui possède chaque valeur : c'est ce qui le
  rend sûr.
- La dernière ligne sans `;` est la valeur renvoyée.

Autres choses que vous croiserez :

- `struct` : un type avec des champs nommés (comme une fiche). `enum` :
  un type qui est **l'un ou l'autre** de plusieurs cas (un `Block` est un
  paragraphe, **ou** un titre, **ou** une liste…). `match` examine
  lequel.
- `impl Document { … }` : les fonctions attachées à un type
  (`doc.stats()`).
- `Option<T>` : une valeur qui peut être absente (`Some(valeur)` ou
  `None`).
- `?` à la fin d'un appel : « si c'est une erreur, arrête-toi ici et
  renvoie-la ».
- `#[derive(Serialize, Deserialize)]` : demande à **serde** d'écrire tout
  seul la conversion vers et depuis le JSON. Les `#[serde(…)]` règlent les
  détails (noms des champs, valeurs par défaut).
- `use …;` : importe un nom d'un autre fichier ou d'une bibliothèque.
  `mod fonts;` : ce fichier inclut le fichier `fonts.rs`.
- `#[test]` et `#[cfg(test)]` : des tests, lancés par `cargo test`.

## 9. Comment lire un fichier TypeScript

Un petit exemple, tiré de `main.ts` :

```ts
/** Appelé à chaque modification du document ou de ses réglages. */
function markDirty() {
  if (loading) return;
  dirty = true;
  setSaveStatus("Modifications non enregistrées");
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(autosave, AUTOSAVE_DELAY_MS);
}
```

- `/** … */` : commentaire de documentation ; `//` : commentaire ordinaire.
- `function markDirty() { … }` : une fonction. `if (loading) return;` :
  si on est en train de charger, on s'arrête.
- `setTimeout(autosave, 1500)` : « appelle `autosave` dans 1,5 seconde ».
  `clearTimeout` annule le minuteur précédent.

Autres choses que vous croiserez :

- `const x = …` (ne change plus) et `let x = …` (peut changer).
- `(a, b) => a + b` : une petite fonction écrite en raccourci.
- `async function` et `await` : pour les actions qui prennent du temps
  (lire un fichier, demander quelque chose à Rust). `await` attend la
  réponse sans bloquer la fenêtre.
- `interface NativeFile { tabs: TabData[]; … }` : décrit la forme d'un
  objet (`TabData[]` = une liste de `TabData`). C'est la partie
  « Type » de TypeScript : elle disparaît une fois le programme
  assemblé.
- `x?.y` : « `y` de `x`, si `x` existe ». `x ?? 0` : « `x`, ou `0` s'il
  est absent ».
- `import { Editor } from "@tiptap/core"` : prend `Editor` dans la
  bibliothèque TipTap. `export` rend un nom utilisable par les autres
  fichiers.
- `` `Bonjour ${nom}` `` : un texte où `${…}` est remplacé par une valeur.
- `$("#toolbar")` : petite fonction de `main.ts` qui trouve dans la page
  l'élément HTML d'`id` `toolbar`.
- `class TabTree { … }` : un « moule » qui regroupe des données et les
  fonctions qui les manipulent (`tabs.load(…)`, `tabs.flat()`).

## 10. Lancer l'application et les tests soi-même

Ce n'est pas nécessaire pour lire le code, mais si l'envie vous prend, sur
Mac :

1. Installez **Rust** (https://rustup.rs) et **Node.js** (https://nodejs.org).
2. Dans le Terminal, dans le dossier du projet :

   ```sh
   cargo test --workspace --exclude text-machine   # les tests du cœur Rust
   cd app
   npm install                                     # télécharge TipTap, Tauri…
   npm run tauri dev                               # lance Text Machine en mode développement
   ```

En mode développement, une modification d'un fichier `.ts` ou `.css`
s'affiche aussitôt dans la fenêtre ; une modification d'un fichier `.rs`
relance l'application. Clic droit > « Inspecter l'élément » ouvre les
outils du moteur web, et la console y connaît la variable `editor`.

Les tests sont dans les fichiers Rust, dans des blocs `#[cfg(test)]`
(souvent tout en bas du fichier), et dans `crates/tm-model/tests/`. Ils
montrent bien ce qu'une fonction est censée faire : c'est une bonne façon
de lire un crate.

## 11. Lexique

- **Application de bureau** : un programme installé sur l'ordinateur,
  par opposition à un site web.
- **Attribut (Rust)** : étiquette `#[…]` posée sur une fonction ou un
  type, qui change la façon dont il est compilé.
- **Attribut (document)** : un réglage porté par un élément, par exemple
  le niveau d'un titre (`level: 2`) ou l'alignement d'un paragraphe.
- **Bibliothèque** : du code écrit par d'autres, qu'on réutilise
  (TipTap, serde, docx-rs…).
- **Bloc** : un élément qui occupe sa propre ligne dans le document :
  paragraphe, titre, liste, tableau, image.
- **Cargo** : l'outil de Rust qui compile, lance les tests et télécharge
  les crates. `Cargo.toml` en est le réglage.
- **Commande Tauri** : une fonction Rust marquée `#[tauri::command]`,
  que l'éditeur appelle avec `invoke`.
- **Commit** : un enregistrement d'une modification du code dans
  l'historique Git, avec un message qui l'explique.
- **Compiler** : transformer le code écrit par un humain en programme
  que l'ordinateur exécute. Rust est compilé ; TypeScript est traduit en
  JavaScript.
- **Crate** : une bibliothèque (ou un programme) Rust. Text Machine en a
  plusieurs, une par sujet.
- **CSS** : le langage qui décrit l'apparence (couleurs, tailles,
  positions).
- **Décoration (ProseMirror)** : un élément affiché dans l'éditeur sans
  faire partie du document : surlignage de recherche, espace entre deux
  pages, différences en couleur.
- **DOM** : la page web telle que le navigateur la garde en mémoire :
  un arbre d'éléments HTML que le code peut lire et modifier.
- **Extension TipTap** : un ajout à l'éditeur : un nouveau type de
  bloc, une marque, un raccourci, un comportement.
- **Git / GitHub** : Git garde l'historique du code ; GitHub héberge le
  dépôt en ligne, avec les pull requests et les robots.
- **HTML** : le langage qui décrit la structure d'une page (titres,
  boutons, zones).
- **Inline** : un morceau à l'intérieur d'une ligne de texte : du texte,
  un retour à la ligne, un appel de note.
- **`invoke`** : la fonction de Tauri qui, depuis la page web, appelle
  une commande Rust et attend sa réponse.
- **JSON** : un format de texte pour décrire des données :
  `{"type": "paragraph", "content": [{"type": "text", "text": "Bonjour"}]}`.
- **Marque (mark)** : une mise en forme posée sur du texte : gras,
  italique, lien, couleur, commentaire, suggestion.
- **Markdown** : un format de texte simple où `# Titre` fait un titre et
  `**gras**` met en gras.
- **Module** : un fichier de code (ou un groupe de fichiers) qui regroupe
  ce qui va ensemble.
- **npm** : l'outil de JavaScript qui télécharge les bibliothèques
  listées dans `package.json`.
- **Plugin** : un module ajouté à Tauri (dialogues, mises à jour) ou à
  ProseMirror (pagination, suggestions).
- **ProseMirror** : le moteur d'édition de texte sur lequel TipTap est
  construit. Il garde le document, la sélection et l'historique dans un
  **état** (`EditorState`) et le modifie par **transactions**.
- **Pull request (PR)** : une proposition de modification du code sur
  GitHub, qu'on relit et qu'on fusionne ensuite dans `main`.
- **Rust** : le langage du cœur, connu pour sa rapidité et sa sûreté.
- **Schéma** : la liste de ce qu'un document peut contenir, et de ce qui
  peut aller dans quoi (une cellule dans une ligne, une ligne dans un
  tableau).
- **serde** : la bibliothèque Rust qui convertit les valeurs Rust en JSON
  et inversement.
- **Tauri** : l'outil qui fait d'une page web une application de bureau,
  avec un cœur en Rust.
- **Test** : un petit programme qui vérifie qu'une fonction fait bien ce
  qu'on attend. Les robots de GitHub les lancent à chaque modification.
- **TipTap** : la bibliothèque d'éditeur de texte utilisée dans la page
  (basée sur ProseMirror).
- **Transaction** : un changement de l'état de l'éditeur (taper,
  effacer, mettre en gras, déplacer le curseur).
- **TypeScript** : JavaScript avec des types vérifiés.
- **Vite** : l'outil qui assemble les fichiers TypeScript et CSS en une
  page web prête à afficher.
- **WebView** : le moteur web du système (WebKit sur Mac) qui affiche
  la page dans la fenêtre de l'application.
- **Workflow (GitHub Actions)** : une liste de tâches qu'un robot de
  GitHub exécute tout seul (tests, fabrication des applications).
- **XML** : un format de texte à balises (`<w:p>…</w:p>`) ; l'intérieur
  d'un fichier Word en est fait.
