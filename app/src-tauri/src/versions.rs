//! Versions enregistrées d'un document (Fichier > Versions), pour comparer
//! l'original et le texte en cours côte à côte.
//!
//! Elles sont rangées dans le dossier de l'application, un fichier JSON par
//! document (repéré par son chemin) : le fichier Word ou Markdown lui-même
//! n'est pas modifié. Le document sans titre a ses versions sous la clé
//! « brouillon », reprises quand il est enregistré.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Au-delà, les plus anciennes sont oubliées.
const MAX_VERSIONS: usize = 100;
const DRAFT_KEY: &str = "brouillon";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub id: String,
    pub name: String,
    /// Date ISO 8601 (donnée par l'éditeur).
    pub date: String,
    /// Les onglets, au format de l'éditeur.
    pub tabs: Value,
}

/// Ce que montre la liste des versions (sans le contenu).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: String,
    pub name: String,
    pub date: String,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    path: String,
    #[serde(default)]
    versions: Vec<Version>,
}

/// FNV-1a : un nom de fichier stable pour un chemin.
fn hash(text: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in text.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

fn key(path: Option<&str>) -> String {
    match path {
        Some(p) if !p.is_empty() => std::fs::canonicalize(p)
            .map(|c| c.to_string_lossy().into_owned())
            .unwrap_or_else(|_| p.to_string()),
        _ => DRAFT_KEY.to_string(),
    }
}

fn store_file(dir: &Path, key: &str) -> PathBuf {
    dir.join(format!("{}.json", hash(key)))
}

fn load(dir: &Path, key: &str) -> Store {
    std::fs::read_to_string(store_file(dir, key))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Store {
            path: key.to_string(),
            versions: Vec::new(),
        })
}

fn save(dir: &Path, key: &str, store: &Store) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let file = store_file(dir, key);
    if store.versions.is_empty() {
        let _ = std::fs::remove_file(file);
        return Ok(());
    }
    let json = serde_json::to_string(store).map_err(|e| e.to_string())?;
    let tmp = file.with_extension("tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, file).map_err(|e| e.to_string())
}

fn info(v: &Version) -> VersionInfo {
    VersionInfo {
        id: v.id.clone(),
        name: v.name.clone(),
        date: v.date.clone(),
    }
}

pub fn list(dir: &Path, path: Option<&str>) -> Vec<VersionInfo> {
    let mut out: Vec<VersionInfo> = load(dir, &key(path)).versions.iter().map(info).collect();
    out.reverse(); // la plus récente d'abord
    out
}

pub fn read(dir: &Path, path: Option<&str>, id: &str) -> Result<Value, String> {
    load(dir, &key(path))
        .versions
        .into_iter()
        .find(|v| v.id == id)
        .map(|v| v.tabs)
        .ok_or_else(|| "Cette version n'existe plus.".to_string())
}

pub fn add(
    dir: &Path,
    path: Option<&str>,
    name: String,
    date: String,
    tabs: Value,
) -> Result<VersionInfo, String> {
    let k = key(path);
    let mut store = load(dir, &k);
    let id = format!(
        "v{}-{}",
        store.versions.len() + 1,
        &hash(&format!("{date}{name}"))[..6]
    );
    let version = Version {
        id,
        name,
        date,
        tabs,
    };
    let out = info(&version);
    store.versions.push(version);
    let extra = store.versions.len().saturating_sub(MAX_VERSIONS);
    store.versions.drain(..extra);
    save(dir, &k, &store)?;
    Ok(out)
}

pub fn remove(dir: &Path, path: Option<&str>, id: &str) -> Result<(), String> {
    let k = key(path);
    let mut store = load(dir, &k);
    store.versions.retain(|v| v.id != id);
    save(dir, &k, &store)
}

/// Nouveau document : les versions du brouillon précédent sont oubliées
/// (sinon le nouveau texte serait comparé à un tout autre document).
pub fn clear(dir: &Path, path: Option<&str>) -> Result<(), String> {
    save(dir, &key(path), &Store::default())
}

/// « Enregistrer sous » : les versions suivent le document.
pub fn copy(dir: &Path, from: Option<&str>, to: &str) -> Result<(), String> {
    let (kf, kt) = (key(from), key(Some(to)));
    if kf == kt {
        return Ok(());
    }
    let source = load(dir, &kf);
    if source.versions.is_empty() {
        return Ok(());
    }
    let mut target = load(dir, &kt);
    for v in source.versions {
        if !target.versions.iter().any(|t| t.id == v.id) {
            target.versions.push(v);
        }
    }
    target.path = kt.clone();
    save(dir, &kt, &target)?;
    // Le brouillon devient ce fichier : ses versions n'ont plus lieu d'être.
    if kf == DRAFT_KEY {
        save(dir, &kf, &Store::default())?;
    }
    Ok(())
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("versions"))
}

#[tauri::command]
pub fn list_versions(app: AppHandle, path: Option<String>) -> Result<Vec<VersionInfo>, String> {
    Ok(list(&dir(&app)?, path.as_deref()))
}

#[tauri::command]
pub fn clear_versions(app: AppHandle, path: Option<String>) -> Result<(), String> {
    clear(&dir(&app)?, path.as_deref())
}

#[tauri::command]
pub fn read_version(app: AppHandle, path: Option<String>, id: String) -> Result<Value, String> {
    read(&dir(&app)?, path.as_deref(), &id)
}

#[tauri::command]
pub fn save_version(
    app: AppHandle,
    path: Option<String>,
    name: String,
    date: String,
    tabs: Value,
) -> Result<VersionInfo, String> {
    add(&dir(&app)?, path.as_deref(), name, date, tabs)
}

#[tauri::command]
pub fn delete_version(app: AppHandle, path: Option<String>, id: String) -> Result<(), String> {
    remove(&dir(&app)?, path.as_deref(), &id)
}

#[tauri::command]
pub fn copy_versions(app: AppHandle, from: Option<String>, to: String) -> Result<(), String> {
    copy(&dir(&app)?, from.as_deref(), &to)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enregistre_relit_et_suit_le_document() {
        let tmp = std::env::temp_dir().join(format!("tm-versions-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let tabs = serde_json::json!([{ "title": "Onglet 1", "document": { "type": "doc" } }]);
        let v1 = add(
            &tmp,
            None,
            "Original".into(),
            "2026-11-22T10:00:00Z".into(),
            tabs.clone(),
        )
        .unwrap();
        add(
            &tmp,
            None,
            "Relu".into(),
            "2026-11-22T11:00:00Z".into(),
            tabs.clone(),
        )
        .unwrap();
        let names: Vec<_> = list(&tmp, None).into_iter().map(|v| v.name).collect();
        assert_eq!(names, ["Relu", "Original"]);
        assert_eq!(read(&tmp, None, &v1.id).unwrap(), tabs);

        // Le brouillon est enregistré : ses versions passent au fichier.
        let file = tmp.join("lettre.docx").to_string_lossy().into_owned();
        copy(&tmp, None, &file).unwrap();
        assert!(list(&tmp, None).is_empty());
        assert_eq!(list(&tmp, Some(&file)).len(), 2);
        remove(&tmp, Some(&file), &v1.id).unwrap();
        assert_eq!(list(&tmp, Some(&file)).len(), 1);

        // Nouveau document : les versions de l'ancien brouillon sont oubliées.
        add(
            &tmp,
            None,
            "Autre".into(),
            "2026-11-22T12:00:00Z".into(),
            tabs,
        )
        .unwrap();
        clear(&tmp, None).unwrap();
        assert!(list(&tmp, None).is_empty());
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
