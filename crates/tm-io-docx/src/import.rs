//! Lecture des fichiers Word (`.docx`).
//!
//! `docx-rs` lit le fichier ; on parcourt ensuite sa représentation JSON
//! (plus stable que ses structures internes) pour reconstruire le modèle.
//! Ce qui n'a pas d'équivalent dans Text Machine (zones de texte, notes,
//! commentaires…) est ignoré, mais leur texte est gardé quand c'est possible.

use std::collections::HashMap;

use base64::Engine;
use serde_json::Value;
use tm_model::{
    Block, BlockStyle, CellAttrs, Document, HeadingAttrs, HighlightAttrs, ImageAttrs, Inline,
    LinkAttrs, Mark, Margins, OrderedListAttrs, PageSetup, PageSize, TaskItemAttrs,
    TextStyleAttrs,
};

use crate::DocxError;

const TWIPS_PER_MM: f64 = 1440.0 / 25.4;
const EMU_PER_PX: f64 = 9525.0;

/// Lit un fichier `.docx` : le document et sa mise en page.
pub fn import(bytes: &[u8]) -> Result<(Document, PageSetup), DocxError> {
    let docx = docx_rs::read_docx(bytes).map_err(|e| DocxError::Docx(e.to_string()))?;
    let json: Value = serde_json::from_str(&docx.json()).map_err(|e| DocxError::Docx(e.to_string()))?;
    let reader = Reader::new(&json);
    let mut out = Vec::new();
    reader.blocks(&json["document"]["children"], &mut out);
    let content = group_lists(out);
    let page = reader.page_setup(&json["document"]["sectionProperty"]);
    Ok((Document::new(content), page))
}

/// Lit un fichier `.docx` sur le disque.
pub fn open(path: impl AsRef<std::path::Path>) -> Result<(Document, PageSetup), DocxError> {
    import(&std::fs::read(path)?)
}

struct Reader {
    /// Identifiant de style → niveau de titre (1 = « Titre »).
    headings: HashMap<String, u8>,
    /// Numérotation → (identifiant de liste, format par niveau).
    numberings: HashMap<u64, Vec<String>>,
    images: HashMap<String, String>,
    links: HashMap<String, String>,
    default_size: Option<u64>,
    default_font: Option<String>,
}

/// Un bloc lu, avant de regrouper les éléments de liste.
enum Item {
    Block(Block),
    ListPara { num: u64, level: usize, ordered: bool, para: Block },
    Task { checked: bool, para: Block },
}

impl Reader {
    fn new(json: &Value) -> Self {
        let mut headings = HashMap::new();
        for style in json["styles"]["styles"].as_array().into_iter().flatten() {
            let id = style["styleId"].as_str().unwrap_or_default().to_string();
            let name = style["name"].as_str().unwrap_or_default().to_lowercase();
            let level = if name == "title" || id == "Title" {
                Some(1)
            } else {
                name.strip_prefix("heading ")
                    .and_then(|n| n.trim().parse::<u8>().ok())
                    .map(|n| (n + 1).min(4))
            };
            if let Some(level) = level {
                headings.insert(id, level);
            }
        }

        let mut abstracts: HashMap<u64, Vec<String>> = HashMap::new();
        let numbering = &json["numberings"];
        for a in numbering["abstractNums"].as_array().into_iter().flatten() {
            let formats = a["levels"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|l| l["format"].as_str().unwrap_or("bullet").to_string())
                .collect();
            // En cas de doublon, la dernière définition gagne (comme Word).
            abstracts.insert(a["id"].as_u64().unwrap_or(0), formats);
        }
        let mut numberings = HashMap::new();
        for n in numbering["numberings"].as_array().into_iter().flatten() {
            let abs = n["abstractNumId"].as_u64().unwrap_or(0);
            if let Some(formats) = abstracts.get(&abs) {
                numberings.insert(n["id"].as_u64().unwrap_or(0), formats.clone());
            }
        }

        let mut images = HashMap::new();
        for img in json["images"].as_array().into_iter().flatten() {
            if let (Some(id), Some(data)) = (img[0].as_str(), img[2].as_str()) {
                images.insert(id.to_string(), data.to_string());
            }
        }
        let mut links = HashMap::new();
        for link in json["hyperlinks"].as_array().into_iter().flatten() {
            if let (Some(id), Some(url)) = (link[0].as_str(), link[1].as_str()) {
                links.insert(id.to_string(), url.to_string());
            }
        }

        let defaults = &json["styles"]["docDefaults"]["runPropertyDefault"]["runProperty"];
        Self {
            headings,
            numberings,
            images,
            links,
            default_size: defaults["sz"].as_u64(),
            default_font: defaults["fonts"]["ascii"].as_str().map(str::to_string),
        }
    }

