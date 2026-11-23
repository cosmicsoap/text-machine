//! Markdown et texte brut pour Text Machine.
//!
//! - Export : titres, paragraphes, gras, italique, barré, code, liens,
//!   listes (à puces, numérotées, cases à cocher), citations, blocs de code,
//!   tableaux (format GitHub), images, lignes horizontales.
//! - Import : le même sous-ensemble, lu avec `pulldown-cmark`.
//!
//! Ce que Markdown ne sait pas représenter (couleurs, polices, alignement,
//! souligné…) est perdu à l'export.
//!
//! Notes de bas de page : syntaxe `[^1]` (lue par la plupart des éditeurs).
//! Suggestions : syntaxe « CriticMarkup » `{++ajout++}` et `{--suppression--}`.
//! Table des matières : une liste de liens vers les titres, entre deux
//! commentaires `<!-- text-machine:sommaire -->`, recalculée à l'ouverture.

use std::cell::RefCell;
use std::collections::HashMap;

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use tm_model::{
    Block, BlockStyle, CellAttrs, ChangeAttrs, CodeBlockAttrs, Document, FootnoteAttrs,
    HeadingAttrs, ImageAttrs, Inline, LinkAttrs, Mark, OrderedListAttrs, TabTitleAttrs,
    TaskItemAttrs,
};

const TOC_START: &str = "<!-- text-machine:sommaire -->";
const TOC_END: &str = "<!-- /text-machine:sommaire -->";

thread_local! {
    /// Pendant un export : le texte des notes, dans l'ordre des appels.
    static NOTES: RefCell<Vec<String>> = const { RefCell::new(Vec::new()) };
    /// Pendant un export : les titres de chaque onglet (pour les sommaires).
    static HEADINGS: RefCell<Vec<Vec<(u8, String)>>> = const { RefCell::new(Vec::new()) };
}

// --- Export ------------------------------------------------------------------

/// Convertit un document en Markdown.
pub fn export(doc: &Document) -> String {
    NOTES.with(|n| n.borrow_mut().clear());
    HEADINGS.with(|h| *h.borrow_mut() = tm_model::headings_by_tab(&doc.content));
    let mut parts = Vec::new();
    let mut section = 0;
    for block in &doc.content {
        if matches!(block, Block::TabTitle { .. }) {
            section += 1;
        }
        let md = match block {
            Block::TableOfContents => Some(toc_markdown(section)),
            other => block_to_markdown(other),
        };
        parts.extend(md);
    }
    let mut out = parts.join("\n\n");
    let notes = NOTES.with(|n| std::mem::take(&mut *n.borrow_mut()));
    for (i, note) in notes.iter().enumerate() {
        out.push_str(if i == 0 { "\n\n" } else { "\n" });
        let body = note.lines().map(escape).collect::<Vec<_>>().join("\n    ");
        out.push_str(&format!("[^{}]: {body}", i + 1));
    }
    out.push('\n');
    out
}

/// Ancre d'un titre, comme GitHub : minuscules, espaces en tirets.
pub fn slug(text: &str) -> String {
    text.trim()
        .to_lowercase()
        .chars()
        .filter_map(|c| match c {
            ' ' => Some('-'),
            c if c.is_alphanumeric() || c == '-' || c == '_' => Some(c),
            _ => None,
        })
        .collect()
}

fn toc_markdown(section: usize) -> String {
    let headings = HEADINGS.with(|h| h.borrow().get(section).cloned().unwrap_or_default());
    let min = headings.iter().map(|(l, _)| *l).min().unwrap_or(1);
    let lines: Vec<String> = headings
        .iter()
        .map(|(level, text)| {
            format!(
                "{}- [{}](#{})",
                "  ".repeat((level - min) as usize),
                escape(text),
                slug(text)
            )
        })
        .collect();
    if lines.is_empty() {
        format!("{TOC_START}\n\n{TOC_END}")
    } else {
        format!("{TOC_START}\n\n{}\n\n{TOC_END}", lines.join("\n"))
    }
}

/// Convertit un document en texte brut (un paragraphe par ligne).
pub fn export_plain_text(doc: &Document) -> String {
    doc.plain_text()
}

