//! Lecture et écriture Word (`.docx`) pour Text Machine.
//!
//! Gardé : styles de titre (reconnus par Word dans son plan), police,
//! taille, couleurs, surlignage, gras/italique/souligné/barré, exposant et
//! indice, liens, alignement, interligne, retraits, listes (à puces,
//! numérotées, cases à cocher), citations, code, tableaux, images, sauts de
//! page, format de page, marges et numéros de page.

mod import;

pub use import::{import, open, Imported};

use base64::Engine;
use docx_rs::{
    AbstractNumbering, AlignmentType, BreakType, Docx, Footer, Hyperlink, HyperlinkType,
    IndentLevel, Level, LevelJc, LevelText, LineSpacing, LineSpacingType, NumberFormat, Numbering,
    NumberingId, PageMargin, PageNum, PageOrientationType, Paragraph, ParagraphBorder,
    ParagraphBorderPosition, ParagraphBorders, Pic, Run, RunFonts, Shading, SpecialIndentType,
    Start, Style, StyleType, Table, TableCell, TableRow, VertAlignType,
};
use tm_model::{
    Block, BlockStyle, Document, Inline, Mark, PageSetup, ParagraphStyle, StyleKind, StyleSheet,
};

#[derive(Debug, thiserror::Error)]
pub enum DocxError {
    #[error("impossible d'écrire le fichier : {0}")]
    Io(#[from] std::io::Error),
    #[error("impossible de créer le document Word : {0}")]
    Docx(String),
}

/// Citations : couleur du texte et du trait à gauche.
const QUOTE_TEXT: &str = "5F6670";
const QUOTE_BORDER: &str = "D6D9DE";
/// Police si la feuille de styles n'en donne aucune.
const DEFAULT_FONT: &str = "Georgia";
/// Styles Word des titres d'onglet (« TMTab1 » = onglet, « TMTab2 » =
/// sous-onglet…). Ils permettent de retrouver les onglets à l'ouverture.
pub(crate) const TAB_STYLE_PREFIX: &str = "TMTab";
/// Styles Word des styles créés par l'utilisateur : « TMStyle<id> » pour un
/// style de paragraphe, « TMChar<id> » pour un style de caractère.
pub(crate) const CUSTOM_PARA_PREFIX: &str = "TMStyle";
pub(crate) const CUSTOM_CHAR_PREFIX: &str = "TMChar";
/// 1 mm en vingtièmes de point (unité de Word pour les longueurs).
const TWIPS_PER_MM: f64 = 1440.0 / 25.4;
/// Un cran de retrait : 1,27 cm, comme dans l'éditeur.
const INDENT_STEP_TWIPS: i32 = 720;
/// 1 pixel d'écran (96 ppp) en EMU, l'unité des images dans Word.
const EMU_PER_PX: f64 = 9525.0;

/// Exporte le document en `.docx` (le contenu du fichier).
pub fn export(doc: &Document, page: &PageSetup, styles: &StyleSheet) -> Result<Vec<u8>, DocxError> {
    let mut w = Writer::new(page, styles);
    for (i, block) in doc.content.iter().enumerate() {
        w.first = i == 0;
        w.block(block, &Ctx::default());
    }
    let mut out = std::io::Cursor::new(Vec::new());
    w.docx
        .build()
        .pack(&mut out)
        .map_err(|e| DocxError::Docx(e.to_string()))?;
    Ok(out.into_inner())
}

/// Exporte le document dans un fichier `.docx`.
pub fn save(
    path: impl AsRef<std::path::Path>,
    doc: &Document,
    page: &PageSetup,
    styles: &StyleSheet,
) -> Result<(), DocxError> {
    std::fs::write(path, export(doc, page, styles)?)?;
    Ok(())
}

/// Ce qui s'applique aux paragraphes selon l'endroit où ils sont.
#[derive(Clone, Default)]
struct Ctx {
    /// Liste en cours : numérotation et niveau d'imbrication.
    list: Option<(usize, usize)>,
    /// Préfixe d'une case à cocher (☐ ou ☑).
    task: Option<&'static str>,
    quote_level: i32,
    code: bool,
    /// Cellule d'en-tête de tableau : texte en gras.
    bold: bool,
    /// Paragraphe de titre ou de style personnalisé : le style Word donne
    /// déjà la mise en forme.
    heading: bool,
}

struct Writer {
    docx: Docx,
    next_numbering: usize,
    content_width_px: f64,
    /// Gras, italique et couleur du texte normal (Word ne les met pas dans
    /// les réglages par défaut : on les ajoute à chaque morceau de texte).
    normal: ParagraphStyle,
    /// Premier bloc du document (pas de saut de page avant un onglet).
    first: bool,
    sheet: StyleSheet,
}

/// Espacement Word (vingtièmes de point) d'un style.
fn spacing(style: &ParagraphStyle) -> LineSpacing {
    LineSpacing::new()
        .line_rule(LineSpacingType::Auto)
        .line((style.line_height * 240.0).round() as i32)
        .before((style.space_before * 20.0).round() as u32)
        .after((style.space_after * 20.0).round() as u32)
}

/// Style Word de paragraphe à partir d'un style de la feuille.
fn word_style(id: &str, name: &str, style: &ParagraphStyle) -> Style {
    let s = Style::new(id, StyleType::Paragraph)
        .name(name)
        .based_on("Normal")
        .next("Normal")
        .q_format(true)
        .line_spacing(spacing(style));
    paragraph_props(run_props(s, style), style)
}

/// Style Word de caractère.
fn word_char_style(id: &str, name: &str, style: &ParagraphStyle) -> Style {
    let s = Style::new(id, StyleType::Character)
        .name(name)
        .q_format(true);
    run_props(s, style)
}

/// Nom Word d'une graisse : « Lexend Light », « Lexend SemiBold »… Word
/// désigne les graisses autres que normal et gras par ce nom de police.
pub(crate) const WEIGHT_NAMES: [(u16, &str); 7] = [
    (100, "Thin"),
    (200, "ExtraLight"),
    (300, "Light"),
    (500, "Medium"),
    (600, "SemiBold"),
    (800, "ExtraBold"),
    (900, "Black"),
];

/// La police Word et le gras d'une famille dans une graisse.
fn word_font(family: &str, weight: u16) -> (String, bool) {
    let rounded = ((weight as f64 / 100.0).round() as u16).clamp(1, 9) * 100;
    match WEIGHT_NAMES.iter().find(|(w, _)| *w == rounded) {
        Some((_, suffix)) => (format!("{family} {suffix}"), false),
        None => (family.to_string(), rounded == 700),
    }
}

/// Mise en forme des caractères d'un style Word.
fn run_props(mut s: Style, style: &ParagraphStyle) -> Style {
    s = s.size((style.font_size * 2.0).round() as usize);
    let weight = style.weight();
    let (font, bold) = match style.font_family.as_deref() {
        Some(family) => {
            let (font, bold) = word_font(family, weight);
            (Some(font), bold)
        }
        None => (None, weight >= 600),
    };
    if let Some(font) = font {
        s = s.fonts(fonts(&font));
    }
    if bold {
        s = s.bold();
    }
    if style.italic {
        s = s.italic();
    }
    if let Some(c) = hex(style.color.as_deref()) {
        s = s.color(c);
    }
    if style.underline {
        s = s.underline("single");
    }
    let mut rp = std::mem::take(&mut s.run_property);
    if style.strike {
        rp = rp.strike();
    }
    if let Some(c) = hex(style.highlight.as_deref()) {
        rp = rp.shading(Shading::new().fill(c));
    }
    if let Some(ls) = style.letter_spacing.filter(|v| *v != 0.0) {
        rp = rp.character_spacing((ls * 20.0).round() as i32);
    }
    if style.text_transform.as_deref() == Some("uppercase") {
        rp = rp.caps();
    }
    match style.vertical_align.as_deref() {
        Some("super") => rp = rp.vert_align(VertAlignType::SuperScript),
        Some("sub") => rp = rp.vert_align(VertAlignType::SubScript),
        _ => {}
    }
    s.run_property = rp;
    s
}

/// Alignement et retraits d'un style de paragraphe Word.
fn paragraph_props(mut s: Style, style: &ParagraphStyle) -> Style {
    if let Some(align) = style.text_align.as_deref() {
        s = s.align(alignment(align));
    }
    let tw = |cm: Option<f64>| cm.map(|v| (v * 10.0 * TWIPS_PER_MM).round() as i32);
    let (left, right) = (tw(style.indent_left), tw(style.indent_right));
    let special = tw(style.first_line_indent).filter(|v| *v != 0).map(|v| {
        if v > 0 {
            SpecialIndentType::FirstLine(v)
        } else {
            SpecialIndentType::Hanging(-v)
        }
    });
    if left.is_some() || right.is_some() || special.is_some() {
        s = s.indent(left, special, right, None);
    }
    s
}

fn alignment(align: &str) -> AlignmentType {
    match align {
        "center" => AlignmentType::Center,
        "right" => AlignmentType::Right,
        "justify" => AlignmentType::Both,
        _ => AlignmentType::Left,
    }
}

impl Writer {
    fn new(page: &PageSetup, sheet: &StyleSheet) -> Self {
        let (w_mm, h_mm) = page.dimensions_mm();
        let m = &page.margins;
        let twips = |mm: f64| (mm * TWIPS_PER_MM).round() as i32;
        let mut docx = Docx::new()
            .page_size(twips(w_mm) as u32, twips(h_mm) as u32)
            .page_margin(
                PageMargin::new()
                    .top(twips(m.top))
                    .bottom(twips(m.bottom))
                    .left(twips(m.left))
                    .right(twips(m.right))
                    .header(twips(m.top / 2.0))
                    .footer(twips(m.bottom / 2.0)),
            )
            .default_fonts(fonts(
                sheet.normal.font_family.as_deref().unwrap_or(DEFAULT_FONT),
            ))
            .default_size((sheet.normal.font_size * 2.0).round() as usize)
            .default_line_spacing(spacing(&sheet.normal));
        // Style « Normal » : alignement et retraits du texte normal.
        let normal = paragraph_props(Style::new("Normal", StyleType::Paragraph), &sheet.normal);
        match docx
            .styles
            .styles
            .iter_mut()
            .find(|s| s.style_id == "Normal")
        {
            Some(s) => s.paragraph_property = normal.paragraph_property,
            None => docx = docx.add_style(normal.name("Normal")),
        }
        if page.landscape {
            docx = docx.page_orient(PageOrientationType::Landscape);
        }
        if page.page_numbers {
            docx = docx.footer(
                Footer::new().add_paragraph(
                    Paragraph::new()
                        .align(AlignmentType::Center)
                        .add_page_num(PageNum::new()),
                ),
            );
        }
        // Styles de titre : ceux de la feuille de styles, avec un niveau de
        // plan pour que Word les montre dans son volet de navigation.
        for (level, id, name, outline) in [
            (1, "Title", "Title", 0),
            (2, "Heading1", "heading 1", 0),
            (3, "Heading2", "heading 2", 1),
            (4, "Heading3", "heading 3", 2),
        ] {
            let style = word_style(id, name, sheet.heading(level)).outline_lvl(outline);
            docx = docx.add_style(style);
        }
        // Styles créés par l'utilisateur.
        for custom in &sheet.custom {
            let style = match custom.kind {
                StyleKind::Paragraph => word_style(
                    &format!("{CUSTOM_PARA_PREFIX}{}", custom.id),
                    &custom.name,
                    &custom.style,
                ),
                StyleKind::Character => word_char_style(
                    &format!("{CUSTOM_CHAR_PREFIX}{}", custom.id),
                    &custom.name,
                    &custom.style,
                ),
            };
            docx = docx.add_style(style);
        }
        // Titres d'onglet : comme le « Titre », en plus gras.
        for level in 1..=tm_model::MAX_TAB_LEVEL {
            let base = sheet.heading(level);
            let style = ParagraphStyle {
                bold: true,
                space_before: 0.0,
                ..base.clone()
            };
            let name = match level {
                1 => "TM Onglet".to_string(),
                n => format!("TM Sous-onglet {}", n - 1),
            };
            let id = format!("{TAB_STYLE_PREFIX}{level}");
            docx = docx.add_style(word_style(&id, &name, &style).outline_lvl(level as usize - 1));
        }
        Self {
            docx,
            // Le numéro 1 est déjà pris par la numérotation par défaut de docx-rs.
            next_numbering: 2,
            content_width_px: (w_mm - m.left - m.right) * 96.0 / 25.4,
            normal: sheet.normal.clone(),
            first: true,
            sheet: sheet.clone(),
        }
    }

