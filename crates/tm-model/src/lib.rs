//! Modèle de document de Text Machine.
//!
//! Ce crate ne dépend d'aucune interface graphique. Sa représentation JSON
//! suit volontairement celle de ProseMirror / TipTap (`{"type": "doc",
//! "content": [...]}`) : l'éditeur web peut ainsi envoyer son document tel
//! quel au cœur Rust, et une future vue native pourra réutiliser le même
//! modèle.
//!
//! Comment lire ce fichier : un [`Document`] contient des [`Block`]
//! (paragraphe, titre, liste, tableau…). Les blocs de texte contiennent des
//! [`Inline`] (du texte, un retour à la ligne, un appel de note), et le texte
//! porte des [`Mark`] (gras, italique, lien, couleur…). Viennent ensuite les
//! onglets ([`Tab`]), la feuille de styles ([`StyleSheet`]) et le format des
//! pages ([`PageSetup`]).
//!
//! Les lignes `#[derive(Serialize, Deserialize)]` et `#[serde(…)]` demandent
//! à la bibliothèque serde d'écrire toute seule la conversion en JSON. Par
//! exemple, `#[serde(tag = "type", rename_all = "camelCase")]` sur
//! [`Block`] fait que `Block::Paragraph { content, .. }` s'écrit
//! `{"type": "paragraph", "content": [...]}`, exactement comme TipTap.
//! `#[serde(default)]` : si le champ manque dans le JSON, on prend la
//! valeur par défaut ; `skip_serializing_if` : on ne l'écrit pas s'il est
//! vide, pour garder des fichiers courts.

use serde::{Deserialize, Serialize};

/// Un document complet : une suite de blocs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(tag = "type", rename = "doc")]
pub struct Document {
    #[serde(default)]
    pub content: Vec<Block>,
}

/// Les blocs (paragraphes, titres, listes…).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Block {
    Paragraph {
        #[serde(default, skip_serializing_if = "BlockStyle::is_empty")]
        attrs: BlockStyle,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<Inline>,
    },
    Heading {
        attrs: HeadingAttrs,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<Inline>,
    },
    Blockquote {
        #[serde(default)]
        content: Vec<Block>,
    },
    BulletList {
        #[serde(default)]
        content: Vec<Block>,
    },
    OrderedList {
        #[serde(default)]
        attrs: OrderedListAttrs,
        #[serde(default)]
        content: Vec<Block>,
    },
    ListItem {
        #[serde(default)]
        content: Vec<Block>,
    },
    /// Liste de cases à cocher.
    TaskList {
        #[serde(default)]
        content: Vec<Block>,
    },
    TaskItem {
        #[serde(default)]
        attrs: TaskItemAttrs,
        #[serde(default)]
        content: Vec<Block>,
    },
    CodeBlock {
        #[serde(default)]
        attrs: CodeBlockAttrs,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<Inline>,
    },
    HorizontalRule,
    /// Saut de page manuel.
    PageBreak,
    /// Tableau : une suite de lignes (`TableRow`).
    Table {
        #[serde(default)]
        content: Vec<Block>,
    },
    /// Ligne de tableau : une suite de cellules (`TableCell` ou `TableHeader`).
    TableRow {
        #[serde(default)]
        content: Vec<Block>,
    },
    TableCell {
        #[serde(default)]
        attrs: CellAttrs,
        #[serde(default)]
        content: Vec<Block>,
    },
    /// Cellule d'en-tête (en gras, en haut du tableau).
    TableHeader {
        #[serde(default)]
        attrs: CellAttrs,
        #[serde(default)]
        content: Vec<Block>,
    },
    /// Titre d'onglet. N'existe pas dans l'éditeur (chaque onglet y a son
    /// propre document) : il sert seulement à mettre plusieurs onglets à la
    /// suite dans un fichier Word, Markdown ou texte (voir [`flatten_tabs`]).
    TabTitle {
        attrs: TabTitleAttrs,
    },
    /// Image. Pour l'instant l'image elle-même est dans `src` (adresse
    /// `data:` en base64) ; elle ira plus tard dans la table `media` du format.
    Image {
        attrs: ImageAttrs,
    },
    /// Table des matières : la liste des titres de l'onglet, recalculée
    /// par l'éditeur (et par Word à l'ouverture).
    TableOfContents,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CellAttrs {
    #[serde(default = "one")]
    pub colspan: u32,
    #[serde(default = "one")]
    pub rowspan: u32,
    /// Largeur de la colonne en pixels, si elle a été réglée à la souris.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colwidth: Option<Vec<u32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<String>,
}

