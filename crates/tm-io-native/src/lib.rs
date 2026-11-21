//! Format natif de Text Machine (extension provisoire `.tmd`).
//!
//! Version provisoire : un fichier JSON qui enveloppe le document avec un
//! numéro de version. Le choix définitif (SQLite ou ZIP + JSON, avec images,
//! versions et commentaires) est encore ouvert ; il ne changera que ce crate.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tm_model::Document;

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

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    document: Document,
}

/// Convertit un document en contenu de fichier.
pub fn to_string(doc: &Document) -> Result<String, NativeError> {
    let envelope = Envelope {
        format: FORMAT_NAME.into(),
        version: FORMAT_VERSION,
        document: doc.clone(),
    };
    Ok(serde_json::to_string_pretty(&envelope)?)
}

/// Lit un document depuis le contenu d'un fichier.
pub fn from_str(contents: &str) -> Result<Document, NativeError> {
    let envelope: Envelope = serde_json::from_str(contents)?;
    if envelope.format != FORMAT_NAME {
        return Err(NativeError::NotTextMachine);
    }
    if envelope.version > FORMAT_VERSION {
        return Err(NativeError::TooNew(envelope.version));
    }
    Ok(envelope.document)
}

pub fn save(path: impl AsRef<Path>, doc: &Document) -> Result<(), NativeError> {
    std::fs::write(path, to_string(doc)?)?;
    Ok(())
}

pub fn open(path: impl AsRef<Path>) -> Result<Document, NativeError> {
    from_str(&std::fs::read_to_string(path)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tm_model::Block;

    #[test]
    fn enregistrer_puis_ouvrir() {
        let doc = Document::new(vec![Block::heading(1, "Titre"), Block::paragraph("Texte")]);
        let path = std::env::temp_dir().join(format!("tm-test-{}.{EXTENSION}", std::process::id()));
        save(&path, &doc).unwrap();
        let back = open(&path).unwrap();
        std::fs::remove_file(&path).ok();
        assert_eq!(doc, back);
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
