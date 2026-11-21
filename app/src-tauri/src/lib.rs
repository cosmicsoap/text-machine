//! Coquille Tauri : relie l'éditeur web au cœur Rust.
//!
//! Les commandes ci-dessous sont appelées depuis `app/src/main.ts` avec
//! `invoke(...)`. Le document circule au format JSON de TipTap, converti en
//! `tm_model::Document` à l'entrée.

use tm_model::Document;

#[tauri::command]
fn word_count(doc: Document) -> usize {
    doc.word_count()
}

#[tauri::command]
fn open_document(path: String) -> Result<Document, String> {
    tm_io_native::open(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_document(path: String, doc: Document) -> Result<(), String> {
    tm_io_native::save(&path, &doc).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            word_count,
            open_document,
            save_document
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de Text Machine");
}