impl Default for CellAttrs {
    fn default() -> Self {
        Self {
            colspan: 1,
            rowspan: 1,
            colwidth: None,
            align: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ImageAttrs {
    pub src: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alt: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub width: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub height: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TabTitleAttrs {
    /// 1 = onglet, 2 = sous-onglet, 3 = sous-sous-onglet.
    pub level: u8,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingAttrs {
    pub level: u8,
    #[serde(flatten)]
    pub style: BlockStyle,
}

/// Mise en forme d'un paragraphe ou d'un titre. Les valeurs absentes
/// (`None`) prennent la valeur par défaut du style.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockStyle {
    /// `left`, `center`, `right` ou `justify`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_align: Option<String>,
    /// Interligne, en multiple de la taille du texte (`"1.15"`, `"2"`…).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line_height: Option<String>,
    /// Retrait à gauche, en nombre de crans (1 cran = 1,27 cm).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub indent: Option<u8>,
    /// Style de paragraphe créé par l'utilisateur (identifiant d'un
    /// [`CustomStyle`] de la feuille de styles).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_style: Option<String>,
}

impl BlockStyle {
    pub fn is_empty(&self) -> bool {
        self == &BlockStyle::default()
    }
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct TaskItemAttrs {
    #[serde(default)]
    pub checked: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OrderedListAttrs {
    #[serde(default = "one")]
    pub start: u32,
}

impl Default for OrderedListAttrs {
    fn default() -> Self {
        Self { start: 1 }
    }
}

fn one() -> u32 {
    1
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CodeBlockAttrs {
    #[serde(default)]
    pub language: Option<String>,
}

/// Le contenu d'un bloc de texte : du texte mis en forme et des retours à la ligne.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Inline {
    Text {
        text: String,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        marks: Vec<Mark>,
    },
    HardBreak,
    /// Appel de note de bas de page : le numéro dans le texte ; le texte de
    /// la note est dans `attrs.content`.
    Footnote {
        #[serde(default)]
        attrs: FootnoteAttrs,
    },
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct FootnoteAttrs {
    #[serde(default)]
    pub id: String,
    /// Texte de la note (sans mise en forme ; `\n` sépare les paragraphes).
    #[serde(default)]
    pub content: String,
}

/// Auteur et date d'une suggestion (suivi des modifications).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct ChangeAttrs {
    #[serde(default)]
    pub author: String,
    /// Date ISO 8601, par exemple `"2026-11-22T18:30:00Z"`.
    #[serde(default)]
    pub date: String,
    /// Niveau de révision (1 à 5, comme Scrivener) : chaque niveau a sa
    /// couleur. Absent : niveau 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub level: Option<u8>,
}

impl ChangeAttrs {
    /// Auteur tel qu'écrit dans Word : « Moi · révision 2 » à partir du
    /// niveau 2 (Word ne connaît pas les niveaux de révision).
    pub fn word_author(&self) -> String {
        let author = if self.author.is_empty() {
            "Text Machine"
        } else {
            &self.author
        };
        match self.level {
            Some(n) if n > 1 => format!("{author} · révision {n}"),
            _ => author.to_string(),
        }
    }

    /// L'inverse de [`ChangeAttrs::word_author`].
    pub fn from_word_author(word: &str, date: &str) -> Self {
        let (author, level) = match word.rsplit_once(" · révision ") {
            Some((a, n)) => match n.trim().parse::<u8>() {
                Ok(n) if (1..=5).contains(&n) => (a, Some(n)),
                _ => (word, None),
            },
            None => (word, None),
        };
        Self {
            author: author.to_string(),
            date: date.to_string(),
            level,
        }
    }
}

/// Mise en forme des caractères.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Mark {
    Bold,
    Italic,
    Underline,
    Strike,
    Code,
    Link {
        attrs: LinkAttrs,
    },
    /// Police, taille et couleurs du texte.
    TextStyle {
        #[serde(default)]
        attrs: TextStyleAttrs,
    },
    /// Surlignage (couleur de fond façon « surligneur »).
    Highlight {
        #[serde(default)]
        attrs: HighlightAttrs,
    },
    Subscript,
    Superscript,
    /// Style de caractère créé par l'utilisateur.
    CharStyle {
        attrs: CharStyleAttrs,
    },
    /// Suggestion : texte ajouté, en attente d'acceptation.
    Insertion {
        #[serde(default)]
        attrs: ChangeAttrs,
    },
    /// Suggestion : texte supprimé (encore visible, barré), en attente.
    Deletion {
        #[serde(default)]
        attrs: ChangeAttrs,
    },
    /// Commentaire dans la marge sur ce texte. Chaque morceau du texte
    /// commenté porte toute la discussion (même `id`).
    Comment {
        #[serde(default)]
        attrs: CommentAttrs,
    },
}

/// Une discussion dans la marge : le commentaire, ses réponses, et s'il est
/// résolu (il reste dans le fichier mais n'est plus affiché).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CommentAttrs {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub author: String,
    /// Date ISO 8601.
    #[serde(default)]
    pub date: String,
    /// Texte du commentaire (`\n` sépare les paragraphes).
    #[serde(default)]
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub replies: Vec<CommentReply>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub resolved: bool,
}

/// Une réponse dans une discussion.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CommentReply {
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CharStyleAttrs {
    /// Identifiant d'un [`CustomStyle`] de type caractère.
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkAttrs {
    pub href: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStyleAttrs {
    /// Nom de police CSS, par exemple `"Georgia"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    /// Taille CSS, par exemple `"14pt"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_size: Option<String>,
    /// Couleur du texte, par exemple `"#c0392b"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<String>,
    /// Graisse CSS, par exemple `"300"` (Light) ou `"600"` (SemiBold).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct HighlightAttrs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

impl Inline {
    /// Du texte sans mise en forme.
    pub fn text(text: impl Into<String>) -> Self {
        Inline::Text {
            text: text.into(),
            marks: Vec::new(),
        }
    }
}

impl Block {
    /// Un paragraphe contenant du texte simple.
    pub fn paragraph(text: impl Into<String>) -> Self {
        Block::Paragraph {
            attrs: BlockStyle::default(),
            content: vec![Inline::text(text)],
        }
    }

    /// Un titre de niveau `level` (1 à 6).
    pub fn heading(level: u8, text: impl Into<String>) -> Self {
        Block::Heading {
            attrs: HeadingAttrs {
                level,
                style: BlockStyle::default(),
            },
            content: vec![Inline::text(text)],
        }
    }

    fn write_plain_text(&self, out: &mut String) {
        match self {
            Block::Paragraph { content, .. }
            | Block::Heading { content, .. }
            | Block::CodeBlock { content, .. } => {
                for inline in content {
                    match inline {
                        Inline::Text { text, .. } => out.push_str(text),
                        Inline::HardBreak => out.push('\n'),
                        Inline::Footnote { .. } => {}
                    }
                }
                out.push('\n');
            }
            Block::Blockquote { content }
            | Block::BulletList { content }
            | Block::OrderedList { content, .. }
            | Block::ListItem { content }
            | Block::TaskList { content }
            | Block::TaskItem { content, .. }
            | Block::Table { content }
            | Block::TableRow { content }
            | Block::TableCell { content, .. }
            | Block::TableHeader { content, .. } => {
                for block in content {
                    block.write_plain_text(out);
                }
            }
            Block::TabTitle { attrs } => {
                out.push_str(&attrs.title);
                out.push('\n');
            }
            Block::HorizontalRule
            | Block::PageBreak
            | Block::Image { .. }
            | Block::TableOfContents => out.push('\n'),
        }
    }
}

impl Document {
    pub fn new(content: Vec<Block>) -> Self {
        Self { content }
    }

    /// Le texte du document, sans mise en forme, un bloc par ligne.
    pub fn plain_text(&self) -> String {
        let mut out = String::new();
        for block in &self.content {
            block.write_plain_text(&mut out);
        }
        out
    }

    /// Nombre de mots : suites de caractères séparées par des espaces, qui
    /// contiennent au moins une lettre ou un chiffre (le « ! » isolé de la
    /// typographie française n'est pas un mot).
    pub fn word_count(&self) -> usize {
        self.stats().words
    }

    /// Mots et signes (caractères), avec et sans espaces.
    pub fn stats(&self) -> TextStats {
        TextStats::of(&self.plain_text())
    }

    /// Appelle `f` sur chaque image du document, où qu'elle soit (listes,
    /// citations, tableaux…).
    pub fn for_each_image_mut(&mut self, mut f: impl FnMut(&mut ImageAttrs)) {
        fn walk(blocks: &mut [Block], f: &mut dyn FnMut(&mut ImageAttrs)) {
            for block in blocks {
                match block {
                    Block::Image { attrs } => f(attrs),
                    Block::Blockquote { content }
                    | Block::BulletList { content }
                    | Block::OrderedList { content, .. }
                    | Block::ListItem { content }
                    | Block::TaskList { content }
                    | Block::TaskItem { content, .. }
                    | Block::Table { content }
                    | Block::TableRow { content }
                    | Block::TableCell { content, .. }
                    | Block::TableHeader { content, .. } => walk(content, f),
                    _ => {}
                }
            }
        }
        walk(&mut self.content, &mut f);
    }

    /// Lit un document au format JSON de TipTap / ProseMirror.
    pub fn from_json(json: &str) -> serde_json::Result<Self> {
        serde_json::from_str(json)
    }

    /// Écrit le document au format JSON de TipTap / ProseMirror.
    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string(self)
    }
}

/// Statistiques d'un texte, comme « Outils > Nombre de mots » de Google Docs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextStats {
    pub words: usize,
    /// Signes espaces compris (les fins de paragraphe ne comptent pas).
    pub characters: usize,
    /// Signes sans les espaces.
    pub characters_no_spaces: usize,
}

impl TextStats {
    pub fn of(text: &str) -> Self {
        let words = text
            .split_whitespace()
            .filter(|w| w.chars().any(char::is_alphanumeric))
            .count();
        let characters = text.chars().filter(|c| *c != '\n').count();
        let characters_no_spaces = text.chars().filter(|c| !c.is_whitespace()).count();
        Self {
            words,
            characters,
            characters_no_spaces,
        }
    }
}

// --- Onglets -------------------------------------------------------------------

/// Profondeur maximale des onglets (onglet, sous-onglet, sous-sous-onglet).
pub const MAX_TAB_LEVEL: u8 = 3;

/// Un onglet du document, comme dans Google Docs : un titre, son propre
/// contenu, et éventuellement des sous-onglets.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Tab {
    #[serde(default)]
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub document: Document,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<Tab>,
}

impl Tab {
    pub fn new(title: impl Into<String>, document: Document) -> Self {
        Self {
            id: String::new(),
            title: title.into(),
            document,
            children: Vec::new(),
        }
    }
}

/// Titre donné au premier onglet d'un document qui n'en a pas.
pub const DEFAULT_TAB_TITLE: &str = "Onglet 1";

fn count_tabs(tabs: &[Tab]) -> usize {
    tabs.iter().map(|t| 1 + count_tabs(&t.children)).sum()
}

/// Met tous les onglets à la suite dans un seul document, pour les formats
/// qui ne connaissent pas les onglets (Word, Markdown, texte). Chaque onglet
/// commence par un [`Block::TabTitle`]. Un document d'un seul onglet est
/// écrit tel quel, sans titre d'onglet.
pub fn flatten_tabs(tabs: &[Tab]) -> Document {
    if count_tabs(tabs) <= 1 {
        return tabs.first().map(|t| t.document.clone()).unwrap_or_default();
    }
    fn walk(tabs: &[Tab], level: u8, out: &mut Vec<Block>) {
        for tab in tabs {
            out.push(Block::TabTitle {
                attrs: TabTitleAttrs {
                    level: level.min(MAX_TAB_LEVEL),
                    title: tab.title.clone(),
                },
            });
            out.extend(tab.document.content.iter().cloned());
            walk(&tab.children, level + 1, out);
        }
    }
    let mut content = Vec::new();
    walk(tabs, 1, &mut content);
    Document::new(content)
}

/// Les titres (niveau, texte) de chaque partie du document : avant le
/// premier titre d'onglet, puis après chacun. Sert aux tables des
/// matières, qui listent les titres de leur onglet : « Titre 1 » à
/// « Titre 3 » (niveaux 2 à 4), sans le « Titre » du document, comme Google Docs.
pub fn headings_by_tab(blocks: &[Block]) -> Vec<Vec<(u8, String)>> {
    let mut out = vec![Vec::new()];
    for block in blocks {
        match block {
            Block::TabTitle { .. } => out.push(Vec::new()),
            Block::Heading { attrs, content } if attrs.level >= 2 => {
                let text = Document::new(vec![Block::Paragraph {
                    attrs: BlockStyle::default(),
                    content: content.clone(),
                }])
                .plain_text()
                .trim()
                .to_string();
                if !text.is_empty() {
                    out.last_mut().unwrap().push((attrs.level, text));
                }
            }
            _ => {}
        }
    }
    out
}

/// L'inverse de [`flatten_tabs`] : découpe un document aux titres d'onglet.
/// Sans titre d'onglet, le document entier devient un seul onglet.
pub fn split_tabs(doc: Document) -> Vec<Tab> {
    let mut flat: Vec<(u8, Tab)> = Vec::new();
    let mut leading = Vec::new();
    for block in doc.content {
        match block {
            Block::TabTitle { attrs } => flat.push((
                attrs.level.clamp(1, MAX_TAB_LEVEL),
                Tab::new(attrs.title, Document::default()),
            )),
            other => match flat.last_mut() {
                Some((_, tab)) => tab.document.content.push(other),
                None => leading.push(other),
            },
        }
    }
    let has_text = |blocks: &[Block]| {
        blocks
            .iter()
            .any(|b| !matches!(b, Block::Paragraph { content, .. } if content.is_empty()))
    };
    if has_text(&leading) || flat.is_empty() {
        flat.insert(0, (1, Tab::new(DEFAULT_TAB_TITLE, Document::new(leading))));
    }
    // Reconstruit l'arbre : un onglet de niveau N va dans le dernier onglet
    // de niveau N - 1 (ou au premier niveau s'il n'y en a pas).
    fn insert(tabs: &mut Vec<Tab>, level: u8, tab: Tab) {
        match tabs.last_mut() {
            Some(parent) if level > 1 => insert(&mut parent.children, level - 1, tab),
            _ => tabs.push(tab),
        }
    }
    let mut tabs = Vec::new();
    for (level, mut tab) in flat {
        if tab.document.content.is_empty() {
            tab.document.content.push(Block::Paragraph {
                attrs: BlockStyle::default(),
                content: Vec::new(),
            });
        }
        insert(&mut tabs, level, tab);
    }
    tabs
}

// --- Styles de paragraphe --------------------------------------------------------

/// Un style de paragraphe modifiable (« Texte normal », « Titre 1 »…).
/// Les tailles et espacements sont en points.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ParagraphStyle {
    /// Police ; absente : celle du texte normal.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    pub font_size: f64,
    pub bold: bool,
    pub italic: bool,
    /// Couleur `#rrggbb` ; absente : noir.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Interligne, en multiple de la taille du texte.
    pub line_height: f64,
    pub space_before: f64,
    pub space_after: f64,
    /// Graisse (100 à 900) ; absente : 400, ou 700 si `bold`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub font_weight: Option<u16>,
    #[serde(skip_serializing_if = "is_false")]
    pub underline: bool,
    #[serde(skip_serializing_if = "is_false")]
    pub strike: bool,
    /// Couleur de surlignage `#rrggbb`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub highlight: Option<String>,
    /// Espacement des lettres, en points (négatif : serré).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub letter_spacing: Option<f64>,
    #[serde(skip_serializing_if = "is_false")]
    pub small_caps: bool,
    /// `super` (exposant) ou `sub` (indice).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vertical_align: Option<String>,
    /// `uppercase`, `lowercase` ou `capitalize`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_transform: Option<String>,
    /// `left`, `center`, `right` ou `justify`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_align: Option<String>,
    /// Retraits à gauche et à droite, en centimètres.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_left: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indent_right: Option<f64>,
    /// Retrait de la première ligne, en centimètres (négatif : suspendu).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_line_indent: Option<f64>,
}

fn is_false(v: &bool) -> bool {
    !*v
}

impl Default for ParagraphStyle {
    fn default() -> Self {
        Self {
            font_family: None,
            font_size: 12.0,
            bold: false,
            italic: false,
            color: None,
            line_height: 1.5,
            space_before: 0.0,
            space_after: 6.0,
            font_weight: None,
            underline: false,
            strike: false,
            highlight: None,
            letter_spacing: None,
            small_caps: false,
            vertical_align: None,
            text_transform: None,
            text_align: None,
            indent_left: None,
            indent_right: None,
            first_line_indent: None,
        }
    }
}

impl ParagraphStyle {
    /// Graisse effective (100 à 900).
    pub fn weight(&self) -> u16 {
        self.font_weight
            .unwrap_or(if self.bold { 700 } else { 400 })
    }

    fn heading(font_size: f64, space_before: f64, space_after: f64) -> Self {
        Self {
            font_size,
            line_height: 1.25,
            space_before,
            space_after,
            ..Self::default()
        }
    }
}

/// Un style ajouté par l'utilisateur : de paragraphe (« Citation longue »,
/// « Dialogue »…) ou de caractère (« Terme étranger »…). Un style de
/// caractère n'utilise que la mise en forme des caractères (police, graisse,
/// couleurs, effets), pas celle du paragraphe.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomStyle {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub kind: StyleKind,
    #[serde(default)]
    pub style: ParagraphStyle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StyleKind {
    #[default]
    Paragraph,
    Character,
}

/// La feuille de styles du document : un style par type de paragraphe.
/// Les titres de niveau 1 à 4 de l'éditeur sont « Titre », « Titre 1 »,
/// « Titre 2 » et « Titre 3 ».
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StyleSheet {
    pub normal: ParagraphStyle,
    pub title: ParagraphStyle,
    pub heading1: ParagraphStyle,
    pub heading2: ParagraphStyle,
    pub heading3: ParagraphStyle,
    /// Styles créés par l'utilisateur.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub custom: Vec<CustomStyle>,
}

impl Default for StyleSheet {
    fn default() -> Self {
        Self {
            normal: ParagraphStyle {
                font_family: Some("Georgia".into()),
                ..ParagraphStyle::default()
            },
            title: ParagraphStyle::heading(26.0, 0.0, 6.0),
            heading1: ParagraphStyle::heading(20.0, 20.0, 6.0),
            heading2: ParagraphStyle::heading(16.0, 18.0, 4.0),
            heading3: ParagraphStyle {
                color: Some("#434343".into()),
                ..ParagraphStyle::heading(14.0, 14.0, 4.0)
            },
            custom: Vec::new(),
        }
    }
}

impl StyleSheet {
    /// Le style d'un titre de niveau 1 à 4 (1 = « Titre »).
    pub fn heading(&self, level: u8) -> &ParagraphStyle {
        match level {
            1 => &self.title,
            2 => &self.heading1,
            3 => &self.heading2,
            _ => &self.heading3,
        }
    }

    pub fn heading_mut(&mut self, level: u8) -> &mut ParagraphStyle {
        match level {
            1 => &mut self.title,
            2 => &mut self.heading1,
            3 => &mut self.heading2,
            _ => &mut self.heading3,
        }
    }

    /// Un style créé par l'utilisateur, d'après son identifiant.
    pub fn custom(&self, id: &str) -> Option<&CustomStyle> {
        self.custom.iter().find(|s| s.id == id)
    }

    /// Police effective d'un style (celle du texte normal par défaut).
    pub fn font_of<'a>(&'a self, style: &'a ParagraphStyle) -> Option<&'a str> {
        style
            .font_family
            .as_deref()
            .or(self.normal.font_family.as_deref())
    }
}

/// Format des pages du document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PageSetup {
    pub size: PageSize,
    /// Paysage (pages plus larges que hautes).
    pub landscape: bool,
    /// Marges en millimètres.
    pub margins: Margins,
    /// Afficher le numéro en bas de chaque page.
    pub page_numbers: bool,
    /// Affichage continu, sans pages (« Sans pagination » de Google Docs).
    /// Les exports PDF et l'impression restent découpés en pages.
    pub pageless: bool,
    /// En-tête : le même texte en haut de chaque page (une ligne par
    /// paragraphe, vide s'il n'y en a pas).
    pub header: String,
    /// Pied de page : le même texte en bas de chaque page, au-dessus du numéro.
    pub footer: String,
    /// Ni en-tête, ni pied de page, ni numéro sur la première page
    /// (page de titre).
    pub different_first_page: bool,
}

impl Default for PageSetup {
    fn default() -> Self {
        Self {
            size: PageSize::A4,
            landscape: false,
            margins: Margins::default(),
            page_numbers: true,
            pageless: false,
            header: String::new(),
            footer: String::new(),
            different_first_page: false,
        }
    }
}

impl PageSetup {
    /// Largeur et hauteur de la page en millimètres, orientation comprise.
    pub fn dimensions_mm(&self) -> (f64, f64) {
        let (w, h) = self.size.portrait_mm();
        if self.landscape {
            (h, w)
        } else {
            (w, h)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PageSize {
    #[default]
    A4,
    Letter,
}

impl PageSize {
    /// Largeur et hauteur en portrait, en millimètres.
    pub fn portrait_mm(self) -> (f64, f64) {
        match self {
            PageSize::A4 => (210.0, 297.0),
            PageSize::Letter => (215.9, 279.4),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Margins {
    pub top: f64,
    pub bottom: f64,
    pub left: f64,
    pub right: f64,
}

impl Default for Margins {
    /// 2,54 cm partout, comme Google Docs.
    fn default() -> Self {
        Self {
            top: 25.4,
            bottom: 25.4,
            left: 25.4,
            right: 25.4,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// JSON tel que TipTap (StarterKit) le produit.
    const TIPTAP_JSON: &str = r#"{
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 1}, "content": [{"type": "text", "text": "Bonjour"}]},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "Un mot "},
                {"type": "text", "marks": [{"type": "bold"}], "text": "en gras"},
                {"type": "hardBreak"},
                {"type": "text", "marks": [{"type": "link", "attrs": {"href": "https://exemple.fr", "target": "_blank", "rel": null, "class": null}}], "text": "un lien"}
            ]},
            {"type": "bulletList", "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "point un"}]}]}
            ]},
            {"type": "orderedList", "attrs": {"start": 3, "type": null}, "content": []},
            {"type": "codeBlock", "attrs": {"language": null}, "content": [{"type": "text", "text": "let x = 1;"}]},
            {"type": "horizontalRule"},
            {"type": "paragraph"}
        ]
    }"#;

    #[test]
    fn lit_le_json_de_tiptap() {
        let doc = Document::from_json(TIPTAP_JSON).unwrap();
        assert_eq!(doc.content.len(), 7);
        assert_eq!(doc.content[0], Block::heading(1, "Bonjour"));
        match &doc.content[3] {
            Block::OrderedList { attrs, .. } => assert_eq!(attrs.start, 3),
            other => panic!("liste numérotée attendue, trouvé {other:?}"),
        }
    }

    #[test]
    fn aller_retour_json() {
        let doc = Document::from_json(TIPTAP_JSON).unwrap();
        let again = Document::from_json(&doc.to_json().unwrap()).unwrap();
        assert_eq!(doc, again);
    }

    #[test]
    fn compte_les_mots() {
        let doc = Document::from_json(TIPTAP_JSON).unwrap();
        // Bonjour / Un mot en gras / un lien / point un / let x 1; (« = » n'est pas un mot)
        assert_eq!(doc.word_count(), 1 + 4 + 2 + 2 + 3);
    }

    #[test]
    fn compte_les_signes() {
        let doc = Document::new(vec![
            Block::paragraph("Bonjour !"),
            Block::paragraph("Ça va ?"),
        ]);
        let s = doc.stats();
        assert_eq!(s.words, 3);
        assert_eq!(s.characters, 9 + 7);
        assert_eq!(s.characters_no_spaces, 8 + 5);
    }

    #[test]
    fn onglets_a_plat_et_retour() {
        let mut parent = Tab::new("Chapitre 1", Document::new(vec![Block::paragraph("a")]));
        parent.children.push(Tab::new(
            "Scène 1",
            Document::new(vec![Block::paragraph("b")]),
        ));
        let tabs = vec![
            parent,
            Tab::new("Chapitre 2", Document::new(vec![Block::paragraph("c")])),
        ];
        let flat = flatten_tabs(&tabs);
        assert_eq!(flat.content.len(), 6);
        assert_eq!(
            flat.plain_text(),
            "Chapitre 1\na\nScène 1\nb\nChapitre 2\nc\n"
        );
        assert_eq!(split_tabs(flat), tabs);
    }

    #[test]
    fn un_seul_onglet_reste_un_document_simple() {
        let doc = Document::new(vec![Block::paragraph("texte")]);
        let tabs = vec![Tab::new("Onglet 1", doc.clone())];
        assert_eq!(flatten_tabs(&tabs), doc);
        assert_eq!(split_tabs(doc), tabs);
    }

    #[test]
    fn styles_par_defaut_en_json() {
        let json = serde_json::to_string(&StyleSheet::default()).unwrap();
        let back: StyleSheet = serde_json::from_str(&json).unwrap();
        assert_eq!(back, StyleSheet::default());
        // Champs absents : valeurs par défaut.
        let partial: StyleSheet = serde_json::from_str(r#"{"title":{"fontSize":30}}"#).unwrap();
        assert_eq!(partial.title.font_size, 30.0);
        assert_eq!(partial.normal, StyleSheet::default().normal);
    }

    #[test]
    fn document_vide() {
        let doc = Document::from_json(r#"{"type":"doc"}"#).unwrap();
        assert_eq!(doc, Document::default());
        assert_eq!(doc.word_count(), 0);
    }

    #[test]
    fn lit_notes_sommaire_et_suggestions_de_l_editeur() {
        let json = r#"{"type":"doc","content":[
            {"type":"tableOfContents"},
            {"type":"paragraph","content":[
                {"type":"text","text":"Texte"},
                {"type":"footnote","attrs":{"id":"n1","content":"Une note"}},
                {"type":"text","text":"ajout","marks":[{"type":"insertion","attrs":{"author":"Moi","date":"2026-11-22T10:00:00Z"}}]},
                {"type":"text","text":"retrait","marks":[{"type":"deletion","attrs":{"author":"Moi","date":""}}]}
            ]}
        ]}"#;
        let doc = Document::from_json(json).unwrap();
        assert_eq!(doc.content[0], Block::TableOfContents);
        let back: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
        let original: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(back, original);
        // La note ne compte pas dans le texte.
        assert_eq!(doc.plain_text(), "\nTexteajoutretrait\n");
    }

    #[test]
    fn lit_un_commentaire_de_l_editeur() {
        let json = r#"{"type":"doc","content":[{"type":"paragraph","content":[
            {"type":"text","text":"mot","marks":[{"type":"comment","attrs":{"id":"c1","author":"Moi",
            "date":"2026-11-22T10:00:00Z","text":"À revoir","replies":[{"author":"Bob","date":"","text":"Oui"}],
            "resolved":false}}]}]}]}"#;
        let doc: Document = serde_json::from_str(json).unwrap();
        let Block::Paragraph { content, .. } = &doc.content[0] else {
            panic!()
        };
        let Inline::Text { marks, .. } = &content[0] else {
            panic!()
        };
        let Mark::Comment { attrs } = &marks[0] else {
            panic!()
        };
        assert_eq!(attrs.text, "À revoir");
        assert_eq!(attrs.replies[0].author, "Bob");
        assert_eq!(doc.plain_text().trim(), "mot");
    }
}
