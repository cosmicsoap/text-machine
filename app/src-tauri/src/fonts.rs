//! Polices : celles installées sur l'ordinateur, et celles que
//! l'utilisateur importe dans Text Machine (fichiers .ttf, .otf, .ttc ou un
//! dossier entier). Les polices importées sont copiées dans le dossier de
//! l'application ; l'éditeur les charge au lancement.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Manager};

const FONT_EXTENSIONS: [&str; 4] = ["ttf", "otf", "ttc", "otc"];
const MAX_DEPTH: usize = 6;

/// Une police importée : un fichier (une graisse, un style).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportedFont {
    /// Nom de la famille (« Inter », « EB Garamond »…).
    pub family: String,
    /// Nom du fichier dans le dossier des polices de l'application.
    pub file: String,
    /// Index dans un fichier qui contient plusieurs polices (.ttc).
    pub index: u32,
    /// Graisse CSS (400 = normal, 700 = gras).
    pub weight: u16,
    /// Graisse maximale d'une police variable (sinon égale à `weight`).
    pub weight_max: u16,
    pub italic: bool,
}

/// Une forme d'une famille : une graisse (ou une plage, pour une police
/// variable) et un style droit ou italique.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct FontFace {
    pub weight: u16,
    pub weight_max: u16,
    pub italic: bool,
}

/// Une famille de polices et ses formes (Light, Regular, Bold, Italique…).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub family: String,
    pub faces: Vec<FontFace>,
}

/// Une police lue dans un fichier.
#[derive(Debug, Clone, PartialEq)]
pub struct Described {
    pub index: u32,
    pub family: String,
    pub face: FontFace,
}

pub fn is_font_file(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| FONT_EXTENSIONS.contains(&e.to_lowercase().as_str()))
}

/// Tous les fichiers de police d'un dossier (et de ses sous-dossiers).
fn font_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < MAX_DEPTH {
                font_files(&path, depth + 1, out);
            }
        } else if is_font_file(&path) {
            out.push(path);
        }
    }
}

/// Les polices contenues dans un fichier (plusieurs pour un .ttc).
pub fn describe(data: &[u8]) -> Vec<Described> {
    let count = ttf_parser::fonts_in_collection(data).unwrap_or(1);
    (0..count)
        .filter_map(|index| {
            let face = ttf_parser::Face::parse(data, index).ok()?;
            let family = family_name(&face)?;
            let mut weight = face.weight().to_number();
            let mut weight_max = weight;
            // Police variable : toute une plage de graisses dans un fichier.
            let wght = ttf_parser::Tag::from_bytes(b"wght");
            if let Some(axis) = face.variation_axes().into_iter().find(|a| a.tag == wght) {
                weight = axis.min_value.round().clamp(1.0, 1000.0) as u16;
                weight_max = axis.max_value.round().clamp(1.0, 1000.0) as u16;
            }
            Some(Described {
                index,
                family,
                face: FontFace {
                    weight,
                    weight_max,
                    italic: face.is_italic(),
                },
            })
        })
        .collect()
}