    fn block(&mut self, block: &Block, ctx: &Ctx) {
        match block {
            Block::Paragraph { attrs, content } => {
                let custom = attrs.custom_style.as_deref().filter(|id| {
                    self.sheet
                        .custom(id)
                        .is_some_and(|c| c.kind == StyleKind::Paragraph)
                });
                let p = match custom {
                    Some(id) => {
                        let inner = Ctx {
                            heading: true,
                            ..ctx.clone()
                        };
                        self.paragraph(attrs, content, &inner)
                            .style(&format!("{CUSTOM_PARA_PREFIX}{id}"))
                    }
                    None => self.paragraph(attrs, content, ctx),
                };
                self.docx = std::mem::take(&mut self.docx).add_paragraph(p);
            }
            Block::Heading { attrs, content } => {
                let style = match attrs.level {
                    1 => "Title",
                    2 => "Heading1",
                    3 => "Heading2",
                    _ => "Heading3",
                };
                let inner = Ctx {
                    heading: true,
                    ..ctx.clone()
                };
                let p = self.paragraph(&attrs.style, content, &inner).style(style);
                self.docx = std::mem::take(&mut self.docx).add_paragraph(p);
            }
            Block::TabTitle { attrs } => {
                // Chaque onglet commence sur une nouvelle page.
                let style = format!(
                    "{TAB_STYLE_PREFIX}{}",
                    attrs.level.clamp(1, tm_model::MAX_TAB_LEVEL)
                );
                let p = Paragraph::new()
                    .style(&style)
                    .page_break_before(!self.first)
                    .add_run(Run::new().add_text(&attrs.title));
                self.docx = std::mem::take(&mut self.docx).add_paragraph(p);
            }
            Block::Blockquote { content } => {
                let inner = Ctx {
                    quote_level: ctx.quote_level + 1,
                    ..ctx.clone()
                };
                for b in content {
                    self.block(b, &inner);
                }
            }
            Block::BulletList { content } => self.list(content, ctx, false, 1),
            Block::OrderedList { attrs, content } => {
                self.list(content, ctx, true, attrs.start as usize)
            }
            Block::TaskList { content } => {
                for item in content {
                    if let Block::TaskItem { attrs, content } = item {
                        let inner = Ctx {
                            task: Some(if attrs.checked { "☑ " } else { "☐ " }),
                            ..ctx.clone()
                        };
                        self.item(content, &inner, ctx);
                    }
                }
            }
            Block::ListItem { content } | Block::TaskItem { content, .. } => {
                for b in content {
                    self.block(b, ctx);
                }
            }
            Block::CodeBlock { content, .. } => {
                let inner = Ctx {
                    code: true,
                    ..ctx.clone()
                };
                let p = self.paragraph(&BlockStyle::default(), content, &inner);
                self.docx = std::mem::take(&mut self.docx).add_paragraph(p);
            }
            Block::HorizontalRule => {
                let p = Paragraph::new()
                    .align(AlignmentType::Center)
                    .add_run(Run::new().add_text("⁂").color("9AA0A6"));
                self.docx = std::mem::take(&mut self.docx).add_paragraph(p);
            }
            Block::PageBreak => {
                let p = Paragraph::new().add_run(Run::new().add_break(BreakType::Page));
                self.docx = std::mem::take(&mut self.docx).add_paragraph(p);
            }
            Block::Image { attrs } => {
                if let Some(run) = self.image_run(&attrs.src, attrs.width, attrs.height) {
                    let p = Paragraph::new().add_run(run);
                    self.docx = std::mem::take(&mut self.docx).add_paragraph(p);
                }
            }
            Block::Table { content } => {
                let table = self.table(content);
                self.docx = std::mem::take(&mut self.docx).add_table(table);
            }
            Block::TableRow { .. } | Block::TableCell { .. } | Block::TableHeader { .. } => {}
        }
    }

