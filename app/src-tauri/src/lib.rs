//! Coquille Tauri : relie l'éditeur web au cœur Rust.
//!
//! Les commandes ci-dessous sont appelées depuis `app/src/main.ts` avec
//! `invoke(...)`. Le document circule au format JSON de TipTap, converti en
//! `tm_model::Document` à l'entrée.

mod fonts;
mod formats;
mod pdf;
mod session;

use session::Session;
use tauri::AppHandle;
use tm_io_native::NativeFile;
use tm_model::{Document, PageSetup, StyleSheet, TextStats};

/// Mots et signes d'un document (ou d'une sélection, envoyée comme un
/// petit document).
#[tauri::command]
fn text_stats(doc: Document) -> TextStats {
    doc.stats()
}

#[tauri::command]
fn open_document(app: AppHandle, path: String) -> Result<NativeFile, String> {
    let file = formats::read(&path)?;
    remember(&app, &path);
    Ok(file)
}

#[tauri::command]
fn save_document(app: AppHandle, path: String, file: NativeFile) -> Result<(), String> {
    formats::write(&path, &file)?;
    remember(&app, &path);
    Ok(())
}

fn remember(app: &AppHandle, path: &str) {
    let mut s = session::load(app);
    s.remember(path);
    // Ne pas pouvoir noter un fichier récent n'est pas grave.
    let _ = session::store(app, &s);
}

/// Fichiers récents et dernier fichier ouvert.
#[tauri::command]
fn load_session(app: AppHandle) -> Session {
    session::load(&app)
}

/// Nouveau document : au prochain lancement, on reprendra le brouillon.
#[tauri::command]
fn forget_last_file(app: AppHandle) -> Result<(), String> {
    let mut s = session::load(&app);
    s.last_file = None;
    session::store(&app, &s)
}

/// Enregistre le document sans titre dans le brouillon.
#[tauri::command]
fn save_draft(app: AppHandle, file: NativeFile) -> Result<(), String> {
    tm_io_native::save(session::draft_path(&app)?, &file).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_draft(app: AppHandle) -> Option<NativeFile> {
    session::load_draft(&app)
}

/// Ouvre la fenêtre d'impression du système.
#[tauri::command]
fn print_document(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

/// Exporte une copie (Word, Markdown, texte…) sans changer le fichier ouvert.
#[tauri::command]
fn export_document(path: String, file: NativeFile) -> Result<(), String> {
    formats::write(&path, &file)
}

/// « Enregistrer comme styles par défaut » : les nouveaux documents les
/// prendront.
#[tauri::command]
fn save_default_styles(app: AppHandle, styles: Option<StyleSheet>) -> Result<(), String> {
    let mut s = session::load(&app);
    s.default_styles = styles;
    session::store(&app, &s)
}

/// Enregistre la page affichée en PDF, sans passer par l'impression.
#[tauri::command]
async fn export_pdf(
    window: tauri::WebviewWindow,
    path: String,
    page: PageSetup,
    pages: u32,
) -> Result<(), String> {
    pdf::export(&window, &path, &page, pages).await
}

// --- Polices --------------------------------------------------------------------

/// Familles des polices installées sur l'ordinateur (lues une seule fois).
#[tauri::command]
async fn list_system_fonts() -> Vec<fonts::FontFamily> {
    static CACHE: std::sync::OnceLock<Vec<fonts::FontFamily>> = std::sync::OnceLock::new();
    CACHE.get_or_init(fonts::system_families).clone()
}

#[tauri::command]
fn list_imported_fonts(app: AppHandle) -> Result<Vec<fonts::ImportedFont>, String> {
    Ok(fonts::imported(&fonts::fonts_dir(&app)?))
}

/// Le contenu d'une police importée, pour que l'éditeur la charge.
#[tauri::command]
fn read_imported_font(app: AppHandle, file: String) -> Result<tauri::ipc::Response, String> {
    let path =
        fonts::safe_file(&fonts::fonts_dir(&app)?, &file).ok_or("nom de fichier invalide")?;
    Ok(tauri::ipc::Response::new(
        std::fs::read(path).map_err(|e| e.to_string())?,
    ))
}

#[tauri::command]
fn import_fonts(app: AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    fonts::import(&fonts::fonts_dir(&app)?, &paths)
}

#[tauri::command]
fn remove_imported_font(app: AppHandle, family: String) -> Result<(), String> {
    fonts::remove(&fonts::fonts_dir(&app)?, &family)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            text_stats,
            list_system_fonts,
            list_imported_fonts,
            read_imported_font,
            import_fonts,
            remove_imported_font,
            save_default_styles,
            open_document,
            save_document,
            load_session,
            forget_last_file,
            save_draft,
            load_draft,
            print_document,
            export_document,
            export_pdf
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Text Machine");
}
