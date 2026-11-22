//! Lecture des fichiers Word (`.docx`).
//!
//! `docx-rs` lit le fichier ; on parcourt ensuite sa représentation JSON
//! (plus stable que ses structures internes) pour reconstruire le modèle.
//! Ce qui n'a pas d'équivalent dans Text Machine (zones de texte, notes,
//! commentaires…) est ignoré, mais leur texte est gardé quand c'est possible.

use std::cell::Cell;
use std::collections::HashMap;

use base64::Engine;
use serde_json::Value;
use tm_model::{
    Block, BlockStyle, CellAttrs, ChangeAttrs, CharStyleAttrs, CustomStyle, Document,
    FootnoteAttrs, HeadingAttrs, HighlightAttrs, ImageAttrs, Inline, LinkAttrs, Margins, Mark,
    OrderedListAttrs, PageSetup, PageSize, ParagraphStyle, StyleKind, StyleSheet, TabTitleAttrs,
    TaskItemAttrs, TextStyleAttrs, MAX_TAB_LEVEL,
};

use crate::DocxError;

const TWIPS_PER_MM: f64 = 1440.0 / 25.4;
const EMU_PER_PX: f64 = 9525.0;

/// Ce qu'on lit dans un fichier Word.
pub type Imported = (Document, PageSetup, StyleSheet);

/// Lit un fichier `.docx` : le document (avec ses titres d'onglet), sa mise
/// en page et ses styles de paragraphe.
pub fn import(bytes: &[u8]) -> Result<Imported, DocxError> {
    let (bytes, notes) =
        crate::notes::extract_notes(bytes).unwrap_or_else(|_| (bytes.to_vec(), HashMap::new()));
    let docx = docx_rs::read_docx(&bytes).map_err(|e| DocxError::Docx(e.to_string()))?;
    let json: Value =
        serde_json::from_str(&docx.json()).map_err(|e| DocxError::Docx(e.to_string()))?;
    let mut reader = Reader::new(&json);
    reader.notes = notes;
    let mut out = Vec::new();
    reader.blocks(&json["document"]["children"], &mut out);
    let content = group_lists(out);
    let page = reader.page_setup(&json["document"]["sectionProperty"]);
    let styles = read_styles(&json["styles"], &reader.headings);
    Ok((Document::new(content), page, styles))
}

/// Les styles « Normal », « Title » et « heading 1 à 3 » du fichier,
/// convertis en feuille de styles. Ce que le fichier ne précise pas garde
/// la valeur par défaut de Text Machine.
fn read_styles(styles: &Value, headings: &HashMap<String, u8>) -> StyleSheet {
    let mut sheet = StyleSheet::default();
    let defaults = &styles["docDefaults"];
    apply_word_style(
        &mut sheet.normal,
        &defaults["runPropertyDefault"]["runProperty"],
        &defaults["paragraphPropertyDefault"]["paragraphProperty"],
    );
    let mut seen = [false; 5];
    for style in styles["styles"].as_array().into_iter().flatten() {
        let id = style["styleId"].as_str().unwrap_or_default();
        let (run, para) = (&style["runProperty"], &style["paragraphProperty"]);
        let custom = id
            .strip_prefix(crate::CUSTOM_PARA_PREFIX)
            .map(|rest| (rest, StyleKind::Paragraph))
            .or_else(|| {
                id.strip_prefix(crate::CUSTOM_CHAR_PREFIX)
                    .map(|rest| (rest, StyleKind::Character))
            });
        if let Some((custom_id, kind)) = custom.filter(|(rest, _)| !rest.is_empty()) {
            let mut st = ParagraphStyle::default();
            apply_word_style(&mut st, run, para);
            let name = style["name"].as_str().unwrap_or(custom_id).to_string();
            sheet.custom.push(CustomStyle {
                id: custom_id.to_string(),
                name,
                kind,
                style: st,
            });
        } else if id == "Normal" {
            apply_word_style(&mut sheet.normal, run, para);
        } else if let Some(&level) = headings.get(id) {
            // Plusieurs styles peuvent donner le même niveau : le premier gagne.
            if !std::mem::replace(&mut seen[level as usize], true) {
                apply_word_style(sheet.heading_mut(level), run, para);
            }
        }
    }
    sheet
}

