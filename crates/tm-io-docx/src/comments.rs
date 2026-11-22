//! Commentaires dans la marge : de vrais commentaires Word.
//!
//! Dans Text Machine, chaque morceau du texte commenté porte la discussion
//! entière (marque [`Mark::Comment`]). Dans Word, une discussion est un
//! commentaire (`<w:comment>`) entre `<w:commentRangeStart>` et
//! `<w:commentRangeEnd>`, et chaque réponse est un autre commentaire sur la
//! même plage, relié au premier dans `commentsExtended.xml` (Word 2013 et
//! plus). Une discussion résolue y est marquée `w15:done="1"`.

use std::collections::{HashMap, HashSet};

use docx_rs::{BreakType, Comment, Paragraph, Run};
use tm_model::{Block, CommentAttrs, Document, Inline, Mark};

use crate::DocxError;

#[derive(Default)]
pub(crate) struct CommentWriter {
    /// Morceaux de texte restant à écrire pour chaque discussion : la plage
    /// se ferme après le dernier.
    remaining: HashMap<String, usize>,
    /// Discussion ouverte → numéros Word (commentaire puis réponses).
    open: HashMap<String, Vec<usize>>,
    next_id: usize,
    /// Identifiants des paragraphes des discussions résolues.
    resolved: Vec<String>,
}

fn comment_marks(marks: &[Mark]) -> impl Iterator<Item = &CommentAttrs> {
    marks.iter().filter_map(|m| match m {
        Mark::Comment { attrs } if !attrs.id.is_empty() => Some(attrs),
        _ => None,
    })
}

/// Identifiant de paragraphe Word (8 chiffres hexadécimaux, moins de 0x80000000).
fn para_id(n: usize) -> String {
    format!("{:08X}", 0x1C00_0000 + n)
}

fn text_paragraph(text: &str, n: usize) -> Paragraph {
    let mut run = Run::new();
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            run = run.add_break(BreakType::TextWrapping);
        }
        run = run.add_text(line);
    }
    Paragraph::new().id(para_id(n)).add_run(run)
}

fn date_or_default(date: &str) -> &str {
    if date.is_empty() {
        "2026-01-01T00:00:00Z"
    } else {
        date
    }
}

fn author_or_default(author: &str) -> &str {
    if author.is_empty() {
        "Text Machine"
    } else {
        author
    }
}

impl CommentWriter {
    /// Compte les morceaux de texte commentés, de la même façon que
    /// l'export les parcourt (dans les tableaux, seuls les paragraphes et
    /// titres gardent leur mise en forme).
    pub(crate) fn new(doc: &Document) -> Self {
        fn inlines(content: &[Inline], counts: &mut HashMap<String, usize>) {
            for inline in content {
                if let Inline::Text { marks, .. } = inline {
                    for c in comment_marks(marks) {
                        *counts.entry(c.id.clone()).or_default() += 1;
                    }
                }
            }
        }
        fn blocks(content: &[Block], counts: &mut HashMap<String, usize>) {
            for block in content {
                match block {
                    Block::Paragraph { content, .. }
                    | Block::Heading { content, .. }
                    | Block::CodeBlock { content, .. } => inlines(content, counts),
                    Block::TableCell { content, .. } | Block::TableHeader { content, .. } => {
                        for b in content {
                            match b {
                                Block::Paragraph { content, .. }
                                | Block::Heading { content, .. } => inlines(content, counts),
                                _ => {}
                            }
                        }
                    }
                    Block::Blockquote { content }
                    | Block::BulletList { content }
                    | Block::OrderedList { content, .. }
                    | Block::ListItem { content }
                    | Block::TaskList { content }
                    | Block::TaskItem { content, .. }
                    | Block::Table { content }
                    | Block::TableRow { content } => blocks(content, counts),
                    _ => {}
                }
            }
        }
        let mut remaining = HashMap::new();
        blocks(&doc.content, &mut remaining);
        Self {
            remaining,
            next_id: 1,
            ..Self::default()
        }
    }

    /// Ouvre la plage des discussions qui commencent avec ce texte.
    pub(crate) fn start(&mut self, mut p: Paragraph, marks: &[Mark]) -> Paragraph {
        for c in comment_marks(marks) {
            if self.open.contains_key(&c.id) || !self.remaining.contains_key(&c.id) {
                continue;
            }
            let main = self.next_id;
            let mut ids = vec![main];
            let comment = Comment::new(main)
                .author(author_or_default(&c.author))
                .date(date_or_default(&c.date))
                .add_paragraph(text_paragraph(&c.text, main));
            p = p.add_comment_start(comment);
            for reply in &c.replies {
                let n = main + ids.len();
                let comment = Comment::new(n)
                    .author(author_or_default(&reply.author))
                    .date(date_or_default(&reply.date))
                    .add_paragraph(text_paragraph(&reply.text, n))
                    .parent_comment_id(main);
                p = p.add_comment_start(comment);
                ids.push(n);
            }
            if c.resolved {
                self.resolved.extend(ids.iter().map(|&n| para_id(n)));
            }
            self.next_id += ids.len();
            self.open.insert(c.id.clone(), ids);
        }
        p
    }

    /// Ferme la plage des discussions dont c'était le dernier morceau.
    pub(crate) fn end(&mut self, mut p: Paragraph, marks: &[Mark]) -> Paragraph {
        for c in comment_marks(marks) {
            let Some(left) = self.remaining.get_mut(&c.id) else {
                continue;
            };
            *left = left.saturating_sub(1);
            if *left > 0 {
                continue;
            }
            self.remaining.remove(&c.id);
            if let Some(ids) = self.open.remove(&c.id) {
                for n in ids {
                    p = p.add_comment_end(n);
                }
            }
        }
        p
    }

    pub(crate) fn resolved_paragraphs(&self) -> HashSet<String> {
        self.resolved.iter().cloned().collect()
    }
}

/// Marque les discussions résolues (`w15:done="1"`) dans `commentsExtended.xml`.
pub(crate) fn mark_resolved(
    bytes: &[u8],
    paragraphs: &HashSet<String>,
) -> Result<Vec<u8>, DocxError> {
    let mut parts = crate::notes::read_parts(bytes)?;
    let Some((_, xml)) = parts
        .iter_mut()
        .find(|(n, _)| n == "word/commentsExtended.xml")
    else {
        return Ok(bytes.to_vec());
    };
    let text = String::from_utf8_lossy(xml).into_owned();
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(i) = rest.find("<w15:commentEx ") {
        let Some(len) = rest[i..].find('>') else {
            break;
        };
        let tag = &rest[i..i + len + 1];
        out.push_str(&rest[..i]);
        let resolved =
            crate::notes::attr(tag, "w15:paraId").is_some_and(|id| paragraphs.contains(id));
        if resolved {
            out.push_str(&tag.replace("w15:done=\"0\"", "w15:done=\"1\""));
        } else {
            out.push_str(tag);
        }
        rest = &rest[i + len + 1..];
    }
    out.push_str(rest);
    *xml = out.into_bytes();
    crate::notes::write_parts(&parts)
}