    /// Une liste : chaque liste numérotée a sa propre numérotation (pour
    /// recommencer à son numéro de départ).
    fn list(&mut self, items: &[Block], ctx: &Ctx, ordered: bool, start: usize) {
        let id = self.next_numbering;
        self.next_numbering += 1;
        let mut numbering = AbstractNumbering::new(id);
        for level in 0..9 {
            let (format, text) = if ordered {
                let format = ["decimal", "lowerLetter", "lowerRoman"][level % 3];
                (format, format!("%{}.", level + 1))
            } else {
                ("bullet", ["•", "◦", "▪"][level % 3].to_string())
            };
            let indent = 720 * (level as i32 + 1);
            numbering = numbering.add_level(
                Level::new(
                    level,
                    Start::new(if level == 0 { start } else { 1 }),
                    NumberFormat::new(format),
                    LevelText::new(text),
                    LevelJc::new("left"),
                )
                .indent(
                    Some(indent),
                    Some(SpecialIndentType::Hanging(360)),
                    None,
                    None,
                ),
            );
        }
        self.docx = std::mem::take(&mut self.docx)
            .add_abstract_numbering(numbering)
            .add_numbering(Numbering::new(id, id));

        let depth = ctx.list.map(|(_, d)| d + 1).unwrap_or(0);
        let inner = Ctx {
            list: Some((id, depth)),
            task: None,
            ..ctx.clone()
        };
        for item in items {
            if let Block::ListItem { content } = item {
                self.item(content, &inner, ctx);
            }
        }
    }

