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
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager};
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

// --- Fichiers ouverts d'un double-clic --------------------------------------
//
// Windows et Linux passent le fichier en argument au lancement ; macOS
// l'envoie par un événement (au lancement comme quand l'app tourne déjà).
// Les chemins attendent ici que l'éditeur les prenne (`take_opened_files`),
// et l'événement « open-files » le prévient quand il en arrive de nouveaux.

#[derive(Default)]
struct OpenedFiles(Mutex<Vec<String>>);

/// Les arguments qui sont des fichiers que Text Machine sait ouvrir.
fn openable_files(args: impl IntoIterator<Item = String>) -> Vec<String> {
    args.into_iter()
        .filter(|a| !a.starts_with('-'))
        .filter(|a| {
            let path = std::path::Path::new(a);
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
            matches!(ext.as_str(), "docx" | "md" | "markdown" | "txt" | "tmd") && path.is_file()
        })
        .collect()
}

fn deliver(app: &AppHandle, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    app.state::<OpenedFiles>().0.lock().unwrap().extend(paths);
    let _ = app.emit("open-files", ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn take_opened_files(opened: tauri::State<OpenedFiles>) -> Vec<String> {
    std::mem::take(&mut *opened.0.lock().unwrap())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let at_launch = openable_files(std::env::args().skip(1));
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        deliver(app, openable_files(args.into_iter().skip(1)));
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.set_focus();
        }
    }));
    builder
        .manage(OpenedFiles(Mutex::new(at_launch)))
        .plugin(tauri_plugin_dialog::init())
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
            export_pdf,
            take_opened_files
        ])
        .build(tauri::generate_context!())
        .expect("erreur au lancement de Text Machine")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = _event {
                let paths = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().into_owned());
                deliver(_app, openable_files(paths));
            }
        });
}
