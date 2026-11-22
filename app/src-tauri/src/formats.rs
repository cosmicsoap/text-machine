//! Choix du format d'après l'extension du fichier.
//!
//! - `.docx` : format principal (Word), lu et écrit.
//! - `.md` / `.markdown` : Markdown, lu et écrit (sans couleurs ni polices).
//! - `.txt` : texte brut.
//! - `.tmd` : ancien format de Text Machine, encore lu et écrit (il sert
//!   aussi au brouillon, car il garde tout sans aucune perte).

use std::path::Path;

use tm_io_native::NativeFile;
use tm_model::PageSetup;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Docx,
    Markdown,
    Text,
    Native,
}

impl Format {
    pub fn of(path: &str) -> Format {
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or_default()
            .to_lowercase();
        match ext.as_str() {
            "md" | "markdown" => Format::Markdown,
            "txt" | "text" => Format::Text,
            "tmd" => Format::Native,
            _ => Format::Docx,
        }
    }
}

pub fn read(path: &str) -> Result<NativeFile, String> {
    match Format::of(path) {
        Format::Docx => {
            let (document, page) = tm_io_docx::open(path).map_err(|e| e.to_string())?;
            Ok(NativeFile { document, page })
        }
        Format::Markdown | Format::Text => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(&bytes);
            let document = if Format::of(path) == Format::Markdown {
                tm_io_markdown::import(&text)
            } else {
                tm_io_markdown::import_plain_text(&text)
            };
            Ok(NativeFile {
                document,
                page: PageSetup::default(),
            })
        }
        Format::Native => tm_io_native::open(path).map_err(|e| e.to_string()),
    }
}

pub fn write(path: &str, file: &NativeFile) -> Result<(), String> {
    let bytes = match Format::of(path) {
        Format::Docx => tm_io_docx::export(&file.document, &file.page).map_err(|e| e.to_string())?,
        Format::Markdown => tm_io_markdown::export(&file.document).into_bytes(),
        Format::Text => tm_io_markdown::export_plain_text(&file.document).into_bytes(),
        Format::Native => return tm_io_native::save(path, file).map_err(|e| e.to_string()),
    };
    // Fichier temporaire puis renommage : jamais de fichier à moitié écrit.
    let tmp = format!("{path}.tm-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tm_model::{Block, Document};

    #[test]
    fn choisit_le_format_selon_l_extension() {
        assert_eq!(Format::of("/a/b.DOCX"), Format::Docx);
        assert_eq!(Format::of("notes.md"), Format::Markdown);
        assert_eq!(Format::of("x.txt"), Format::Text);
        assert_eq!(Format::of("ancien.tmd"), Format::Native);
    }

    #[test]
    fn enregistre_et_rouvre_dans_chaque_format() {
        let doc = Document::new(vec![Block::heading(1, "Titre"), Block::paragraph("Texte")]);
        let file = NativeFile::new(doc.clone());
        for ext in ["docx", "md", "txt", "tmd"] {
            let path = std::env::temp_dir()
                .join(format!("tm-format-{}.{ext}", std::process::id()))
                .to_string_lossy()
                .into_owned();
            write(&path, &file).unwrap();
            let back = read(&path).unwrap();
            std::fs::remove_file(&path).ok();
            assert_eq!(back.document.plain_text(), doc.plain_text(), "format {ext}");
        }
    }
}