    /// Un élément de liste : le premier paragraphe porte la puce (ou la
    /// case), les suivants sont simplement en retrait.
    fn item(&mut self, content: &[Block], first_ctx: &Ctx, outer: &Ctx) {
        for (i, b) in content.iter().enumerate() {
            if i == 0 {
                self.block(b, first_ctx);
            } else {
                let rest = Ctx {
                    list: first_ctx.list.or(outer.list),
                    task: None,
                    ..first_ctx.clone()
                };
                self.block(b, &rest);
            }
        }
    }

    fn paragraph(&mut self, style: &BlockStyle, content: &[Inline], ctx: &Ctx) -> Paragraph {
        let mut p = Paragraph::new();
        if let Some((id, level)) = ctx.list {
            if ctx.task.is_none() {
                p = p.numbering(NumberingId::new(id), IndentLevel::new(level));
            }
        }
        if let Some(align) = style.text_align.as_deref() {
            p = p.align(alignment(align));
        }
        let indent = style.indent.unwrap_or(0) as i32 * INDENT_STEP_TWIPS
            + ctx.quote_level * INDENT_STEP_TWIPS
            + if ctx.task.is_some() {
                ctx.list.map(|(_, d)| d as i32 + 1).unwrap_or(0) * INDENT_STEP_TWIPS
            } else {
                0
            };
        if indent > 0 && ctx.list.is_none() || ctx.task.is_some() && indent > 0 {
            p = p.indent(Some(indent), None, None, None);
        }
        if let Some(lh) = style
            .line_height
            .as_deref()
            .and_then(|v| v.parse::<f64>().ok())
        {
            p = p.line_spacing(
                LineSpacing::new()
                    .line_rule(LineSpacingType::Auto)
                    .line((lh * 240.0).round() as i32),
            );
        }
        if let Some(prefix) = ctx.task {
            p = p.add_run(Run::new().add_text(prefix));
        }
        for inline in content {
            p = match inline {
                Inline::HardBreak => p.add_run(Run::new().add_break(BreakType::TextWrapping)),
                Inline::Text { text, marks } => {
                    let run = self.run(text, marks, ctx);
                    match marks.iter().find_map(|m| match m {
                        Mark::Link { attrs } => Some(attrs.href.clone()),
                        _ => None,
                    }) {
                        Some(href) => p.add_hyperlink(
                            Hyperlink::new(href, HyperlinkType::External).add_run(run),
                        ),
                        None => p.add_run(run),
                    }
                }
            };
        }
        if ctx.quote_level > 0 {
            // Citation : un trait gris à gauche, comme à l'écran.
            p.property = p.property.set_borders(
                ParagraphBorders::with_empty().set(
                    ParagraphBorder::new(ParagraphBorderPosition::Left)
                        .size(18)
                        .space(8)
                        .color(QUOTE_BORDER),
                ),
            );
        }
        p
    }