/// « Lexend Light » → (« Lexend », 300) : Word nomme ainsi les graisses.
pub(crate) fn split_weight(font: &str) -> (String, Option<u16>) {
    for (weight, suffix) in crate::WEIGHT_NAMES {
        if let Some(family) = font.strip_suffix(suffix).and_then(|f| f.strip_suffix(' ')) {
            if !family.trim().is_empty() {
                return (family.to_string(), Some(weight));
            }
        }
    }
    (font.to_string(), None)
}

fn apply_word_style(style: &mut ParagraphStyle, run: &Value, para: &Value) {
    if let Some(font) = run["fonts"]["ascii"].as_str() {
        let (family, weight) = split_weight(font);
        style.font_family = Some(family);
        if weight.is_some() {
            style.font_weight = weight;
        }
    }
    if let Some(sz) = run["sz"].as_u64() {
        style.font_size = sz as f64 / 2.0;
    }
    if let Some(b) = run["bold"].as_bool() {
        style.bold = b;
    }
    if run["underline"].as_str().is_some_and(|u| u != "none") {
        style.underline = true;
    }
    if run["strike"].as_bool() == Some(true) {
        style.strike = true;
    }
    if let Some(fill) = run["shading"]["fill"].as_str().and_then(css_color) {
        style.highlight = Some(fill);
    }
    if let Some(cs) = run["characterSpacing"].as_f64().filter(|v| *v != 0.0) {
        style.letter_spacing = Some((cs / 20.0 * 100.0).round() / 100.0);
    }
    if run["caps"].as_bool() == Some(true) {
        style.text_transform = Some("uppercase".into());
    }
    match run["vertAlign"].as_str() {
        Some("superscript") => style.vertical_align = Some("super".into()),
        Some("subscript") => style.vertical_align = Some("sub".into()),
        _ => {}
    }
    match para["alignment"].as_str() {
        Some("center") => style.text_align = Some("center".into()),
        Some("right" | "end") => style.text_align = Some("right".into()),
        Some("both" | "distribute") => style.text_align = Some("justify".into()),
        _ => {}
    }
    let cm = |v: &Value| {
        v.as_f64()
            .filter(|v| *v != 0.0)
            .map(|tw| (tw / 567.0 * 100.0).round() / 100.0)
    };
    let ind = &para["indent"];
    if let Some(v) = cm(&ind["start"]) {
        style.indent_left = Some(v);
    }
    if let Some(v) = cm(&ind["end"]) {
        style.indent_right = Some(v);
    }
    match ind["specialIndent"]["type"].as_str() {
        Some("firstLine") => style.first_line_indent = cm(&ind["specialIndent"]["val"]),
        Some("hanging") => style.first_line_indent = cm(&ind["specialIndent"]["val"]).map(|v| -v),
        _ => {}
    }
    if let Some(i) = run["italic"].as_bool() {
        style.italic = i;
    }
    if let Some(c) = run["color"]
        .as_str()
        .filter(|c| c.len() == 6 && *c != "000000")
    {
        style.color = Some(format!("#{}", c.to_lowercase()));
    }
    let ls = &para["lineSpacing"];
    if ls["lineRule"].as_str().unwrap_or("auto") == "auto" {
        if let Some(line) = ls["line"].as_f64().filter(|l| *l > 0.0) {
            style.line_height = (line / 240.0 * 100.0).round() / 100.0;
        }
    }
    if let Some(before) = ls["before"].as_f64() {
        style.space_before = before / 20.0;
    }
    if let Some(after) = ls["after"].as_f64() {
        style.space_after = after / 20.0;
    }
}

/// Lit un fichier `.docx` sur le disque.
pub fn open(path: impl AsRef<std::path::Path>) -> Result<Imported, DocxError> {
    import(&std::fs::read(path)?)
}

