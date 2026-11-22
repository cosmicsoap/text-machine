//! Format natif de Text Machine (extension provisoire `.tmd`).
//!
//! Version provisoire : un fichier JSON qui enveloppe le document avec un
//! numéro de version. Le choix définitif (SQLite ou ZIP + JSON, avec images,
//! versions et commentaires) est encore ouvert ; il ne changera que ce crate.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tm_model::{flatten_tabs, split_tabs, Document, PageSetup, StyleSheet, Tab};

/// Extension de fichier (provisoire).
pub const EXTENSION: &str = "tmd";

/// Version du format écrite par cette version de l'application.
/// Version 2 : onglets et feuille de styles (les fichiers en version 1,
/// avec un seul `document`, s'ouvrent toujours).
pub const FORMAT_VERSION: u32 = 2;

const FORMAT_NAME: &str = "text-machine";

#[derive(Debug, thiserror::Error)]
pub enum NativeError {
    #[error("impossible de lire ou d'écrire le fichier : {0}")]
    Io(#[from] std::io::Error),
    #[error("fichier illisible : {0}")]
    Json(#[from] serde_json::Error),
    #[error("ce fichier n'est pas un document Text Machine")]
    NotTextMachine,
    #[error("ce document vient d'une version plus récente (format {0})")]
    TooNew(u32),
}

/// Ce que contient un fichier `.tmd` : les onglets du document et ses
/// réglages (format des pages, styles de paragraphe).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(from = "RawFile", rename_all = "camelCase")]
pub struct NativeFile {
    /// Toujours au moins un onglet.
    pub tabs: Vec<Tab>,
    pub page: PageSetup,
    pub styles: StyleSheet,
}

/// Lecture tolérante : les anciens fichiers n'ont qu'un `document`, ni
/// styles, ni format de page.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawFile {
    #[serde(default)]
    tabs: Vec<Tab>,
    #[serde(default)]
    document: Option<Document>,
    #[serde(default)]
    page: PageSetup,
    #[serde(default)]
    styles: StyleSheet,
}

impl From<RawFile> for NativeFile {
    fn from(raw: RawFile) -> Self {
        let tabs = if raw.tabs.is_empty() {
            split_tabs(raw.document.unwrap_or_default())
        } else {
            raw.tabs
        };
        Self {
            tabs,
            page: raw.page,
            styles: raw.styles,
        }
    }
}

impl Default for NativeFile {
    fn default() -> Self {
        Self::new(Document::default())
    }
}

impl NativeFile {
    /// Un document d'un seul onglet.
    pub fn new(document: Document) -> Self {
        Self {
            tabs: split_tabs(document),
            page: PageSetup::default(),
            styles: StyleSheet::default(),
        }
    }

    /// Un document lu dans un format sans onglets (Word, Markdown) : il est
    /// découpé aux titres d'onglet qu'il contient.
    pub fn from_flat(document: Document, page: PageSetup, styles: StyleSheet) -> Self {
        Self {
            tabs: split_tabs(document),
            page,
            styles,
        }
    }

    /// Tous les onglets à la suite, pour les formats sans onglets.
    pub fn flattened(&self) -> Document {
        flatten_tabs(&self.tabs)
    }
}

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    #[serde(flatten)]
    file: NativeFile,
}

/// Convertit un document en contenu de fichier.
pub fn to_string(file: &NativeFile) -> Result<String, NativeError> {
    let envelope = Envelope {
        format: FORMAT_NAME.into(),
        version: FORMAT_VERSION,
        file: file.clone(),
    };
    Ok(serde_json::to_string_pretty(&envelope)?)
}

/// Lit un document depuis le contenu d'un fichier.
pub fn from_str(contents: &str) -> Result<NativeFile, NativeError> {
    let envelope: Envelope = serde_json::from_str(contents)?;
    if envelope.format != FORMAT_NAME {
        return Err(NativeError::NotTextMachine);
    }
    if envelope.version > FORMAT_VERSION {
        return Err(NativeError::TooNew(envelope.version));
    }
    Ok(envelope.file)
}

/// Enregistre sans risque de perdre l'ancien fichier : on écrit d'abord un
/// fichier temporaire à côté, puis on le renomme.
pub fn save(path: impl AsRef<Path>, file: &NativeFile) -> Result<(), NativeError> {
    let path = path.as_ref();
    let tmp = path.with_extension("tmd.tmp");
    std::fs::write(&tmp, to_string(file)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn open(path: impl AsRef<Path>) -> Result<NativeFile, NativeError> {
    from_str(&std::fs::read_to_string(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tm_model::Block;

    #[test]
    fn enregistrer_puis_ouvrir() {
        let mut doc = NativeFile::new(Document::new(vec![
            Block::heading(1, "Titre"),
            Block::paragraph("Texte"),
        ]));
        doc.page.landscape = true;
        let path = std::env::temp_dir().join(format!("tm-test-{}.{EXTENSION}", std::process::id()));
        save(&path, &doc).unwrap();
        let back = open(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(doc, back);
    }

    #[test]
    fn ouvre_un_fichier_sans_format_de_page() {
        let file =
            from_str(r#"{"format":"text-machine","version":1,"document":{"type":"doc"}}"#).unwrap();
        assert_eq!(file.page, PageSetup::default());
        assert_eq!(file.tabs.len(), 1);
    }

    #[test]
    fn garde_les_onglets_et_les_styles() {
        let mut file = NativeFile::new(Document::new(vec![Block::paragraph("a")]));
        let mut sub = Tab::new("Sous-onglet", Document::new(vec![Block::paragraph("b")]));
        sub.id = "x".into();
        file.tabs[0].children.push(sub);
        file.styles.heading1.bold = true;
        let back = from_str(&to_string(&file).unwrap()).unwrap();
        assert_eq!(back, file);
    }

    #[test]
    fn refuse_un_autre_format() {
        let err = from_str(r#"{"format":"autre","version":1,"document":{"type":"doc"}}"#);
        assert!(matches!(err, Err(NativeError::NotTextMachine)));
    }

    #[test]
    fn refuse_une_version_future() {
        let err = from_str(r#"{"format":"text-machine","version":99,"document":{"type":"doc"}}"#);
        assert!(matches!(err, Err(NativeError::TooNew(99))));
    }
}