    fn run(&self, text: &str, marks: &[Mark], ctx: &Ctx) -> Run {
        // Les retours à la ligne d'un bloc de code deviennent des sauts de ligne.
        let mut run = Run::new();
        for (i, line) in text.split('\n').enumerate() {
            if i > 0 {
                run = run.add_break(BreakType::TextWrapping);
            }
            run = run.add_text(line);
        }
        if ctx.code {
            run = run.fonts(fonts("Courier New"));
        }
        if ctx.bold {
            run = run.bold();
        }
        let char_style = marks.iter().find_map(|m| match m {
            Mark::CharStyle { attrs } if self.sheet.custom(&attrs.id).is_some() => {
                Some(attrs.id.as_str())
            }
            _ => None,
        });
        if let Some(id) = char_style {
            run = run.style(&format!("{CUSTOM_CHAR_PREFIX}{id}"));
        }
        if !ctx.heading && !ctx.code && char_style.is_none() {
            if self.normal.bold {
                run = run.bold();
            }
            if self.normal.italic {
                run = run.italic();
            }
            if let Some(c) = hex(self.normal.color.as_deref()) {
                run = run.color(c);
            }
        }
        if ctx.quote_level > 0 {
            run = run.color(QUOTE_TEXT);
        }
        for mark in marks {
            run = match mark {
                Mark::Bold => run.bold(),
                Mark::Italic => run.italic(),
                Mark::Underline => run.underline("single"),
                Mark::Strike => run.strike(),
                Mark::Code => run.fonts(fonts("Courier New")),
                Mark::Link { .. } => run.color("1155CC").underline("single"),
                Mark::CharStyle { .. } => run,
                Mark::Superscript => {
                    run.run_property = run.run_property.vert_align(VertAlignType::SuperScript);
                    run
                }
                Mark::Subscript => {
                    run.run_property = run.run_property.vert_align(VertAlignType::SubScript);
                    run
                }
                Mark::Highlight { attrs } => run.shading(
                    Shading::new()
                        .fill(hex(attrs.color.as_deref()).unwrap_or_else(|| "FFF3A3".into())),
                ),
                Mark::TextStyle { attrs } => {
                    let weight = attrs
                        .font_weight
                        .as_deref()
                        .and_then(|w| w.trim().parse::<u16>().ok());
                    let family = attrs
                        .font_family
                        .as_deref()
                        .map(|f| f.trim_matches(['"', '\'']).to_string());
                    match (family, weight) {
                        (Some(family), None) => run = run.fonts(fonts(&family)),
                        (family, Some(weight)) => {
                            // Sans police choisie : celle du style du texte.
                            let family = family
                                .or_else(|| self.sheet.font_of(&self.normal).map(str::to_string));
                            if let Some(family) = family {
                                let (font, bold) = word_font(&family, weight);
                                run = run.fonts(fonts(&font));
                                if bold {
                                    run = run.bold();
                                }
                            }
                        }
                        (None, None) => {}
                    }
                    if let Some(size) = attrs.font_size.as_deref().and_then(points) {
                        run = run.size((size * 2.0).round() as usize);
                    }
                    if let Some(color) = hex(attrs.color.as_deref()) {
                        run = run.color(color);
                    }
                    if let Some(bg) = hex(attrs.background_color.as_deref()) {
                        run = run.shading(Shading::new().fill(bg));
                    }
                    run
                }
            };
        }
        run
    }

    fn table(&mut self, rows: &[Block]) -> Table {
        let cols = rows
            .iter()
            .map(|r| match r {
                Block::TableRow { content } => content.len(),
                _ => 0,
            })
            .max()
            .unwrap_or(1)
            .max(1);
        let total_twips = (self.content_width_px * 15.0) as usize;
        let rows = rows
            .iter()
            .filter_map(|row| match row {
                Block::TableRow { content } => Some(TableRow::new(
                    content.iter().map(|cell| self.cell(cell)).collect(),
                )),
                _ => None,
            })
            .collect();
        Table::new(rows).set_grid(vec![total_twips / cols; cols])
    }