    fn blocks(&self, children: &Value, out: &mut Vec<Item>) {
        for child in children.as_array().into_iter().flatten() {
            let data = &child["data"];
            match child["type"].as_str() {
                Some("paragraph") => self.paragraph(data, out),
                Some("table") => out.push(Item::Block(self.table(data))),
                // Blocs « conteneurs » (contrôles de contenu…) : on lit l'intérieur.
                _ => {
                    if data["children"].is_array() {
                        self.blocks(&data["children"], out);
                    }
                }
            }
        }
    }

    fn paragraph(&self, data: &Value, out: &mut Vec<Item>) {
        let prop = &data["property"];
        let mut style = BlockStyle::default();
        if let Some(align) = prop["alignment"].as_str() {
            style.text_align = match align {
                "center" => Some("center".into()),
                "right" | "end" => Some("right".into()),
                "both" | "justify" | "distribute" => Some("justify".into()),
                _ => None,
            };
        }
        if prop["lineSpacing"]["lineRule"].as_str().unwrap_or("auto") == "auto" {
            if let Some(line) = prop["lineSpacing"]["line"].as_f64() {
                let lh = ((line / 240.0) * 100.0).round() / 100.0;
                if lh > 0.0 {
                    style.line_height = Some(format_number(lh));
                }
            }
        }
        let numbering = prop["numberingProperty"]["id"].as_u64().filter(|id| *id != 0);
        if numbering.is_none() {
            let start = prop["indent"]["start"].as_f64().unwrap_or(0.0);
            let steps = (start / 720.0).round() as i64;
            if steps > 0 {
                style.indent = Some(steps.min(8) as u8);
            }
        }
        let heading = prop["style"].as_str().and_then(|s| self.headings.get(s)).copied();

        // Le texte, découpé aux images et aux sauts de page (qui sont des blocs).
        let mut pieces: Vec<Piece> = Vec::new();
        let mut inlines = Vec::new();
        for child in data["children"].as_array().into_iter().flatten() {
            self.paragraph_child(child, &[], &mut inlines, &mut pieces);
        }
        pieces.push(Piece::Text(inlines));

        let make = |content: Vec<Inline>| match heading {
            Some(level) => Block::Heading {
                attrs: HeadingAttrs {
                    level,
                    style: style.clone(),
                },
                content,
            },
            None => Block::Paragraph {
                attrs: style.clone(),
                content,
            },
        };

        let had_other = pieces.iter().any(|p| !matches!(p, Piece::Text(_)));
        let mut first_text = true;
        for piece in pieces {
            match piece {
                Piece::Text(content) => {
                    if content.is_empty() && had_other {
                        continue;
                    }
                    let mut content = content;
                    // Une case à cocher exportée par Text Machine : « ☐ » ou « ☑ ».
                    let task = if first_text && heading.is_none() {
                        take_checkbox(&mut content)
                    } else {
                        None
                    };
                    // Ligne de séparation exportée par Text Machine.
                    if matches!(content.as_slice(), [Inline::Text { text, .. }] if text == "⁂") {
                        out.push(Item::Block(Block::HorizontalRule));
                        first_text = false;
                        continue;
                    }
                    let para = make(content);
                    let item = match (task, numbering) {
                        (Some(checked), _) => Item::Task { checked, para: strip_indent(para) },
                        (None, Some(num)) => {
                            let level = prop["numberingProperty"]["level"].as_u64().unwrap_or(0) as usize;
                            let ordered = self
                                .numberings
                                .get(&num)
                                .and_then(|f| f.get(level))
                                .is_some_and(|f| f != "bullet" && f != "none");
                            Item::ListPara { num, level, ordered, para }
                        }
                        _ => Item::Block(para),
                    };
                    out.push(item);
                    first_text = false;
                }
                Piece::Block(block) => out.push(Item::Block(block)),
            }
        }
    }

