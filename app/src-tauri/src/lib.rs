//! Coquille Tauri : relie l'éditeur web au cœur Rust.
//!
//! Les commandes ci-dessous sont appelées depuis `app/src/main.ts` avec
//! `invoke(...)`. Le document circule au format JSON de TipTap, converti en
//! `tm_model::Document` à l'entrée.

mod session;

use session::Session;
use tauri::AppHandle;
use tm_io_native::NativeFile;
use tm_model::{Document, PageSetup};

#[tauri::command]
fn word_count(doc: Document) -> usize {
    doc.word_count()
}

#[tauri::command]
fn open_document(app: AppHandle, path: String) -> Result<NativeFile, String> {
    let file = tm_io_native::open(&path).map_err(|e| e.to_string())?;
    remember(&app, &path);
    Ok(file)
}

#[tauri::command]
fn save_document(app: AppHandle, path: String, doc: Document, page: PageSetup) -> Result<(), String> {
    let file = NativeFile {
        document: doc,
        page,
    };
    tm_io_native::save(&path, &file).map_err(|e| e.to_string())?;
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
fn save_draft(app: AppHandle, doc: Document, page: PageSetup) -> Result<(), String> {
    let file = NativeFile {
        document: doc,
        page,
    };
    tm_io_native::save(session::draft_path(&app)?, &file).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_draft(app: AppHandle) -> Option<NativeFile> {
    session::load_draft(&app)
}

/// Ouvre la fenêtre d'impression du système (sur Mac, elle permet aussi
/// d'enregistrer en PDF).
#[tauri::command]
fn print_document(webview: tauri::Webview) -> Result<(), String> {
    webview.print().map_err(|e| e.to_string())
}

/// Exporte en Markdown (`.md`) ou en texte brut (tout autre extension).
#[tauri::command]
fn export_document(path: String, doc: Document) -> Result<(), String> {
    let contents = if is_markdown(&path) {
        tm_io_markdown::export(&doc)
    } else {
        tm_io_markdown::export_plain_text(&doc)
    };
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}

/// Importe un fichier Markdown ou texte brut.
#[tauri::command]
fn import_document(path: String) -> Result<Document, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(if is_markdown(&path) {
        tm_io_markdown::import(&text)
    } else {
        tm_io_markdown::import_plain_text(&text)
    })
}

fn is_markdown(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".md") || lower.ends_with(".markdown")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            word_count,
            open_document,
            save_document,
            load_session,
            forget_last_file,
            save_draft,
            load_draft,
            print_document,
            export_document,
            import_document
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Text Machine");
}