    fn cell(&mut self, cell: &Block) -> TableCell {
        let (content, header) = match cell {
            Block::TableCell { content, .. } => (content, false),
            Block::TableHeader { content, .. } => (content, true),
            _ => return TableCell::new().add_paragraph(Paragraph::new()),
        };
        let mut tc = TableCell::new();
        if header {
            tc = tc.shading(Shading::new().fill("F1F3F4"));
        }
        let mut any = false;
        for b in content {
            let p = match b {
                Block::Paragraph { attrs, content }
                | Block::Heading {
                    attrs: tm_model::HeadingAttrs { style: attrs, .. },
                    content,
                } => {
                    let ctx = Ctx {
                        bold: header,
                        ..Ctx::default()
                    };
                    self.paragraph(attrs, content, &ctx)
                }
                Block::Image { attrs } => {
                    match self.image_run(&attrs.src, attrs.width, attrs.height) {
                        Some(run) => Paragraph::new().add_run(run),
                        None => continue,
                    }
                }
                other => Paragraph::new().add_run(
                    Run::new().add_text(Document::new(vec![other.clone()]).plain_text().trim_end()),
                ),
            };
            tc = tc.add_paragraph(p);
            any = true;
        }
        if !any {
            tc = tc.add_paragraph(Paragraph::new());
        }
        tc
    }

    /// Une image `data:` (base64). Les autres adresses sont ignorées : pas
    /// de téléchargement, l'application fonctionne hors ligne.
    fn image_run(&self, src: &str, width: Option<f64>, height: Option<f64>) -> Option<Run> {
        let data = src.strip_prefix("data:")?.split_once(";base64,")?.1;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data.trim())
            .ok()?;
        let img = image::load_from_memory(&bytes).ok()?;
        let (w, h) = (img.width() as f64, img.height() as f64);
        let mut png = std::io::Cursor::new(Vec::new());
        img.write_to(&mut png, image::ImageFormat::Png).ok()?;
        // Taille affichée : celle réglée dans l'éditeur, sinon la taille
        // réelle, sans dépasser la largeur de la page.
        let mut dw = width.unwrap_or(w);
        let mut dh = height.unwrap_or(dw * h / w.max(1.0));
        if dw > self.content_width_px {
            dh *= self.content_width_px / dw;
            dw = self.content_width_px;
        }
        let pic = Pic::new_with_dimensions(png.into_inner(), w as u32, h as u32)
            .size((dw * EMU_PER_PX) as u32, (dh * EMU_PER_PX) as u32);
        Some(Run::new().add_image(pic))
    }
}

fn fonts(name: &str) -> RunFonts {
    RunFonts::new()
        .ascii(name)
        .hi_ansi(name)
        .cs(name)
        .east_asia(name)
}

/// `#c0392b` → `C0392B` ; les couleurs CSS nommées ou `rgb()` sont ignorées.
fn hex(color: Option<&str>) -> Option<String> {
    let c = color?.trim().strip_prefix('#')?;
    let c = match c.len() {
        3 => c.chars().flat_map(|ch| [ch, ch]).collect(),
        6 => c.to_string(),
        _ => return None,
    };
    c.chars()
        .all(|ch| ch.is_ascii_hexdigit())
        .then(|| c.to_uppercase())
}