    fn paragraph_child(&self, child: &Value, marks: &[Mark], inlines: &mut Vec<Inline>, pieces: &mut Vec<Piece>) {
        let data = &child["data"];
        match child["type"].as_str() {
            Some("run") => self.run(data, marks, inlines, pieces),
            Some("hyperlink") => {
                let href = data["rid"]
                    .as_str()
                    .and_then(|rid| self.links.get(rid).cloned())
                    .or_else(|| data["link"].as_str().map(|a| format!("#{a}")));
                let mut marks = marks.to_vec();
                if let Some(href) = href {
                    marks.push(Mark::Link {
                        attrs: LinkAttrs { href },
                    });
                }
                for c in data["children"].as_array().into_iter().flatten() {
                    self.paragraph_child(c, &marks, inlines, pieces);
                }
            }
            // Insertions (suivi des modifications), contrôles de contenu… : on lit l'intérieur.
            Some("delete") => {}
            _ => {
                for c in data["children"].as_array().into_iter().flatten() {
                    self.paragraph_child(c, marks, inlines, pieces);
                }
            }
        }
    }

    fn run(&self, data: &Value, outer: &[Mark], inlines: &mut Vec<Inline>, pieces: &mut Vec<Piece>) {
        let in_link = outer.iter().any(|m| matches!(m, Mark::Link { .. }));
        let mut marks = outer.to_vec();
        marks.extend(self.run_marks(&data["runProperty"], in_link));
        for c in data["children"].as_array().into_iter().flatten() {
            let d = &c["data"];
            match c["type"].as_str() {
                Some("text") => push_text(inlines, d["text"].as_str().unwrap_or_default(), &marks),
                Some("tab") => push_text(inlines, "\t", &marks),
                Some("break") => {
                    if d["breakType"].as_str() == Some("page") {
                        pieces.push(Piece::Text(std::mem::take(inlines)));
                        pieces.push(Piece::Block(Block::PageBreak));
                    } else {
                        inlines.push(Inline::HardBreak);
                    }
                }
                Some("drawing") => {
                    if let Some(image) = self.image(d) {
                        pieces.push(Piece::Text(std::mem::take(inlines)));
                        pieces.push(Piece::Block(image));
                    }
                }
                _ => {}
            }
        }
    }

    fn run_marks(&self, rp: &Value, in_link: bool) -> Vec<Mark> {
        let on = |key: &str| match &rp[key] {
            Value::Bool(b) => *b,
            Value::Null => false,
            _ => true,
        };
        let mut marks = Vec::new();
        if on("bold") {
            marks.push(Mark::Bold);
        }
        if on("italic") {
            marks.push(Mark::Italic);
        }
        if !in_link {
            if let Some(u) = rp["underline"].as_str() {
                if u != "none" {
                    marks.push(Mark::Underline);
                }
            }
        }
        if on("strike") || on("dstrike") {
            marks.push(Mark::Strike);
        }
        match rp["vertAlign"].as_str() {
            Some("superscript") => marks.push(Mark::Superscript),
            Some("subscript") => marks.push(Mark::Subscript),
            _ => {}
        }

        let mut style = TextStyleAttrs::default();
        if let Some(font) = rp["fonts"]["ascii"].as_str().or(rp["fonts"]["hiAnsi"].as_str()) {
            if Some(font) != self.default_font.as_deref() {
                style.font_family = Some(font.to_string());
            }
        }
        if let Some(sz) = rp["sz"].as_u64() {
            if Some(sz) != self.default_size {
                style.font_size = Some(format!("{}pt", format_number(sz as f64 / 2.0)));
            }
        }
        if !in_link {
            if let Some(color) = rp["color"].as_str().and_then(css_color) {
                style.color = Some(color);
            }
        }
        if style != TextStyleAttrs::default() {
            marks.push(Mark::TextStyle { attrs: style });
        }

        let highlight = rp["shading"]["fill"]
            .as_str()
            .and_then(css_color)
            .or_else(|| rp["highlight"].as_str().and_then(named_highlight));
        if let Some(color) = highlight {
            marks.push(Mark::Highlight {
                attrs: HighlightAttrs { color: Some(color) },
            });
        }
        marks
    }

