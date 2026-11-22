//! Choix du format d'après l'extension du fichier.
//!
//! Word, Markdown et texte ne connaissent pas les onglets : ils y sont mis
//! à la suite, chacun précédé de son titre (style Word « TM Onglet »,
//! commentaire Markdown), et redécoupés à l'ouverture.
//!
//! - `.docx` : format principal (Word), lu et écrit.
//! - `.md` / `.markdown` : Markdown, lu et écrit (sans couleurs ni polices).
//!   Les images sont enregistrées à côté, dans un dossier
//!   « <nom>_images », comme le font les autres éditeurs Markdown.
//! - `.txt` : texte brut.
//! - `.tmd` : ancien format de Text Machine, encore lu et écrit (il sert
//!   aussi au brouillon, car il garde tout sans aucune perte).

use std::path::{Path, PathBuf};

use base64::Engine;

use tm_io_native::NativeFile;
use tm_model::{PageSetup, StyleSheet};

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
            let (document, page, styles) = tm_io_docx::open(path).map_err(|e| e.to_string())?;
            Ok(NativeFile::from_flat(document, page, styles))
        }
        Format::Markdown | Format::Text => {
            let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
            let text = String::from_utf8_lossy(&bytes);
            let document = if Format::of(path) == Format::Markdown {
                let mut doc = tm_io_markdown::import(&text);
                load_images(path, &mut doc);
                doc
            } else {
                tm_io_markdown::import_plain_text(&text)
            };
            Ok(NativeFile::from_flat(
                document,
                PageSetup::default(),
                StyleSheet::default(),
            ))
        }
        Format::Native => tm_io_native::open(path).map_err(|e| e.to_string()),
    }
}

pub fn write(path: &str, file: &NativeFile) -> Result<(), String> {
    let bytes = match Format::of(path) {
        Format::Docx => tm_io_docx::export(&file.flattened(), &file.page, &file.styles)
            .map_err(|e| e.to_string())?,
        Format::Markdown => {
            let mut doc = file.flattened();
            save_images(path, &mut doc)?;
            tm_io_markdown::export(&doc).into_bytes()
        }
        Format::Text => tm_io_markdown::export_plain_text(&file.flattened()).into_bytes(),
        Format::Native => return tm_io_native::save(path, file).map_err(|e| e.to_string()),
    };
    // Fichier temporaire puis renommage : jamais de fichier à moitié écrit.
    let tmp = format!("{path}.tm-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

// --- Images d'un fichier Markdown --------------------------------------------

const BASE64: base64::engine::GeneralPurpose = base64::engine::general_purpose::STANDARD;

/// Dossier des images d'un fichier Markdown : « notes.md » → « notes_images ».
fn images_dir(md_path: &str) -> (PathBuf, String) {
    let path = Path::new(md_path);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let name = format!("{stem}_images");
    (path.with_file_name(&name), name)
}

/// Les images du document (gardées en `data:` dans l'éditeur) sont écrites
/// en fichiers à côté du Markdown, qui les cite par un chemin relatif.
fn save_images(md_path: &str, doc: &mut tm_model::Document) -> Result<(), String> {
    let (dir, dir_name) = images_dir(md_path);
    let mut count = 0;
    let mut error = None;
    doc.for_each_image_mut(|image| {
        let Some((mime, data)) = image
            .src
            .strip_prefix("data:")
            .and_then(|rest| rest.split_once(";base64,"))
        else {
            return;
        };
        let Ok(bytes) = BASE64.decode(data.trim()) else {
            return;
        };
        count += 1;
        let ext = match mime {
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            _ => "png",
        };
        let file = format!("image{count}.{ext}");
        let written =
            std::fs::create_dir_all(&dir).and_then(|_| std::fs::write(dir.join(&file), bytes));
        match written {
            Ok(()) => image.src = format!("{}/{file}", dir_name.replace(' ', "%20")),
            Err(e) => error = Some(e.to_string()),
        }
    });
    error.map_or(Ok(()), Err)
}

/// À l'ouverture, les images citées par un chemin relatif sont relues et
/// remises dans le document.
fn load_images(md_path: &str, doc: &mut tm_model::Document) {
    let base = Path::new(md_path).parent().unwrap_or(Path::new("."));
    doc.for_each_image_mut(|image| {
        let src = image.src.replace("%20", " ");
        if src.contains(':') || src.starts_with('/') {
            return; // adresse web, data: ou chemin absolu : on la laisse.
        }
        let file = base.join(&src);
        let Ok(bytes) = std::fs::read(&file) else {
            return;
        };
        let ext = file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let mime = match ext.as_str() {
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            "svg" => "image/svg+xml",
            _ => "image/png",
        };
        image.src = format!("data:{mime};base64,{}", BASE64.encode(bytes));
    });
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
            assert_eq!(
                back.flattened().plain_text(),
                doc.plain_text(),
                "format {ext}"
            );
        }
    }

    #[test]
    fn onglets_dans_chaque_format() {
        use tm_model::Tab;
        let mut first = Tab::new("Un", Document::new(vec![Block::paragraph("a")]));
        first
            .children
            .push(Tab::new("Deux", Document::new(vec![Block::paragraph("b")])));
        let file = NativeFile {
            tabs: vec![
                first,
                Tab::new("Trois", Document::new(vec![Block::paragraph("c")])),
            ],
            page: PageSetup::default(),
            styles: StyleSheet::default(),
        };
        for ext in ["docx", "md", "tmd"] {
            let path = std::env::temp_dir()
                .join(format!("tm-onglets-{}.{ext}", std::process::id()))
                .to_string_lossy()
                .into_owned();
            write(&path, &file).unwrap();
            let back = read(&path).unwrap();
            std::fs::remove_file(&path).ok();
            assert_eq!(back.tabs, file.tabs, "format {ext}");
        }
    }

    #[test]
    fn markdown_range_les_images_a_cote() {
        use tm_model::ImageAttrs;
        let src = "data:image/png;base64,iVBORw0KGgo=".to_string();
        let doc = Document::new(vec![Block::Image {
            attrs: ImageAttrs {
                src: src.clone(),
                alt: Some("logo".into()),
                title: None,
                width: None,
                height: None,
            },
        }]);
        let dir = std::env::temp_dir().join(format!("tm-md-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("Mon doc.md").to_string_lossy().into_owned();
        write(&path, &NativeFile::new(doc.clone())).unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert_eq!(text, "![logo](Mon%20doc_images/image1.png)\n");
        assert!(dir.join("Mon doc_images/image1.png").exists());
        let back = read(&path).unwrap();
        std::fs::remove_dir_all(&dir).ok();
        assert_eq!(back.flattened(), doc);
    }
}