/// `"14pt"` → 14 ; `"16px"` → 12.
fn points(size: &str) -> Option<f64> {
    let size = size.trim();
    if let Some(v) = size.strip_suffix("pt") {
        v.trim().parse().ok()
    } else if let Some(v) = size.strip_suffix("px") {
        v.trim().parse::<f64>().ok().map(|px| px * 0.75)
    } else {
        size.parse().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn document_xml(bytes: &[u8]) -> String {
        let mut zip = zip_reader(bytes);
        let mut xml = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        xml
    }

    fn zip_reader(bytes: &[u8]) -> zip::ZipArchive<std::io::Cursor<&[u8]>> {
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).unwrap()
    }

    #[test]
    fn exporte_un_document_complet() {
        let json = include_str!("../../tm-model/tests/fixtures/tiptap-formatting.json");
        let mut doc = Document::from_json(json).unwrap();
        let tables = include_str!("../../tm-model/tests/fixtures/tiptap-table-image.json");
        doc.content
            .extend(Document::from_json(tables).unwrap().content);
        doc.content.push(Block::PageBreak);
        doc.content.push(Block::heading(2, "Chapitre"));

        let bytes = export(&doc, &PageSetup::default(), &StyleSheet::default()).unwrap();
        let xml = document_xml(&bytes);
        assert!(xml.contains("Bonjour le monde"));
        assert!(xml.contains(r#"<w:rFonts w:ascii="Arial""#));
        assert!(xml.contains(r#"<w:color w:val="2266AA""#));
        assert!(xml.contains(r#"<w:jc w:val="center""#));
        assert!(xml.contains("<w:tbl>"));
        assert!(xml.contains("Ada"));
        assert!(xml.contains(r#"<w:br w:type="page""#));
        assert!(xml.contains(r#"<w:pStyle w:val="Heading1""#));
        assert!(xml.contains("☐ "));
        // Format A4 en vingtièmes de point.
        assert!(xml.contains(r#"<w:pgSz w:w="11906" w:h="16838""#));
    }

    #[test]
    fn exporte_une_image_en_base64() {
        // PNG de 1 × 1 pixel.
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let doc = Document::new(vec![Block::Image {
            attrs: tm_model::ImageAttrs {
                src: format!("data:image/png;base64,{png}"),
                alt: None,
                title: None,
                width: Some(100.0),
                height: None,
            },
        }]);
        let bytes = export(&doc, &PageSetup::default(), &StyleSheet::default()).unwrap();
        let zip = zip_reader(&bytes);
        assert!(zip.file_names().any(|n| n.starts_with("word/media/")));
    }

    #[test]
    fn couleurs_et_tailles() {
        assert_eq!(hex(Some("#abc")), Some("AABBCC".into()));
        assert_eq!(hex(Some("rgb(1,2,3)")), None);
        assert_eq!(points("14pt"), Some(14.0));
        assert_eq!(points("16px"), Some(12.0));
    }
}

#[cfg(test)]
mod import_tests {
    use super::*;

    const PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

    fn sample() -> Document {
        let json = include_str!("../../tm-model/tests/fixtures/tiptap-formatting.json");
        let mut doc = Document::from_json(json).unwrap();
        let tables = include_str!("../../tm-model/tests/fixtures/tiptap-table-image.json");
        let mut more = Document::from_json(tables).unwrap().content;
        // L'image de la capture est tronquée : on met une vraie image.
        more.retain(|b| !matches!(b, Block::Image { .. }));
        doc.content.extend(more);
        doc.content.push(Block::PageBreak);
        doc.content.push(Block::heading(2, "Chapitre"));
        doc.content.push(Block::Image {
            attrs: tm_model::ImageAttrs {
                src: format!("data:image/png;base64,{PNG}"),
                alt: None,
                title: None,
                width: Some(50.0),
                height: Some(50.0),
            },
        });
        doc.content.push(Block::BulletList {
            content: vec![
                Block::ListItem {
                    content: vec![
                        Block::paragraph("puce"),
                        Block::OrderedList {
                            attrs: Default::default(),
                            content: vec![Block::ListItem {
                                content: vec![Block::paragraph("sous")],
                            }],
                        },
                    ],
                },
                Block::ListItem {
                    content: vec![Block::paragraph("puce 2")],
                },
            ],
        });
        doc.content.push(Block::HorizontalRule);
        doc
    }

    #[test]
    fn aller_retour_word() {
        let doc = sample();
        let mut page = PageSetup::default();
        page.size = tm_model::PageSize::Letter;
        page.landscape = true;
        page.margins.left = 30.0;
        page.page_numbers = false;
        let bytes = export(&doc, &page, &StyleSheet::default()).unwrap();
        let (back, back_page, _) = import(&bytes).unwrap();

        assert_eq!(back_page, page);
        assert_eq!(back.plain_text(), doc.plain_text());
        let json = back.to_json().unwrap();
        for needle in [
            r#""fontFamily":"Arial""#,
            r#""fontSize":"18pt""#,
            r##""color":"#2266aa""##,
            r##""type":"highlight","attrs":{"color":"#ffee00"}"##,
            r#""textAlign":"center""#,
            r#""lineHeight":"2""#,
            r#""indent":1"#,
            r#""type":"taskList""#,
            r#""href":"https://exemple.fr""#,
            r#""type":"superscript""#,
            r#""type":"tableHeader""#,
            r#""type":"pageBreak""#,
            r#""type":"heading","attrs":{"level":2}"#,
            r#""type":"image""#,
            r#""type":"bulletList""#,
            r#""type":"orderedList""#,
            r#""type":"horizontalRule""#,
        ] {
            assert!(json.contains(needle), "manque {needle} dans {json}");
        }
        // L'en-tête de tableau n'a pas de gras ajouté, et la sous-liste est dans la puce.
        match back
            .content
            .iter()
            .find(|b| matches!(b, Block::BulletList { .. }))
        {
            Some(Block::BulletList { content }) => {
                assert_eq!(content.len(), 2);
                assert!(matches!(&content[0], Block::ListItem { content } if content.len() == 2));
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn citation_aller_retour() {
        let doc = Document::new(vec![
            Block::paragraph("Avant"),
            Block::Blockquote {
                content: vec![Block::paragraph("Cité un"), Block::paragraph("Cité deux")],
            },
            Block::paragraph("Après"),
        ]);
        let bytes = export(&doc, &PageSetup::default(), &StyleSheet::default()).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes[..])).unwrap();
        let mut xml = String::new();
        std::io::Read::read_to_string(&mut zip.by_name("word/document.xml").unwrap(), &mut xml)
            .unwrap();
        assert!(xml.contains("<w:pBdr><w:left"), "{xml}");
        let (back, _, _) = import(&bytes).unwrap();
        assert_eq!(back, doc);
    }

    #[test]
    fn refuse_un_fichier_qui_n_est_pas_word() {
        assert!(import(b"pas un docx").is_err());
    }

    #[test]
    fn onglets_et_styles_aller_retour() {
        use tm_model::{flatten_tabs, split_tabs, Tab};
        let mut first = Tab::new("Chapitre 1", Document::new(vec![Block::paragraph("Début")]));
        first.children.push(Tab::new(
            "Scène",
            Document::new(vec![Block::heading(2, "Titre 1")]),
        ));
        let tabs = vec![
            first,
            Tab::new("Annexe", Document::new(vec![Block::paragraph("Fin")])),
        ];
        let mut styles = StyleSheet::default();
        styles.heading1.bold = true;
        styles.heading1.color = Some("#1a73e8".into());
        styles.heading1.font_family = Some("Arial".into());
        styles.normal.font_size = 11.0;
        styles.normal.space_after = 8.0;
        let bytes = export(&flatten_tabs(&tabs), &PageSetup::default(), &styles).unwrap();
        let (doc, _, back_styles) = import(&bytes).unwrap();
        assert_eq!(split_tabs(doc), tabs);
        assert_eq!(back_styles, styles);
    }

    #[test]
    fn styles_personnalises_aller_retour() {
        use tm_model::{CharStyleAttrs, CustomStyle};
        let mut styles = StyleSheet::default();
        styles.custom.push(CustomStyle {
            id: "dialogue".into(),
            name: "Dialogue".into(),
            kind: StyleKind::Paragraph,
            style: ParagraphStyle {
                font_family: Some("Avenir Next".into()),
                italic: true,
                space_after: 10.0,
                ..ParagraphStyle::default()
            },
        });
        styles.custom.push(CustomStyle {
            id: "etranger".into(),
            name: "Terme étranger".into(),
            kind: StyleKind::Character,
            style: ParagraphStyle {
                italic: true,
                color: Some("#1a73e8".into()),
                ..ParagraphStyle::default()
            },
        });
        let doc = Document::new(vec![
            Block::Paragraph {
                attrs: BlockStyle {
                    custom_style: Some("dialogue".into()),
                    ..BlockStyle::default()
                },
                content: vec![Inline::text("— Bonjour.")],
            },
            Block::Paragraph {
                attrs: BlockStyle::default(),
                content: vec![
                    Inline::text("Un "),
                    Inline::Text {
                        text: "leitmotiv".into(),
                        marks: vec![Mark::CharStyle {
                            attrs: CharStyleAttrs {
                                id: "etranger".into(),
                            },
                        }],
                    },
                ],
            },
        ]);
        let bytes = export(&doc, &PageSetup::default(), &styles).unwrap();
        let (back, _, back_styles) = import(&bytes).unwrap();
        assert_eq!(back, doc);
        assert_eq!(back_styles.custom, styles.custom);
    }

    #[test]
    fn toutes_les_options_de_style_aller_retour() {
        use tm_model::CustomStyle;
        let mut styles = StyleSheet::default();
        styles.normal.text_align = Some("justify".into());
        styles.normal.first_line_indent = Some(1.0);
        styles.custom.push(CustomStyle {
            id: "exergue".into(),
            name: "Exergue".into(),
            kind: StyleKind::Paragraph,
            style: ParagraphStyle {
                font_family: Some("Lexend".into()),
                font_weight: Some(300),
                text_align: Some("right".into()),
                indent_left: Some(2.0),
                indent_right: Some(1.5),
                first_line_indent: Some(-0.5),
                ..ParagraphStyle::default()
            },
        });
        styles.custom.push(CustomStyle {
            id: "marque".into(),
            name: "Marque".into(),
            kind: StyleKind::Character,
            style: ParagraphStyle {
                font_family: Some("Lexend".into()),
                font_weight: Some(600),
                underline: true,
                strike: true,
                highlight: Some("#fff3a3".into()),
                letter_spacing: Some(1.5),
                text_transform: Some("uppercase".into()),
                vertical_align: Some("super".into()),
                ..ParagraphStyle::default()
            },
        });
        let doc = Document::new(vec![Block::paragraph("Texte")]);
        let bytes = export(&doc, &PageSetup::default(), &styles).unwrap();
        let (_, _, back) = import(&bytes).unwrap();
        assert_eq!(back.custom, styles.custom);
        assert_eq!(back.normal.text_align.as_deref(), Some("justify"));
    }

    #[test]
    fn graisse_en_nom_de_police_word() {
        assert_eq!(word_font("Lexend", 300), ("Lexend Light".into(), false));
        assert_eq!(word_font("Lexend", 700), ("Lexend".into(), true));
        assert_eq!(word_font("Lexend", 400), ("Lexend".into(), false));
        assert_eq!(word_font("Inter", 600), ("Inter SemiBold".into(), false));
    }
}
