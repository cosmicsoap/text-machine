//! Export PDF direct : la page affichée (feuilles, marges, numéros) est
//! écrite dans un fichier PDF, sans fenêtre d'impression.
//!
//! Sur Mac, on utilise le moteur d'impression de WebKit avec la consigne
//! « enregistrer dans un fichier » (NSPrintSaveJob) : le PDF est identique
//! à ce qu'on voit à l'écran, avec du vrai texte (sélectionnable).

use tm_model::PageSetup;

/// Points typographiques par millimètre (le PDF compte en points).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const POINTS_PER_MM: f64 = 72.0 / 25.4;

#[cfg(target_os = "macos")]
pub fn export(window: &tauri::WebviewWindow, path: &str, page: &PageSetup) -> Result<(), String> {
    use objc2::rc::Retained;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSPrintInfo, NSPrintJobSavingURL, NSPrintSaveJob, NSPrintingPaginationMode, NSWindow,
    };
    use objc2_foundation::{NSSize, NSString, NSURL};
    use objc2_web_kit::WKWebView;

    let (w_mm, h_mm) = page.dimensions_mm();
    let size = NSSize::new(w_mm * POINTS_PER_MM, h_mm * POINTS_PER_MM);
    let path = path.to_string();

    window
        .with_webview(move |webview| unsafe {
            let wk: &WKWebView = &*(webview.inner() as *const WKWebView);
            let ns_window: &NSWindow = &*(webview.ns_window() as *const NSWindow);

            // Une copie des réglages, pour ne pas toucher à ceux de l'impression.
            let shared = NSPrintInfo::sharedPrintInfo();
            let info: Retained<NSPrintInfo> = objc2::msg_send![&*shared, copy];
            info.setPaperSize(size);
            info.setTopMargin(0.0);
            info.setBottomMargin(0.0);
            info.setLeftMargin(0.0);
            info.setRightMargin(0.0);
            info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
            info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
            info.setHorizontallyCentered(false);
            info.setVerticallyCentered(false);
            info.setJobDisposition(NSPrintSaveJob);
            let url = NSURL::fileURLWithPath(&NSString::from_str(&path));
            let url_object: &AnyObject = &url;
            info.dictionary().insert(NSPrintJobSavingURL, url_object);

            let operation = wk.printOperationWithPrintInfo(&info);
            operation.setShowsPrintPanel(false);
            operation.setShowsProgressPanel(false);
            // WebKit a besoin d'une vue dimensionnée pour mettre en page.
            if let Some(view) = operation.view() {
                view.setFrame(wk.bounds());
            }
            operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                ns_window,
                None,
                None,
                std::ptr::null_mut(),
            );
        })
        .map_err(|e| e.to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn export(_window: &tauri::WebviewWindow, _path: &str, _page: &PageSetup) -> Result<(), String> {
    Err("L'export PDF direct n'existe que sur Mac pour l'instant.".into())
}
