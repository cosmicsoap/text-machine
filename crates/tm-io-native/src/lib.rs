//! Format natif de Text Machine (extension provisoire `.tmd`).
//!
//! Version provisoire : un fichier JSON qui enveloppe le document avec un
//! numéro de version. Le choix définitif (SQLite ou ZIP + JSON, avec images,
//! versions et commentaires) est encore ouvert ; il ne changera que ce crate.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tm_model::{Document, PageSetup};

/// Extension de fichier (provisoire).
pub const EXTENSION: &str = "tmd";

/// Version du format écrite par cette version de l'application.
pub const FORMAT_VERSION: u32 = 1;

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

/// Ce que contient un fichier `.tmd` : le document et ses réglages.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct NativeFile {
    pub document: Document,
    /// Format des pages (absent des fichiers plus anciens : valeur par défaut).
    #[serde(default)]
    pub page: PageSetup,
}

impl NativeFile {
    pub fn new(document: Document) -> Self {
        Self {
            document,
            page: PageSetup::default(),
        }
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
        let file = from_str(r#"{"format":"text-machine","version":1,"document":{"type":"doc"}}"#)
            .unwrap();
        assert_eq!(file.page, PageSetup::default());
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
