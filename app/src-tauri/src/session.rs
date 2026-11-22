//! Ce dont l'application se souvient d'une fois sur l'autre : fichiers
//! récents, dernier fichier ouvert, et brouillon du document sans titre.
//!
//! Tout est rangé dans le dossier de configuration de l'application
//! (sur Mac : ~/Library/Application Support/<identifiant>/).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tm_io_native::NativeFile;

const MAX_RECENT: usize = 10;
const SESSION_FILE: &str = "session.json";
const DRAFT_FILE: &str = "brouillon.tmd";

#[derive(Debug, Default, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    /// Fichiers récents, le plus récent en premier.
    pub recent: Vec<String>,
    /// Fichier ouvert à la fermeture (aucun : on reprend le brouillon).
    pub last_file: Option<String>,
    /// Styles de paragraphe choisis pour les nouveaux documents.
    pub default_styles: Option<tm_model::StyleSheet>,
}

impl Session {
    /// Note qu'un fichier vient d'être ouvert ou enregistré.
    pub fn remember(&mut self, path: &str) {
        self.recent.retain(|p| p != path);
        self.recent.insert(0, path.to_string());
        self.recent.truncate(MAX_RECENT);
        self.last_file = Some(path.to_string());
    }

    /// Retire les fichiers qui n'existent plus.
    pub fn prune(&mut self) {
        self.recent.retain(|p| Path::new(p).exists());
        if self
            .last_file
            .as_deref()
            .is_some_and(|p| !Path::new(p).exists())
        {
            self.last_file = None;
        }
    }
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

pub fn load(app: &AppHandle) -> Session {
    let mut session: Session = dir(app)
        .ok()
        .and_then(|d| std::fs::read_to_string(d.join(SESSION_FILE)).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    session.prune();
    session
}

pub fn store(app: &AppHandle, session: &Session) -> Result<(), String> {
    let json = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
    std::fs::write(dir(app)?.join(SESSION_FILE), json).map_err(|e| e.to_string())
}

pub fn draft_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(dir(app)?.join(DRAFT_FILE))
}

pub fn load_draft(app: &AppHandle) -> Option<NativeFile> {
    tm_io_native::open(draft_path(app).ok()?).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fichiers_recents_sans_doublon_et_limites() {
        let mut s = Session::default();
        for i in 0..12 {
            s.remember(&format!("/tmp/{i}.tmd"));
        }
        s.remember("/tmp/5.tmd");
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(s.recent[0], "/tmp/5.tmd");
        assert_eq!(s.recent.iter().filter(|p| *p == "/tmp/5.tmd").count(), 1);
        assert_eq!(s.last_file.as_deref(), Some("/tmp/5.tmd"));
    }
}
