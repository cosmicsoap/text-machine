//! Modèle de document de Text Machine.
//!
//! Ce crate ne dépend d'aucune interface graphique. Sa représentation JSON
//! suit volontairement celle de ProseMirror / TipTap (`{"type": "doc",
//! "content": [...]}`) : l'éditeur web peut ainsi envoyer son document tel
//! quel au cœur Rust, et une future vue native pourra réutiliser le même
//! modèle.

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
    CodeBlock {
        #[serde(default)]
        attrs: CodeBlockAttrs,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        content: Vec<Inline>,
    },
    HorizontalRule,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HeadingAttrs {
    pub level: u8,
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
    Link { attrs: LinkAttrs },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LinkAttrs {
    pub href: String,
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
            content: vec![Inline::text(text)],
        }
    }

    /// Un titre de niveau `level` (1 à 6).
    pub fn heading(level: u8, text: impl Into<String>) -> Self {
        Block::Heading {
            attrs: HeadingAttrs { level },
            content: vec![Inline::text(text)],
        }
    }

    fn write_plain_text(&self, out: &mut String) {
        match self {
            Block::Paragraph { content }
            | Block::Heading { content, .. }
            | Block::CodeBlock { content, .. } => {
                for inline in content {
                    match inline {
                        Inline::Text { text, .. } => out.push_str(text),
                        Inline::HardBreak => out.push('\n'),
                    }
                }
                out.push('\n');
            }
            Block::Blockquote { content }
            | Block::BulletList { content }
            | Block::OrderedList { content, .. }
            | Block::ListItem { content } => {
                for block in content {
                    block.write_plain_text(out);
                }
            }
            Block::HorizontalRule => out.push('\n'),
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

    /// Nombre de mots (suites de caractères séparées par des espaces).
    pub fn word_count(&self) -> usize {
        self.plain_text().split_whitespace().count()
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
        // Bonjour / Un mot en gras / un lien / point un / let x = 1;
        assert_eq!(doc.word_count(), 1 + 4 + 2 + 2 + 4);
    }

    #[test]
    fn document_vide() {
        let doc = Document::from_json(r#"{"type":"doc"}"#).unwrap();
        assert_eq!(doc, Document::default());
        assert_eq!(doc.word_count(), 0);
    }
}