    fn image(&self, drawing: &Value) -> Option<Block> {
        let pic = &drawing["data"];
        let data = self.images.get(pic["id"].as_str()?)?;
        let bytes = base64::engine::general_purpose::STANDARD.decode(data).ok()?;
        let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
            "image/png"
        } else if bytes.starts_with(&[0xFF, 0xD8]) {
            "image/jpeg"
        } else if bytes.starts_with(b"GIF8") {
            "image/gif"
        } else {
            return None;
        };
        let width = pic["size"][0].as_f64().map(|emu| (emu / EMU_PER_PX).round());
        let height = pic["size"][1].as_f64().map(|emu| (emu / EMU_PER_PX).round());
        Some(Block::Image {
            attrs: ImageAttrs {
                src: format!("data:{mime};base64,{data}"),
                alt: None,
                title: None,
                width,
                height,
            },
        })
    }

    fn table(&self, data: &Value) -> Block {
        let mut rows = Vec::new();
        for (r, row) in data["rows"].as_array().into_iter().flatten().enumerate() {
            let mut cells = Vec::new();
            for cell in row["data"]["cells"].as_array().into_iter().flatten() {
                let d = &cell["data"];
                // Cellules fusionnées verticalement : seule la première est gardée.
                if d["property"]["verticalMerge"].as_str() == Some("continue") {
                    continue;
                }
                let mut items = Vec::new();
                self.blocks(&d["children"], &mut items);
                let mut content = group_lists(items);
                if content.is_empty() {
                    content.push(Block::Paragraph {
                        attrs: BlockStyle::default(),
                        content: vec![],
                    });
                }
                let attrs = CellAttrs {
                    colspan: d["property"]["gridSpan"].as_u64().unwrap_or(1).max(1) as u32,
                    ..CellAttrs::default()
                };
                let header = r == 0 && d["property"]["shading"]["fill"].as_str().is_some_and(|f| f != "auto");
                cells.push(if header {
                    // Le gras de l'en-tête vient du style de la cellule.
                    Block::TableHeader {
                        attrs,
                        content: content.into_iter().map(unbold).collect(),
                    }
                } else {
                    Block::TableCell { attrs, content }
                });
            }
            rows.push(Block::TableRow { content: cells });
        }
        Block::Table { content: rows }
    }

    fn page_setup(&self, section: &Value) -> PageSetup {
        let mut page = PageSetup::default();
        let mm = |v: &Value| v.as_f64().map(|t| (t / TWIPS_PER_MM * 10.0).round() / 10.0);
        if let (Some(w), Some(h)) = (mm(&section["pageSize"]["w"]), mm(&section["pageSize"]["h"])) {
            page.landscape = w > h;
            let (short, long) = (w.min(h), w.max(h));
            let letter = (short - 215.9).abs() + (long - 279.4).abs();
            let a4 = (short - 210.0).abs() + (long - 297.0).abs();
            page.size = if letter < a4 { PageSize::Letter } else { PageSize::A4 };
        }
        let m = &section["pageMargin"];
        let default = Margins::default();
        page.margins = Margins {
            top: mm(&m["top"]).unwrap_or(default.top),
            bottom: mm(&m["bottom"]).unwrap_or(default.bottom),
            left: mm(&m["left"]).unwrap_or(default.left),
            right: mm(&m["right"]).unwrap_or(default.right),
        };
        page.page_numbers = section["footer"].to_string().contains("PAGE");
        page
    }
}

enum Piece {
    Text(Vec<Inline>),
    Block(Block),
}

fn push_text(inlines: &mut Vec<Inline>, text: &str, marks: &[Mark]) {
    if text.is_empty() {
        return;
    }
    if let Some(Inline::Text { text: prev, marks: pm }) = inlines.last_mut() {
        if pm == marks {
            prev.push_str(text);
            return;
        }
    }
    inlines.push(Inline::Text {
        text: text.to_string(),
        marks: marks.to_vec(),
    });
}

/// Retire « ☐ » / « ☑ » du début du paragraphe ; renvoie l'état de la case.
fn take_checkbox(content: &mut Vec<Inline>) -> Option<bool> {
    let Some(Inline::Text { text, .. }) = content.first_mut() else {
        return None;
    };
    let checked = if text.starts_with('☑') || text.starts_with('☒') {
        true
    } else if text.starts_with('☐') {
        false
    } else {
        return None;
    };
    let rest = text.chars().skip(1).collect::<String>();
    let rest = rest.strip_prefix(' ').unwrap_or(&rest).to_string();
    if rest.is_empty() {
        content.remove(0);
    } else {
        *text = rest;
    }
    Some(checked)
}

/// Le retrait d'une case à cocher vient de la liste, pas du paragraphe.
fn strip_indent(block: Block) -> Block {
    match block {
        Block::Paragraph { mut attrs, content } => {
            attrs.indent = None;
            Block::Paragraph { attrs, content }
        }
        other => other,
    }
}