struct Reader {
    /// Identifiant de style → niveau de titre (1 = « Titre »).
    headings: HashMap<String, u8>,
    /// Identifiant de style → niveau d'onglet (styles « TMTab1 »…).
    tab_styles: HashMap<String, u8>,
    /// Numérotation → (identifiant de liste, format par niveau).
    numberings: HashMap<u64, Vec<String>>,
    images: HashMap<String, String>,
    links: HashMap<String, String>,
    default_size: Option<u64>,
    default_font: Option<String>,
    /// Texte des notes de bas de page, par identifiant Word.
    notes: HashMap<String, String>,
    note_count: Cell<usize>,
}

/// Un bloc lu, avant de regrouper les éléments de liste.
enum Item {
    Block(Block),
    ListPara {
        num: u64,
        level: usize,
        ordered: bool,
        para: Block,
    },
    Task {
        checked: bool,
        para: Block,
    },
    /// Paragraphe de citation (trait à gauche).
    Quote(Block),
}

impl Reader {
    fn new(json: &Value) -> Self {
        let mut headings = HashMap::new();
        let mut tab_styles = HashMap::new();
        for style in json["styles"]["styles"].as_array().into_iter().flatten() {
            let id = style["styleId"].as_str().unwrap_or_default().to_string();
            if let Some(level) = id
                .strip_prefix(crate::TAB_STYLE_PREFIX)
                .and_then(|n| n.parse::<u8>().ok())
            {
                tab_styles.insert(id, level.clamp(1, MAX_TAB_LEVEL));
                continue;
            }
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
            tab_styles,
            numberings,
            images,
            links,
            default_size: defaults["sz"].as_u64(),
            default_font: defaults["fonts"]["ascii"].as_str().map(str::to_string),
            notes: HashMap::new(),
            note_count: Cell::new(0),
        }
    }

    /// Du texte d'un morceau, avec les appels de note (repères posés par
    /// [`crate::notes::extract_notes`]).
    fn text(&self, inlines: &mut Vec<Inline>, text: &str, marks: &[Mark]) {
        use crate::notes::{REF_END, REF_START};
        let mut rest = text;
        while let Some(i) = rest.find(REF_START) {
            push_text(inlines, &rest[..i], marks);
            let after = &rest[i + REF_START.len_utf8()..];
            let Some(j) = after.find(REF_END) else {
                rest = after;
                continue;
            };
            let n = self.note_count.get() + 1;
            self.note_count.set(n);
            inlines.push(Inline::Footnote {
                attrs: FootnoteAttrs {
                    id: format!("n{n}"),
                    content: self.notes.get(&after[..j]).cloned().unwrap_or_default(),
                },
            });
            rest = &after[j + REF_END.len_utf8()..];
        }
        push_text(inlines, rest, marks);
    }