fn family_name(face: &ttf_parser::Face) -> Option<String> {
    use ttf_parser::name_id::{FAMILY, TYPOGRAPHIC_FAMILY};
    let find = |id: u16| {
        face.names()
            .into_iter()
            .filter(|n| n.name_id == id)
            .find_map(|n| n.to_string())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    find(TYPOGRAPHIC_FAMILY).or_else(|| find(FAMILY))
}

/// Familles des polices installées sur l'ordinateur, avec leurs formes.
pub fn system_families() -> Vec<FontFamily> {
    let mut dirs = vec![
        PathBuf::from("/System/Library/Fonts"),
        PathBuf::from("/Library/Fonts"),
        PathBuf::from("/usr/share/fonts"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(Path::new(&home).join("Library/Fonts"));
        dirs.push(Path::new(&home).join(".local/share/fonts"));
    }
    // Windows : polices de tout l'ordinateur, puis celles installées
    // « pour moi seulement » (Windows 10 et plus récent).
    let windir = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
    dirs.push(Path::new(&windir).join("Fonts"));
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(Path::new(&local).join("Microsoft").join("Windows").join("Fonts"));
    }
    let mut files = Vec::new();
    for dir in dirs {
        font_files(&dir, 0, &mut files);
    }
    let mut families: std::collections::BTreeMap<String, BTreeSet<FontFace>> = Default::default();
    for file in files {
        let Ok(data) = std::fs::read(&file) else {
            continue;
        };
        for d in describe(&data) {
            // Les polices dont le nom commence par un point sont réservées au système.
            if !d.family.starts_with('.') {
                families.entry(d.family).or_default().insert(d.face);
            }
        }
    }
    families
        .into_iter()
        .map(|(family, faces)| FontFamily {
            family,
            faces: faces.into_iter().collect(),
        })
        .collect()
}

pub fn fonts_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("fonts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Les polices importées dans l'application.
pub fn imported(dir: &Path) -> Vec<ImportedFont> {
    let mut files = Vec::new();
    font_files(dir, MAX_DEPTH, &mut files);
    let mut out = Vec::new();
    for path in files {
        let Ok(data) = std::fs::read(&path) else {
            continue;
        };
        let file = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        for d in describe(&data) {
            out.push(ImportedFont {
                family: d.family,
                file: file.clone(),
                index: d.index,
                weight: d.face.weight,
                weight_max: d.face.weight_max,
                italic: d.face.italic,
            });
        }
    }
    out.sort_by(|a, b| (&a.family, a.weight, a.italic).cmp(&(&b.family, b.weight, b.italic)));
    out
}

/// Copie des fichiers de police (ou les polices d'un dossier) dans le
/// dossier de l'application. Renvoie les familles ajoutées.
pub fn import(dir: &Path, paths: &[String]) -> Result<Vec<String>, String> {
    let mut files = Vec::new();
    for p in paths {
        let path = Path::new(p);
        if path.is_dir() {
            font_files(path, 0, &mut files);
        } else if is_font_file(path) {
            files.push(path.to_path_buf());
        }
    }
    if files.is_empty() {
        return Err("Aucune police trouvée (fichiers .ttf, .otf ou .ttc).".into());
    }
    let mut families = BTreeSet::new();
    for path in files {
        let data = std::fs::read(&path).map_err(|e| e.to_string())?;
        let described = describe(&data);
        if described.is_empty() {
            continue; // fichier abîmé ou pas une police
        }
        let name = path.file_name().unwrap_or_default();
        std::fs::write(dir.join(name), &data).map_err(|e| e.to_string())?;
        families.extend(described.into_iter().map(|d| d.family));
    }
    if families.is_empty() {
        return Err("Ces fichiers ne sont pas des polices lisibles.".into());
    }
    Ok(families.into_iter().collect())
}

/// Retire une famille importée (tous ses fichiers).
pub fn remove(dir: &Path, family: &str) -> Result<(), String> {
    let mut files: BTreeSet<String> = BTreeSet::new();
    for font in imported(dir) {
        if font.family == family {
            files.insert(font.file);
        }
    }
    for file in files {
        std::fs::remove_file(dir.join(file)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Un nom de fichier du dossier des polices (jamais un chemin ailleurs).
pub fn safe_file(dir: &Path, file: &str) -> Option<PathBuf> {
    let name = Path::new(file).file_name()?;
    (name == file).then(|| dir.join(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconnait_les_fichiers_de_police() {
        assert!(is_font_file(Path::new("/a/Inter-Bold.TTF")));
        assert!(is_font_file(Path::new("x.otf")));
        assert!(!is_font_file(Path::new("x.txt")));
    }

    #[test]
    fn refuse_les_chemins_hors_du_dossier() {
        let dir = Path::new("/polices");
        assert_eq!(safe_file(dir, "a.ttf"), Some(dir.join("a.ttf")));
        assert_eq!(safe_file(dir, "../secret"), None);
        assert_eq!(safe_file(dir, "/etc/passwd"), None);
    }

    #[test]
    fn lit_le_nom_d_une_police_du_systeme() {
        // Sur une machine sans police, rien à vérifier.
        let mut files = Vec::new();
        font_files(Path::new("/usr/share/fonts"), 0, &mut files);
        font_files(Path::new("/System/Library/Fonts"), 0, &mut files);
        if let Some(file) = files
            .iter()
            .find(|f| f.extension().is_some_and(|e| e == "ttf"))
        {
            let data = std::fs::read(file).unwrap();
            assert!(!describe(&data).is_empty(), "{file:?}");
        }
    }

    #[test]
    fn importe_un_dossier_et_retire_une_famille() {
        let mut files = Vec::new();
        font_files(Path::new("/usr/share/fonts"), 0, &mut files);
        font_files(Path::new("/System/Library/Fonts"), 0, &mut files);
        let Some(src) = files
            .iter()
            .find(|f| f.extension().is_some_and(|e| e == "ttf"))
        else {
            return;
        };
        let base = std::env::temp_dir().join(format!("tm-fonts-{}", std::process::id()));
        let (from, to) = (base.join("source/sous-dossier"), base.join("app"));
        std::fs::create_dir_all(&from).unwrap();
        std::fs::create_dir_all(&to).unwrap();
        std::fs::copy(src, from.join("police.ttf")).unwrap();
        let families = import(&to, &[base.join("source").to_string_lossy().into_owned()]).unwrap();
        assert_eq!(imported(&to).len(), 1);
        remove(&to, &families[0]).unwrap();
        assert!(imported(&to).is_empty());
        std::fs::remove_dir_all(&base).ok();
    }
}