fn blocks_to_markdown(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(block_to_markdown)
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn block_to_markdown(block: &Block) -> Option<String> {
    Some(match block {
        Block::Paragraph { content, .. } => {
            let text = inlines_to_markdown(content);
            if text.trim().is_empty() {
                return None;
            }
            escape_line_start(&text)
        }
        Block::Heading { attrs, content } => {
            format!(
                "{} {}",
                "#".repeat(attrs.level.clamp(1, 6) as usize),
                inlines_to_markdown(content)
            )
        }
        Block::Blockquote { content } => prefix_lines(&blocks_to_markdown(content), "> ", "> "),
        Block::BulletList { content } => list_items(content, |_| "- ".to_string()),
        Block::OrderedList { attrs, content } => {
            list_items(content, |i| format!("{}. ", attrs.start as usize + i))
        }
        Block::TaskList { content } => list_items(content, |_| String::new()),
        Block::ListItem { content } => item_body(content),
        Block::TaskItem { attrs, content } => {
            let mark = if attrs.checked { "[x] " } else { "[ ] " };
            format!("{mark}{}", item_body(content))
        }
        Block::CodeBlock { attrs, content } => {
            let code: String = content
                .iter()
                .map(|i| match i {
                    Inline::Text { text, .. } => text.as_str(),
                    Inline::HardBreak => "\n",
                    Inline::Footnote { .. } => "",
                })
                .collect();
            let fence = if code.contains("```") { "~~~" } else { "```" };
            format!(
                "{fence}{}\n{code}\n{fence}",
                attrs.language.as_deref().unwrap_or("")
            )
        }
        Block::HorizontalRule => "---".into(),
        Block::PageBreak => return None,
        // Un onglet : un commentaire invisible (pour le relire) puis son titre.
        Block::TabTitle { attrs } => format!(
            "{}\n{} {}",
            tab_marker(attrs.level),
            "#".repeat(attrs.level.clamp(1, 3) as usize),
            escape(&attrs.title)
        ),
        Block::Image { attrs } => format!(
            "![{}]({})",
            escape(attrs.alt.as_deref().unwrap_or("")),
            attrs.src
        ),
        Block::Table { content } => table_to_markdown(content),
        Block::TableRow { .. } | Block::TableCell { .. } | Block::TableHeader { .. } => {
            return None
        }
        Block::TableOfContents => toc_markdown(0),
    })
}

/// Commentaire qui annonce un titre d'onglet dans un fichier Markdown.
fn tab_marker(level: u8) -> String {
    format!("<!-- text-machine:onglet niveau={level} -->")
}

/// Lit un commentaire `<!-- text-machine:onglet niveau=N -->`.
fn parse_tab_marker(html: &str) -> Option<u8> {
    let inner = html
        .trim()
        .strip_prefix("<!--")?
        .strip_suffix("-->")?
        .trim();
    let level = inner.strip_prefix("text-machine:onglet")?.trim();
    let level = level.strip_prefix("niveau=").unwrap_or("1");
    Some(
        level
            .trim()
            .parse::<u8>()
            .unwrap_or(1)
            .clamp(1, tm_model::MAX_TAB_LEVEL),
    )
}

/// Contenu d'un élément de liste : une sous-liste suit directement le texte
/// (liste « serrée »), les autres blocs sont séparés par une ligne vide.
fn item_body(blocks: &[Block]) -> String {
    let mut out = String::new();
    for block in blocks {
        let Some(md) = block_to_markdown(block) else {
            continue;
        };
        if !out.is_empty() {
            let is_list = matches!(
                block,
                Block::BulletList { .. } | Block::OrderedList { .. } | Block::TaskList { .. }
            );
            out.push_str(if is_list { "\n" } else { "\n\n" });
        }
        out.push_str(&md);
    }
    out
}

fn list_items(items: &[Block], marker: impl Fn(usize) -> String) -> String {
    items
        .iter()
        .enumerate()
        .map(|(i, item)| {
            let body = block_to_markdown(item).unwrap_or_default();
            let mut m = marker(i);
            if matches!(item, Block::TaskItem { .. }) {
                m = "- ".into();
            }
            let indent = " ".repeat(m.chars().count());
            prefix_lines(&body, &m, &indent)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn prefix_lines(text: &str, first: &str, rest: &str) -> String {
    text.lines()
        .enumerate()
        .map(|(i, line)| {
            let p = if i == 0 { first } else { rest };
            if line.is_empty() {
                p.trim_end().to_string()
            } else {
                format!("{p}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn table_to_markdown(rows: &[Block]) -> String {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .filter_map(|row| match row {
            Block::TableRow { content } => Some(
                content
                    .iter()
                    .map(|cell| match cell {
                        Block::TableCell { content, .. } | Block::TableHeader { content, .. } => {
                            content
                                .iter()
                                .filter_map(block_to_markdown)
                                .collect::<Vec<_>>()
                                .join("<br>")
                                // Un retour à la ligne forcé reste dans la cellule.
                                .replace("\\\n", "<br>")
                                .replace('\n', " ")
                                .replace('|', "\\|")
                        }
                        _ => String::new(),
                    })
                    .collect(),
            ),
            _ => None,
        })
        .collect();
    let cols = cells.iter().map(Vec::len).max().unwrap_or(0);
    if cols == 0 {
        return String::new();
    }
    // Colonnes alignées : le tableau reste lisible même ouvert comme
    // simple texte (Aperçu, TextEdit…).
    let width = |s: &str| s.chars().count();
    let widths: Vec<usize> = (0..cols)
        .map(|c| {
            cells
                .iter()
                .filter_map(|r| r.get(c))
                .map(|s| width(s))
                .max()
                .unwrap_or(0)
                .max(3)
        })
        .collect();
    let line = |row: &[String]| {
        let parts: Vec<String> = (0..cols)
            .map(|c| {
                let text = row.get(c).map(String::as_str).unwrap_or("");
                format!("{text}{}", " ".repeat(widths[c] - width(text)))
            })
            .collect();
        format!("| {} |", parts.join(" | "))
    };
    let rule: Vec<String> = widths.iter().map(|w| "-".repeat(*w)).collect();
    let mut out = vec![line(&cells[0]), format!("| {} |", rule.join(" | "))];
    out.extend(cells[1..].iter().map(|r| line(r)));
    out.join("\n")
}

fn inlines_to_markdown(inlines: &[Inline]) -> String {
    let mut out = String::new();
    for inline in inlines {
        match inline {
            Inline::HardBreak => out.push_str("\\\n"),
            Inline::Text { text, marks } => out.push_str(&text_to_markdown(text, marks)),
            Inline::Footnote { attrs } => {
                let n = NOTES.with(|n| {
                    let mut n = n.borrow_mut();
                    n.push(attrs.content.clone());
                    n.len()
                });
                out.push_str(&format!("[^{n}]"));
            }
        }
    }
    out
}

fn text_to_markdown(text: &str, marks: &[Mark]) -> String {
    let s = styled_markdown(text, marks);
    if marks.iter().any(|m| matches!(m, Mark::Insertion { .. })) {
        format!("{{++{s}++}}")
    } else if marks.iter().any(|m| matches!(m, Mark::Deletion { .. })) {
        format!("{{--{s}--}}")
    } else {
        s
    }
}

fn styled_markdown(text: &str, marks: &[Mark]) -> String {
    let has = |f: fn(&Mark) -> bool| marks.iter().any(f);
    if has(|m| matches!(m, Mark::Code)) {
        let ticks = if text.contains('`') { "``" } else { "`" };
        return format!("{ticks}{text}{ticks}");
    }
    // Les espaces au bord restent hors des marqueurs (`** gras**` ne marche pas).
    let core = text.trim();
    if core.is_empty() {
        return text.to_string();
    }
    let lead = &text[..text.len() - text.trim_start().len()];
    let trail = &text[text.trim_end().len()..];
    let mut s = escape(core);
    if has(|m| matches!(m, Mark::Superscript)) {
        s = format!("<sup>{s}</sup>");
    }
    if has(|m| matches!(m, Mark::Subscript)) {
        s = format!("<sub>{s}</sub>");
    }
    if has(|m| matches!(m, Mark::Strike)) {
        s = format!("~~{s}~~");
    }
    if has(|m| matches!(m, Mark::Italic)) {
        s = format!("*{s}*");
    }
    if has(|m| matches!(m, Mark::Bold)) {
        s = format!("**{s}**");
    }
    if let Some(Mark::Link { attrs }) = marks.iter().find(|m| matches!(m, Mark::Link { .. })) {
        s = format!(
            "[{s}]({})",
            attrs.href.replace(' ', "%20").replace(')', "%29")
        );
    }
    format!("{lead}{s}{trail}")
}

fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '~') {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

/// Empêche un paragraphe d'être lu comme un titre, une liste ou une citation.
fn escape_line_start(text: &str) -> String {
    let trimmed = text.trim_start();
    let starts_numbered = trimmed
        .split_once(['.', ')'])
        .is_some_and(|(n, _)| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()));
    if trimmed.starts_with(['#', '>', '-', '+', '=']) || starts_numbered {
        format!("\\{trimmed}")
    } else {
        text.to_string()
    }
}

// --- Import ------------------------------------------------------------------

/// Lit un texte Markdown.
pub fn import(markdown: &str) -> Document {
    // Fins de ligne Windows (\r\n) : ramenées à \n, sinon le premier
    // marqueur d'onglet n'est pas reconnu (un onglet vide apparaissait).
    let markdown = &markdown.replace("\r\n", "\n");
    let mut b = Builder::default();
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    for event in Parser::new_ext(markdown, options) {
        b.event(event);
    }
    b.finish()
}

/// Lit du texte brut : une ligne = un paragraphe.
pub fn import_plain_text(text: &str) -> Document {
    Document::new(
        text.lines()
            .map(|line| {
                if line.is_empty() {
                    Block::Paragraph {
                        attrs: BlockStyle::default(),
                        content: vec![],
                    }
                } else {
                    Block::paragraph(line)
                }
            })
            .collect(),
    )
}

/// Conteneurs ouverts (citation, liste, élément, tableau…).
enum Container {
    Root,
    Quote,
    List { start: Option<u64> },
    Item { checked: Option<bool> },
    Table,
    Row { header: bool },
    Cell { header: bool },
}

enum TextKind {
    Paragraph,
    Heading(u8),
    Code(Option<String>),
}

#[derive(Default)]
struct Builder {
    stack: Vec<(ContainerSlot, Vec<Block>)>,
    text: Option<(TextKind, Vec<Inline>)>,
    marks: Vec<Mark>,
    image: Option<(String, String)>,
    /// Niveau annoncé par un commentaire d'onglet : le titre qui suit est
    /// celui d'un onglet.
    tab: Option<u8>,
    /// Suggestion en cours (`{++…++}` ou `{--…--}`).
    change: Option<Mark>,
    /// Définition de note en cours de lecture : son nom et son texte.
    note: Option<(String, String)>,
    /// Texte des notes, par nom (`[^nom]: texte`).
    notes: HashMap<String, String>,
    /// Dans la liste d'une table des matières (recalculée, donc ignorée).
    in_toc: bool,
}

struct ContainerSlot(Container);

impl Builder {
    fn top(&mut self) -> &mut Vec<Block> {
        if self.stack.is_empty() {
            self.stack
                .push((ContainerSlot(Container::Root), Vec::new()));
        }
        &mut self.stack.last_mut().unwrap().1
    }

    fn open(&mut self, c: Container) {
        self.flush_text();
        self.top();
        self.stack.push((ContainerSlot(c), Vec::new()));
    }

    fn close(&mut self) {
        self.flush_text();
        let Some((ContainerSlot(c), content)) = self.stack.pop() else {
            return;
        };
        let block = match c {
            Container::Root => {
                self.stack.push((ContainerSlot(Container::Root), content));
                return;
            }
            Container::Quote => Block::Blockquote { content },
            Container::List { start } => {
                let tasks = content.iter().all(|b| matches!(b, Block::TaskItem { .. }))
                    && !content.is_empty();
                if tasks {
                    Block::TaskList { content }
                } else {
                    // Une liste ordinaire : les cases éventuelles redeviennent des éléments.
                    let content = content
                        .into_iter()
                        .map(|b| match b {
                            Block::TaskItem { content, .. } => Block::ListItem { content },
                            other => other,
                        })
                        .collect();
                    match start {
                        Some(n) => Block::OrderedList {
                            attrs: OrderedListAttrs { start: n as u32 },
                            content,
                        },
                        None => Block::BulletList { content },
                    }
                }
            }
            Container::Item { checked } => match checked {
                Some(checked) => Block::TaskItem {
                    attrs: TaskItemAttrs { checked },
                    content: non_empty(content),
                },
                None => Block::ListItem {
                    content: non_empty(content),
                },
            },
            Container::Table => Block::Table { content },
            Container::Row { .. } => Block::TableRow { content },
            Container::Cell { header } => {
                // « &nbsp; » seul (écrit par une version précédente) : cellule vide.
                let content: Vec<Block> = content
                    .into_iter()
                    .filter(|b| !matches!(b, Block::Paragraph { content, .. }
                        if content.iter().all(|i| matches!(i, Inline::Text { text, .. }
                            if text.trim_matches(|c: char| c == '\u{a0}' || c.is_whitespace()).is_empty()))))
                    .collect();
                let content = non_empty(content);
                if header {
                    Block::TableHeader {
                        attrs: CellAttrs::default(),
                        content,
                    }
                } else {
                    Block::TableCell {
                        attrs: CellAttrs::default(),
                        content,
                    }
                }
            }
        };
        self.top().push(block);
    }

    fn start_text(&mut self, kind: TextKind) {
        self.flush_text();
        self.text = Some((kind, Vec::new()));
    }

    fn flush_text(&mut self) {
        let Some((kind, content)) = self.text.take() else {
            return;
        };
        let block = match kind {
            TextKind::Paragraph => {
                if content.is_empty() {
                    return;
                }
                Block::Paragraph {
                    attrs: BlockStyle::default(),
                    content,
                }
            }
            TextKind::Heading(_) if self.tab.is_some() => Block::TabTitle {
                attrs: TabTitleAttrs {
                    level: self.tab.take().unwrap_or(1),
                    title: Document::new(vec![Block::Paragraph {
                        attrs: BlockStyle::default(),
                        content,
                    }])
                    .plain_text()
                    .trim()
                    .to_string(),
                },
            },
            TextKind::Heading(level) => Block::Heading {
                attrs: HeadingAttrs {
                    level,
                    style: BlockStyle::default(),
                },
                content,
            },
            TextKind::Code(language) => {
                // Le dernier saut de ligne fait partie de la syntaxe, pas du code.
                let mut content = content;
                if let Some(Inline::Text { text, .. }) = content.last_mut() {
                    if text.ends_with('\n') {
                        text.pop();
                    }
                }
                Block::CodeBlock {
                    attrs: CodeBlockAttrs { language },
                    content: content
                        .into_iter()
                        .filter(|i| !matches!(i, Inline::Text { text, .. } if text.is_empty()))
                        .collect(),
                }
            }
        };
        self.top().push(block);
    }

    fn push_inline(&mut self, inline: Inline) {
        if self.text.is_none() {
            // Listes « serrées » : le texte arrive sans paragraphe.
            self.text = Some((TextKind::Paragraph, Vec::new()));
        }
        let content = &mut self.text.as_mut().unwrap().1;
        // Fusionne avec le texte précédent s'il a la même mise en forme.
        if let (
            Some(Inline::Text {
                text: prev,
                marks: pm,
            }),
            Inline::Text { text, marks },
        ) = (content.last_mut(), &inline)
        {
            if pm == marks {
                prev.push_str(text);
                return;
            }
        }
        content.push(inline);
    }

    fn push_text(&mut self, text: &str, extra: Option<Mark>) {
        if let Some((_, alt)) = &mut self.image {
            alt.push_str(text);
            return;
        }
        if let Some((_, note)) = &mut self.note {
            note.push_str(text);
            return;
        }
        if extra.is_some() {
            return self.push_marked(text, extra);
        }
        // Repère les marques de suggestion `{++`, `++}`, `{--` et `--}`.
        let mut rest = text;
        loop {
            let found = ["{++", "++}", "{--", "--}"]
                .iter()
                .filter_map(|m| rest.find(m).map(|i| (i, *m)))
                .min_by_key(|(i, _)| *i);
            let Some((i, marker)) = found else {
                self.push_marked(rest, None);
                return;
            };
            self.push_marked(&rest[..i], None);
            let attrs = ChangeAttrs::default();
            self.change = match marker {
                "{++" => Some(Mark::Insertion { attrs }),
                "{--" => Some(Mark::Deletion { attrs }),
                _ => None,
            };
            rest = &rest[i + marker.len()..];
        }
    }

    fn push_marked(&mut self, text: &str, extra: Option<Mark>) {
        if text.is_empty() {
            return;
        }
        let mut marks = self.marks.clone();
        marks.extend(extra);
        marks.extend(self.change.clone());
        self.push_inline(Inline::Text {
            text: text.to_string(),
            marks,
        });
    }

    fn event(&mut self, event: Event) {
        if self.in_toc {
            if matches!(&event, Event::Html(h) if h.trim() == TOC_END) {
                self.in_toc = false;
            }
            return;
        }
        if self.note.is_some() {
            match event {
                Event::End(TagEnd::FootnoteDefinition) => {
                    let (name, text) = self.note.take().unwrap();
                    self.notes.insert(name, text.trim().to_string());
                }
                Event::End(TagEnd::Paragraph) => {
                    if let Some((_, text)) = &mut self.note {
                        text.push('\n');
                    }
                }
                Event::Text(t) | Event::Code(t) => self.push_text(&t, None),
                Event::SoftBreak => self.push_text(" ", None),
                Event::HardBreak => self.push_text("\n", None),
                _ => {}
            }
            return;
        }
        match event {
            Event::Start(Tag::FootnoteDefinition(name)) => {
                self.flush_text();
                self.note = Some((name.to_string(), String::new()));
            }
            Event::FootnoteReference(name) => self.push_inline(Inline::Footnote {
                attrs: FootnoteAttrs {
                    id: name.to_string(),
                    content: String::new(),
                },
            }),
            Event::Html(html) if html.trim() == TOC_START => {
                self.flush_text();
                self.top().push(Block::TableOfContents);
                self.in_toc = true;
            }
            other => self.event_inner(other),
        }
    }

    fn event_inner(&mut self, event: Event) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => self.start_text(TextKind::Paragraph),
                Tag::Heading { level, .. } => {
                    self.start_text(TextKind::Heading(heading_level(level)))
                }
                Tag::CodeBlock(kind) => self.start_text(TextKind::Code(match kind {
                    CodeBlockKind::Fenced(lang) if !lang.is_empty() => Some(lang.to_string()),
                    _ => None,
                })),
                Tag::BlockQuote(_) => self.open(Container::Quote),
                Tag::List(start) => self.open(Container::List { start }),
                Tag::Item => self.open(Container::Item { checked: None }),
                Tag::Table(_) => self.open(Container::Table),
                Tag::TableHead => self.open(Container::Row { header: true }),
                Tag::TableRow => self.open(Container::Row { header: false }),
                Tag::TableCell => {
                    let header = matches!(
                        self.stack.last(),
                        Some((ContainerSlot(Container::Row { header: true }), _))
                    );
                    self.open(Container::Cell { header });
                }
                Tag::Emphasis => self.marks.push(Mark::Italic),
                Tag::Strong => self.marks.push(Mark::Bold),
                Tag::Strikethrough => self.marks.push(Mark::Strike),
                Tag::Link { dest_url, .. } => self.marks.push(Mark::Link {
                    attrs: LinkAttrs {
                        href: dest_url.to_string(),
                    },
                }),
                Tag::Image { dest_url, .. } => {
                    self.image = Some((dest_url.to_string(), String::new()))
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph | TagEnd::Heading(_) | TagEnd::CodeBlock => self.flush_text(),
                TagEnd::BlockQuote(_)
                | TagEnd::List(_)
                | TagEnd::Item
                | TagEnd::Table
                | TagEnd::TableHead
                | TagEnd::TableRow
                | TagEnd::TableCell => self.close(),
                TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                    self.marks.pop();
                }
                TagEnd::Image => {
                    if let Some((src, alt)) = self.image.take() {
                        // Les images sont des blocs : elles coupent le paragraphe.
                        let kind = self.text.as_ref().map(|(k, _)| match k {
                            TextKind::Heading(l) => TextKind::Heading(*l),
                            _ => TextKind::Paragraph,
                        });
                        self.flush_text();
                        self.top().push(Block::Image {
                            attrs: ImageAttrs {
                                src,
                                alt: (!alt.is_empty()).then_some(alt),
                                title: None,
                                width: None,
                                height: None,
                            },
                        });
                        if let Some(kind) = kind {
                            self.text = Some((kind, Vec::new()));
                        }
                    }
                }
                _ => {}
            },
            Event::Text(text) => self.push_text(&text, None),
            Event::Code(code) => self.push_text(&code, Some(Mark::Code)),
            Event::InlineHtml(html)
                if matches!(
                    html.trim().to_ascii_lowercase().as_str(),
                    "<br>" | "<br/>" | "<br />"
                ) =>
            {
                self.push_inline(Inline::HardBreak)
            }
            Event::Html(html) if parse_tab_marker(&html).is_some() => {
                self.flush_text();
                self.tab = parse_tab_marker(&html);
            }
            Event::Html(html) | Event::InlineHtml(html) => self.push_text(&html, None),
            Event::SoftBreak => self.push_text(" ", None),
            Event::HardBreak => self.push_inline(Inline::HardBreak),
            Event::Rule => {
                self.flush_text();
                self.top().push(Block::HorizontalRule);
            }
            Event::TaskListMarker(checked) => {
                if let Some((ContainerSlot(Container::Item { checked: c }), _)) =
                    self.stack.last_mut()
                {
                    *c = Some(checked);
                }
            }
            _ => {}
        }
    }

    fn finish(mut self) -> Document {
        self.flush_text();
        while self.stack.len() > 1 {
            self.close();
        }
        let mut content = self.stack.pop().map(|(_, c)| c).unwrap_or_default();
        // Le texte des notes est à la fin du fichier : on le remet dans les appels.
        let mut n = 0;
        for_each_inline_mut(&mut content, &mut |inline| {
            if let Inline::Footnote { attrs } = inline {
                n += 1;
                attrs.content = self.notes.get(&attrs.id).cloned().unwrap_or_default();
                attrs.id = format!("n{n}");
            }
        });
        Document::new(content)
    }
}

fn for_each_inline_mut(blocks: &mut [Block], f: &mut dyn FnMut(&mut Inline)) {
    for block in blocks {
        match block {
            Block::Paragraph { content, .. }
            | Block::Heading { content, .. }
            | Block::CodeBlock { content, .. } => content.iter_mut().for_each(&mut *f),
            Block::Blockquote { content }
            | Block::BulletList { content }
            | Block::OrderedList { content, .. }
            | Block::ListItem { content }
            | Block::TaskList { content }
            | Block::TaskItem { content, .. }
            | Block::Table { content }
            | Block::TableRow { content }
            | Block::TableCell { content, .. }
            | Block::TableHeader { content, .. } => for_each_inline_mut(content, f),
            _ => {}
        }
    }
}

/// Un élément de liste ou une cellule doit contenir au moins un paragraphe.
fn non_empty(content: Vec<Block>) -> Vec<Block> {
    if content.is_empty() {
        vec![Block::Paragraph {
            attrs: BlockStyle::default(),
            content: vec![],
        }]
    } else {
        content
    }
}

fn heading_level(level: HeadingLevel) -> u8 {
    match level {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        // L'éditeur s'arrête au niveau 4 (« Titre 3 »).
        _ => 4,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "# Titre

Un **gras**, un *italique*, du ~~barré~~, du `code` et [un lien](https://exemple.fr).

## Liste

- un
- deux
  - imbriqué

1. premier
2. second

- [ ] à faire
- [x] fait

> Une citation

```rust
let x = 1;
```

| Nom | Âge |
| --- | --- |
| Ada | 36  |

---

![logo](https://exemple.fr/logo.png)
";

    #[test]
    fn import_puis_export_garde_le_markdown() {
        let doc = import(SAMPLE);
        let md = export(&doc);
        assert_eq!(md, SAMPLE);
    }

    #[test]
    fn tableau_de_l_editeur() {
        // Tel que l'éditeur l'envoie : cellule vide, retour à la ligne forcé.
        let json = r#"{"type":"doc","content":[{"type":"table","content":[
            {"type":"tableRow","content":[
                {"type":"tableHeader","attrs":{"colspan":1,"rowspan":1,"colwidth":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"Produit"}]}]},
                {"type":"tableHeader","attrs":{"colspan":1,"rowspan":1,"colwidth":[120]},"content":[{"type":"paragraph"}]}]},
            {"type":"tableRow","content":[
                {"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"a"},{"type":"hardBreak"},{"type":"text","text":"b"}]}]},
                {"type":"tableCell","attrs":{"colspan":1,"rowspan":1,"colwidth":null},"content":[{"type":"paragraph","content":[{"type":"text","text":"12"}]}]}]}]}]}"#;
        let doc: Document = serde_json::from_str(json).unwrap();
        let md = export(&doc);
        assert_eq!(
            md,
            "| Produit |     |\n| ------- | --- |\n| a<br>b  | 12  |\n"
        );
        let back = import(&md);
        let Block::Table { content: rows } = &back.content[0] else {
            panic!("{back:?}")
        };
        assert_eq!(rows.len(), 2);
        // Le retour à la ligne revient comme tel, pas comme « <br> ».
        assert_eq!(export(&back), md);
    }

    #[test]
    fn tableau_vide_reste_vide() {
        // Cellules vraiment vides, et « &nbsp; » d'une version précédente.
        for md in [
            "|  |  |\n| --- | --- |\n|  |  |\n",
            "| &nbsp; | &nbsp; |\n| --- | --- |\n| &nbsp; | &nbsp; |\n",
        ] {
            let doc = import(md);
            assert_eq!(
                export(&doc),
                "|     |     |\n| --- | --- |\n|     |     |\n",
                "{md}"
            );
        }
    }

    #[test]
    fn import_reconnait_les_structures() {
        let doc = import(SAMPLE);
        assert!(matches!(&doc.content[0], Block::Heading { attrs, .. } if attrs.level == 1));
        assert!(doc
            .content
            .iter()
            .any(|b| matches!(b, Block::TaskList { .. })));
        assert!(doc.content.iter().any(|b| matches!(b, Block::Table { .. })));
        assert!(doc.content.iter().any(|b| matches!(b, Block::Image { .. })));
        assert!(doc
            .content
            .iter()
            .any(|b| matches!(b, Block::OrderedList { attrs, .. } if attrs.start == 1)));
    }

    #[test]
    fn echappe_les_caracteres_speciaux() {
        let doc = Document::new(vec![Block::paragraph("# pas un titre, 2*3 = 6")]);
        let md = export(&doc);
        assert_eq!(md, "\\# pas un titre, 2\\*3 = 6\n");
        assert_eq!(import(&md).plain_text(), "# pas un titre, 2*3 = 6\n");
    }

    #[test]
    fn texte_brut() {
        let doc = import_plain_text("ligne 1\n\nligne 3");
        assert_eq!(doc.content.len(), 3);
        assert_eq!(export_plain_text(&doc), "ligne 1\n\nligne 3\n");
    }

    #[test]
    fn onglets_aller_retour() {
        use tm_model::{flatten_tabs, split_tabs, Tab};
        let mut first = Tab::new("Chapitre 1", Document::new(vec![Block::paragraph("Début")]));
        first.children.push(Tab::new(
            "Scène",
            Document::new(vec![
                Block::heading(2, "Titre 1"),
                Block::paragraph("Suite"),
            ]),
        ));
        let tabs = vec![
            first,
            Tab::new("Annexe", Document::new(vec![Block::paragraph("Fin")])),
        ];
        let md = export(&flatten_tabs(&tabs));
        assert!(
            md.starts_with("<!-- text-machine:onglet niveau=1 -->\n# Chapitre 1\n\nDébut"),
            "{md}"
        );
        assert!(
            md.contains("<!-- text-machine:onglet niveau=2 -->\n## Scène\n\n## Titre 1"),
            "{md}"
        );
        assert_eq!(split_tabs(import(&md)), tabs);
    }

    #[test]
    fn notes_sommaire_et_suggestions() {
        let doc = Document::new(vec![
            Block::TableOfContents,
            Block::heading(2, "Première partie"),
            Block::Paragraph {
                attrs: BlockStyle::default(),
                content: vec![
                    Inline::text("Texte"),
                    Inline::Footnote {
                        attrs: FootnoteAttrs {
                            id: "a".into(),
                            content: "La note".into(),
                        },
                    },
                    Inline::text(" "),
                    Inline::Text {
                        text: "ajouté".into(),
                        marks: vec![Mark::Insertion {
                            attrs: ChangeAttrs::default(),
                        }],
                    },
                    Inline::Text {
                        text: " retiré".into(),
                        marks: vec![Mark::Deletion {
                            attrs: ChangeAttrs::default(),
                        }],
                    },
                ],
            },
            Block::heading(3, "Sous-partie"),
        ]);
        let md = export(&doc);
        assert!(md.contains("- [Première partie](#première-partie)"), "{md}");
        assert!(md.contains("  - [Sous-partie](#sous-partie)"), "{md}");
        assert!(md.contains("Texte[^1] {++ajouté++}{-- retiré--}"), "{md}");
        assert!(md.contains("[^1]: La note"), "{md}");
        let back = import(&md);
        assert_eq!(back.content[0], Block::TableOfContents);
        assert_eq!(back.content.len(), 4, "{:?}", back.content);
        let Block::Paragraph { content, .. } = &back.content[2] else {
            panic!("{:?}", back.content)
        };
        assert!(matches!(&content[1], Inline::Footnote { attrs } if attrs.content == "La note"));
        assert!(
            matches!(&content[3], Inline::Text { text, marks }
            if text == "ajouté" && matches!(marks[..], [Mark::Insertion { .. }])),
            "{content:?}"
        );
        assert!(
            matches!(&content[4], Inline::Text { text, marks }
            if text == " retiré" && matches!(marks[..], [Mark::Deletion { .. }])),
            "{content:?}"
        );
    }
}