    fn blocks(&self, children: &Value, out: &mut Vec<Item>) {
        for child in children.as_array().into_iter().flatten() {
            let data = &child["data"];
            match child["type"].as_str() {
                Some("paragraph") if is_toc_style(data["property"]["style"].as_str()) => {
                    push_toc(out)
                }
                Some("tableOfContents") => push_toc(out),
                Some("structuredDataTag") if is_toc(data) => push_toc(out),
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
        let numbering = prop["numberingProperty"]["id"]
            .as_u64()
            .filter(|id| *id != 0);
        if numbering.is_none() {
            let start = prop["indent"]["start"].as_f64().unwrap_or(0.0);
            let steps = (start / 720.0).round() as i64;
            if steps > 0 {
                style.indent = Some(steps.min(8) as u8);
            }
        }
        // Titre d'onglet : seulement son texte.
        if let Some(&level) = prop["style"].as_str().and_then(|s| self.tab_styles.get(s)) {
            let (mut inlines, mut pieces) = (Vec::new(), Vec::new());
            for child in data["children"].as_array().into_iter().flatten() {
                self.paragraph_child(child, &[], &mut inlines, &mut pieces);
            }
            let title = Document::new(vec![Block::Paragraph {
                attrs: BlockStyle::default(),
                content: inlines,
            }])
            .plain_text()
            .trim()
            .to_string();
            out.push(Item::Block(Block::TabTitle {
                attrs: TabTitleAttrs { level, title },
            }));
            return;
        }
        let heading = prop["style"]
            .as_str()
            .and_then(|s| self.headings.get(s))
            .copied();
        if heading.is_none() {
            style.custom_style = prop["style"]
                .as_str()
                .and_then(|s| s.strip_prefix(crate::CUSTOM_PARA_PREFIX))
                .filter(|s| !s.is_empty())
                .map(str::to_string);
        }
        // Une citation : trait à gauche, sans numérotation ni titre.
        let quote = numbering.is_none()
            && heading.is_none()
            && prop["borders"]["left"]["val"]
                .as_str()
                .is_some_and(|v| !matches!(v, "nil" | "none"));
        if quote {
            style.indent = style
                .indent
                .and_then(|n| n.checked_sub(1))
                .filter(|n| *n > 0);
        }

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
                        (Some(checked), _) => Item::Task {
                            checked,
                            para: strip_indent(para),
                        },
                        (None, Some(num)) => {
                            let level =
                                prop["numberingProperty"]["level"].as_u64().unwrap_or(0) as usize;
                            let ordered = self
                                .numberings
                                .get(&num)
                                .and_then(|f| f.get(level))
                                .is_some_and(|f| f != "bullet" && f != "none");
                            Item::ListPara {
                                num,
                                level,
                                ordered,
                                para,
                            }
                        }
                        _ if quote => Item::Quote(unquote_color(para)),
                        _ => Item::Block(para),
                    };
                    out.push(item);
                    first_text = false;
                }
                Piece::Block(block) => out.push(Item::Block(block)),
            }
        }
    }

    fn paragraph_child(
        &self,
        child: &Value,
        marks: &[Mark],
        inlines: &mut Vec<Inline>,
        pieces: &mut Vec<Piece>,
    ) {
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
            // Suivi des modifications : des suggestions dans Text Machine.
            Some(kind @ ("insert" | "delete")) => {
                let attrs = ChangeAttrs {
                    author: data["author"].as_str().unwrap_or_default().to_string(),
                    date: data["date"].as_str().unwrap_or_default().to_string(),
                };
                let mut marks = marks.to_vec();
                marks.push(if kind == "insert" {
                    Mark::Insertion { attrs }
                } else {
                    Mark::Deletion { attrs }
                });
                for c in data["children"].as_array().into_iter().flatten() {
                    self.paragraph_child(c, &marks, inlines, pieces);
                }
            }
            _ => {
                for c in data["children"].as_array().into_iter().flatten() {
                    self.paragraph_child(c, marks, inlines, pieces);
                }
            }
        }
    }

    fn run(
        &self,
        data: &Value,
        outer: &[Mark],
        inlines: &mut Vec<Inline>,
        pieces: &mut Vec<Piece>,
    ) {
        let in_link = outer.iter().any(|m| matches!(m, Mark::Link { .. }));
        let mut marks = outer.to_vec();
        marks.extend(self.run_marks(&data["runProperty"], in_link));
        for c in data["children"].as_array().into_iter().flatten() {
            let d = &c["data"];
            match c["type"].as_str() {
                Some("text" | "deleteText") => {
                    self.text(inlines, d["text"].as_str().unwrap_or_default(), &marks)
                }
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
        if let Some(id) = rp["style"]
            .as_str()
            .and_then(|s| s.strip_prefix(crate::CUSTOM_CHAR_PREFIX))
            .filter(|s| !s.is_empty())
        {
            marks.push(Mark::CharStyle {
                attrs: CharStyleAttrs { id: id.to_string() },
            });
        }
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
        if let Some(font) = rp["fonts"]["ascii"]
            .as_str()
            .or(rp["fonts"]["hiAnsi"].as_str())
        {
            if Some(font) != self.default_font.as_deref() {
                let (family, weight) = split_weight(font);
                style.font_family = Some(family);
                style.font_weight = weight.map(|w| w.to_string());
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
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .ok()?;
        let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
            "image/png"
        } else if bytes.starts_with(&[0xFF, 0xD8]) {
            "image/jpeg"
        } else if bytes.starts_with(b"GIF8") {
            "image/gif"
        } else {
            return None;
        };
        let width = pic["size"][0]
            .as_f64()
            .map(|emu| (emu / EMU_PER_PX).round());
        let height = pic["size"][1]
            .as_f64()
            .map(|emu| (emu / EMU_PER_PX).round());
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
                let header = r == 0
                    && d["property"]["shading"]["fill"]
                        .as_str()
                        .is_some_and(|f| f != "auto");
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
            page.size = if letter < a4 {
                PageSize::Letter
            } else {
                PageSize::A4
            };
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

/// Style d'une ligne de sommaire : « TOC1 » (Word), « ToC1 », « Contents 1 »…
fn is_toc_style(style: Option<&str>) -> bool {
    let Some(style) = style else { return false };
    let lower = style.to_lowercase().replace(' ', "");
    ["toc", "contents", "tabledesmatières"].iter().any(|p| {
        lower
            .strip_prefix(p)
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
    })
}

/// Un contrôle de contenu qui contient un sommaire (champ TOC ou lignes de sommaire).
fn is_toc(data: &Value) -> bool {
    let json = data.to_string();
    json.contains("\"TOC ")
        || json.contains("\"tableOfContents\"")
        || data["children"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|c| is_toc_style(c["data"]["property"]["style"].as_str()))
}

/// Un seul bloc pour toutes les lignes d'un sommaire.
fn push_toc(out: &mut Vec<Item>) {
    if !matches!(out.last(), Some(Item::Block(Block::TableOfContents))) {
        out.push(Item::Block(Block::TableOfContents));
    }
}

fn push_text(inlines: &mut Vec<Inline>, text: &str, marks: &[Mark]) {
    if text.is_empty() {
        return;
    }
    if let Some(Inline::Text {
        text: prev,
        marks: pm,
    }) = inlines.last_mut()
    {
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

/// Le gris des citations vient de la citation, pas du texte : on l'enlève.
fn unquote_color(block: Block) -> Block {
    match block {
        Block::Paragraph { attrs, content } => Block::Paragraph {
            attrs,
            content: content
                .into_iter()
                .map(|i| match i {
                    Inline::Text { text, marks } => Inline::Text {
                        text,
                        marks: marks
                            .into_iter()
                            .filter_map(|m| match m {
                                Mark::TextStyle { mut attrs } => {
                                    if attrs.color.as_deref() == Some("#5f6670") {
                                        attrs.color = None;
                                    }
                                    (attrs != TextStyleAttrs::default())
                                        .then_some(Mark::TextStyle { attrs })
                                }
                                other => Some(other),
                            })
                            .collect(),
                    },
                    other => other,
                })
                .collect(),
        },
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
            Item::Quote(para) => {
                let mut content = vec![para];
                while let Some(Item::Quote(_)) = iter.peek() {
                    if let Some(Item::Quote(para)) = iter.next() {
                        content.push(para);
                    }
                }
                out.push(Block::Blockquote { content });
            }
            Item::Task { checked, para } => {
                let mut content = vec![task_item(checked, para)];
                while let Some(Item::Task { .. }) = iter.peek() {
                    if let Some(Item::Task { checked, para }) = iter.next() {
                        content.push(task_item(checked, para));
                    }
                }
                out.push(Block::TaskList { content });
            }
            Item::ListPara {
                num,
                level,
                ordered,
                para,
            } => {
                let top = level;
                let mut run = vec![(level, ordered, para)];
                // Une sous-liste peut avoir sa propre numérotation : elle reste
                // dans la liste tant qu'elle est plus indentée.
                while let Some(Item::ListPara {
                    num: n, level: l, ..
                }) = iter.peek()
                {
                    if *n != num && *l <= top {
                        break;
                    }
                    if let Some(Item::ListPara {
                        level,
                        ordered,
                        para,
                        ..
                    }) = iter.next()
                    {
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
        items.push(Block::ListItem {
            content: vec![para],
        });
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
