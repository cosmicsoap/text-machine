//! Markdown et texte brut pour Text Machine.
//!
//! - Export : titres, paragraphes, gras, italique, barré, code, liens,
//!   listes (à puces, numérotées, cases à cocher), citations, blocs de code,
//!   tableaux (format GitHub), images, lignes horizontales.
//! - Import : le même sous-ensemble, lu avec `pulldown-cmark`.
//!
//! Ce que Markdown ne sait pas représenter (couleurs, polices, alignement,
//! souligné…) est perdu à l'export.

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use tm_model::{
    Block, BlockStyle, CellAttrs, CodeBlockAttrs, Document, HeadingAttrs, ImageAttrs, Inline,
    LinkAttrs, Mark, OrderedListAttrs, TaskItemAttrs,
};

// --- Export ------------------------------------------------------------------

/// Convertit un document en Markdown.
pub fn export(doc: &Document) -> String {
    let mut out = blocks_to_markdown(&doc.content);
    out.push('\n');
    out
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
            format!("{} {}", "#".repeat(attrs.level.clamp(1, 6) as usize), inlines_to_markdown(content))
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
                })
                .collect();
            let fence = if code.contains("```") { "~~~" } else { "```" };
            format!("{fence}{}\n{code}\n{fence}", attrs.language.as_deref().unwrap_or(""))
        }
        Block::HorizontalRule => "---".into(),
        Block::PageBreak => return None,
        Block::Image { attrs } => format!(
            "![{}]({})",
            escape(attrs.alt.as_deref().unwrap_or("")),
            attrs.src
        ),
        Block::Table { content } => table_to_markdown(content),
        Block::TableRow { .. } | Block::TableCell { .. } | Block::TableHeader { .. } => {
            return None
        }
    })
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
                    // Une cellule vide garde une espace insécable : certains
                    // éditeurs (Typora) ne voient pas un tableau à l'en-tête vide.
                    .map(|text| if text.is_empty() { "&nbsp;".to_string() } else { text })
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
        }
    }
    out
}

fn text_to_markdown(text: &str, marks: &[Mark]) -> String {
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
        s = format!("[{s}]({})", attrs.href.replace(' ', "%20").replace(')', "%29"));
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
    let mut b = Builder::default();
    let options = Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH | Options::ENABLE_TASKLISTS;
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
}

struct ContainerSlot(Container);

impl Builder {
    fn top(&mut self) -> &mut Vec<Block> {
        if self.stack.is_empty() {
            self.stack.push((ContainerSlot(Container::Root), Vec::new()));
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
                // « &nbsp; » seul : une cellule vide (voir table_to_markdown).
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
        if let (Some(Inline::Text { text: prev, marks: pm }), Inline::Text { text, marks }) =
            (content.last_mut(), &inline)
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
        let mut marks = self.marks.clone();
        marks.extend(extra);
        self.push_inline(Inline::Text {
            text: text.to_string(),
            marks,
        });
    }

    fn event(&mut self, event: Event) {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => self.start_text(TextKind::Paragraph),
                Tag::Heading { level, .. } => self.start_text(TextKind::Heading(heading_level(level))),
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
                Tag::Image { dest_url, .. } => self.image = Some((dest_url.to_string(), String::new())),
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
                if matches!(html.trim().to_ascii_lowercase().as_str(), "<br>" | "<br/>" | "<br />") =>
            {
                self.push_inline(Inline::HardBreak)
            }
            Event::Html(html) | Event::InlineHtml(html) => self.push_text(&html, None),
            Event::SoftBreak => self.push_text(" ", None),
            Event::HardBreak => self.push_inline(Inline::HardBreak),
            Event::Rule => {
                self.flush_text();
                self.top().push(Block::HorizontalRule);
            }
            Event::TaskListMarker(checked) => {
                if let Some((ContainerSlot(Container::Item { checked: c }), _)) = self.stack.last_mut()
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
        let content = self.stack.pop().map(|(_, c)| c).unwrap_or_default();
        Document::new(content)
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
        assert_eq!(md, "| Produit | &nbsp; |\n| ------- | ------ |\n| a<br>b  | 12     |\n");
        let back = import(&md);
        let Block::Table { content: rows } = &back.content[0] else { panic!("{back:?}") };
        assert_eq!(rows.len(), 2);
        // Le retour à la ligne revient comme tel, pas comme « <br> ».
        assert_eq!(export(&back), md);
    }

    #[test]
    fn import_reconnait_les_structures() {
        let doc = import(SAMPLE);
        assert!(matches!(&doc.content[0], Block::Heading { attrs, .. } if attrs.level == 1));
        assert!(doc.content.iter().any(|b| matches!(b, Block::TaskList { .. })));
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
}