fn unbold(block: Block) -> Block {
    match block {
        Block::Paragraph { attrs, content } => Block::Paragraph {
            attrs,
            content: content
                .into_iter()
                .map(|i| match i {
                    Inline::Text { text, marks } => Inline::Text {
                        text,
                        marks: marks.into_iter().filter(|m| *m != Mark::Bold).collect(),
                    },
                    other => other,
                })
                .collect(),
        },
        other => other,
    }
}

/// Regroupe les paragraphes numérotés consécutifs en listes (imbriquées
/// selon leur niveau), et les cases à cocher consécutives en une liste.
fn group_lists(items: Vec<Item>) -> Vec<Block> {
    let mut out = Vec::new();
    let mut iter = items.into_iter().peekable();
    while let Some(item) = iter.next() {
        match item {
            Item::Block(b) => out.push(b),
            Item::Task { checked, para } => {
                let mut content = vec![task_item(checked, para)];
                while let Some(Item::Task { .. }) = iter.peek() {
                    if let Some(Item::Task { checked, para }) = iter.next() {
                        content.push(task_item(checked, para));
                    }
                }
                out.push(Block::TaskList { content });
            }
            Item::ListPara { num, level, ordered, para } => {
                let top = level;
                let mut run = vec![(level, ordered, para)];
                // Une sous-liste peut avoir sa propre numérotation : elle reste
                // dans la liste tant qu'elle est plus indentée.
                while let Some(Item::ListPara { num: n, level: l, .. }) = iter.peek() {
                    if *n != num && *l <= top {
                        break;
                    }
                    if let Some(Item::ListPara { level, ordered, para, .. }) = iter.next() {
                        run.push((level, ordered, para));
                    }
                }
                let min = run.iter().map(|(l, ..)| *l).min().unwrap_or(0);
                let mut pos = 0;
                out.push(build_list(&mut run, &mut pos, min));
            }
        }
    }
    out
}

fn task_item(checked: bool, para: Block) -> Block {
    Block::TaskItem {
        attrs: TaskItemAttrs { checked },
        content: vec![para],
    }
}

fn build_list(run: &mut Vec<(usize, bool, Block)>, pos: &mut usize, level: usize) -> Block {
    let ordered = run[*pos].1;
    let mut items: Vec<Block> = Vec::new();
    while *pos < run.len() {
        let l = run[*pos].0;
        if l < level {
            break;
        }
        if l > level {
            // Sous-liste : elle va dans l'élément précédent.
            let sub = build_list(run, pos, l);
            match items.last_mut() {
                Some(Block::ListItem { content }) => content.push(sub),
                _ => items.push(Block::ListItem {
                    content: vec![
                        Block::Paragraph {
                            attrs: BlockStyle::default(),
                            content: vec![],
                        },
                        sub,
                    ],
                }),
            }
            continue;
        }
        let para = std::mem::replace(
            &mut run[*pos].2,
            Block::Paragraph {
                attrs: BlockStyle::default(),
                content: vec![],
            },
        );
        items.push(Block::ListItem { content: vec![para] });
        *pos += 1;
    }
    if ordered {
        Block::OrderedList {
            attrs: OrderedListAttrs::default(),
            content: items,
        }
    } else {
        Block::BulletList { content: items }
    }
}

/// `C0392B` → `#c0392b` ; `auto` → rien.
fn css_color(value: &str) -> Option<String> {
    (value.len() == 6 && value.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("#{}", value.to_lowercase()))
}

/// Couleurs de surlignage prédéfinies de Word.
fn named_highlight(name: &str) -> Option<String> {
    Some(
        match name {
            "yellow" => "#ffff00",
            "green" => "#00ff00",
            "cyan" => "#00ffff",
            "magenta" => "#ff00ff",
            "blue" => "#0000ff",
            "red" => "#ff0000",
            "darkBlue" => "#000080",
            "darkCyan" => "#008080",
            "darkGreen" => "#008000",
            "darkMagenta" => "#800080",
            "darkRed" => "#800000",
            "darkYellow" => "#808000",
            "darkGray" => "#808080",
            "lightGray" => "#c0c0c0",
            "black" => "#000000",
            _ => return None,
        }
        .to_string(),
    )
}

/// 1.5 → "1.5", 2.0 → "2", 1.15 → "1.15".
fn format_number(v: f64) -> String {
    let s = format!("{v:.2}");
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}
