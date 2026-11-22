//! Export PDF direct : les feuilles affichées (marges, numéros) sont
//! écrites dans un fichier PDF, sans passer par l'impression.
//!
//! Sur Mac, WebKit dessine toute la hauteur des feuilles en une seule
//! grande page PDF (du vrai texte, sélectionnable), puis on la découpe en
//! pages de papier, une par feuille. L'impression, elle, découpait d'après
//! la zone imprimable de l'imprimante : une partie de chaque page passait
//! sur la suivante.
//!
//! Sur Windows, WebView2 sait écrire un PDF lui-même (`PrintToPdf`) : on lui
//! donne la taille exacte d'une feuille et des marges nulles, et la mise en
//! page d'impression (styles.css, `@media print`) fait une feuille par page.

use tm_model::PageSetup;

/// Pixels CSS par millimètre (96 par pouce), comme dans l'éditeur.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const PX_PER_MM: f64 = 96.0 / 25.4;
/// Points typographiques par millimètre (le PDF compte en points).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const POINTS_PER_MM: f64 = 72.0 / 25.4;

#[cfg(target_os = "macos")]
pub async fn export(
    window: &tauri::WebviewWindow,
    path: &str,
    page: &PageSetup,
    pages: u32,
) -> Result<(), String> {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};

    let (w_mm, h_mm) = page.dimensions_mm();
    let pages = pages.max(1);
    let sheet = (w_mm * PX_PER_MM, h_mm * PX_PER_MM);
    let paper = (w_mm * POINTS_PER_MM, h_mm * POINTS_PER_MM);
    let path = path.to_string();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    window
        .with_webview(move |webview| unsafe {
            let wk: &WKWebView = &*(webview.inner() as *const WKWebView);
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = tx.send(Err("export PDF hors du fil principal".into()));
                return;
            };
            // Les feuilles sont en haut à gauche de la page pendant l'export
            // (classe « exporting », voir styles.css) : on prend leur rectangle.
            let config = WKPDFConfiguration::new(mtm);
            config.setRect(CGRect::new(
                CGPoint::new(0.0, 0.0),
                CGSize::new(sheet.0, sheet.1 * pages as f64),
            ));
            let tx = tx.clone();
            let path = path.clone();
            let done = RcBlock::new(move |data: *mut NSData, error: *mut NSError| {
                let result = match data.as_ref() {
                    Some(data) => split_pages(data, &path, sheet, paper, pages),
                    None => Err(error
                        .as_ref()
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "WebKit n'a pas produit de PDF".into())),
                };
                let _ = tx.send(result);
            });
            wk.createPDFWithConfiguration_completionHandler(Some(&config), &done);
        })
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .unwrap_or_else(|_| Err("l'export PDF n'a pas abouti".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Découpe la grande page de WebKit en pages de papier, une par feuille.
#[cfg(target_os = "macos")]
fn split_pages(
    data: &objc2_foundation::NSData,
    path: &str,
    sheet: (f64, f64),
    paper: (f64, f64),
    pages: u32,
) -> Result<(), String> {
    use objc2_core_foundation::{CFData, CFURL, CGPoint, CGRect, CGSize};
    use objc2_core_graphics::{
        CGContext, CGDataProvider, CGPDFBox, CGPDFContextBeginPage, CGPDFContextClose,
        CGPDFContextCreateWithURL, CGPDFContextEndPage, CGPDFDocument, CGPDFPage,
    };
    use objc2_foundation::{NSString, NSURL};

    // NSData et CFData (comme NSURL et CFURL) sont le même objet.
    let cf_data: &CFData = unsafe { &*(data as *const _ as *const CFData) };
    let provider = CGDataProvider::with_cf_data(Some(cf_data)).ok_or("PDF illisible")?;
    let source = CGPDFDocument::with_provider(Some(&provider)).ok_or("PDF illisible")?;
    if CGPDFDocument::number_of_pages(Some(&source)) == 0 {
        return Err("PDF vide".into());
    }
    let page = CGPDFDocument::page(Some(&source), 1).ok_or("PDF vide")?;
    let src = CGPDFPage::box_rect(Some(&page), CGPDFBox::MediaBox);
    // Unité de la page de WebKit → points du papier.
    let unit = src.size.width / sheet.0;
    let sheet_h = sheet.1 * unit;
    let scale = paper.0 / src.size.width;

    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    let cf_url: &CFURL = unsafe { &*(&*url as *const NSURL as *const CFURL) };
    let media = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(paper.0, paper.1));
    let ctx = unsafe { CGPDFContextCreateWithURL(Some(cf_url), &media, None) }
        .ok_or("impossible d'écrire le fichier PDF")?;
    let top = src.origin.y + src.size.height;
    for i in 0..pages {
        // En PDF, l'axe vertical monte : la feuille i va de top - (i+1)·h à top - i·h.
        let bottom = top - (i as f64 + 1.0) * sheet_h;
        unsafe { CGPDFContextBeginPage(Some(&ctx), None) };
        CGContext::save_g_state(Some(&ctx));
        CGContext::scale_ctm(Some(&ctx), scale, scale);
        CGContext::translate_ctm(Some(&ctx), -src.origin.x, -bottom);
        CGContext::clip_to_rect(
            Some(&ctx),
            CGRect::new(CGPoint::new(src.origin.x, bottom), CGSize::new(src.size.width, sheet_h)),
        );
        CGContext::draw_pdf_page(Some(&ctx), Some(&page));
        CGContext::restore_g_state(Some(&ctx));
        CGPDFContextEndPage(Some(&ctx));
    }
    CGPDFContextClose(Some(&ctx));
    Ok(())
}

#[cfg(windows)]
pub async fn export(
    window: &tauri::WebviewWindow,
    path: &str,
    page: &PageSetup,
    _pages: u32,
) -> Result<(), String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::{ICoreWebView2Environment6, ICoreWebView2_7};
    use webview2_com::PrintToPdfCompletedHandler;
    use windows_core::{Interface, HSTRING};

    const MM_PER_INCH: f64 = 25.4;
    let (w_mm, h_mm) = page.dimensions_mm();
    let path = path.to_string();
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();

    window
        .with_webview(move |webview| {
            let start = || -> windows_core::Result<()> {
                unsafe {
                    let core: ICoreWebView2_7 = webview.controller().CoreWebView2()?.cast()?;
                    let env: ICoreWebView2Environment6 = webview.environment().cast()?;
                    let settings = env.CreatePrintSettings()?;
                    settings.SetPageWidth(w_mm / MM_PER_INCH)?;
                    settings.SetPageHeight(h_mm / MM_PER_INCH)?;
                    settings.SetMarginTop(0.0)?;
                    settings.SetMarginBottom(0.0)?;
                    settings.SetMarginLeft(0.0)?;
                    settings.SetMarginRight(0.0)?;
                    settings.SetScaleFactor(1.0)?;
                    settings.SetShouldPrintBackgrounds(true)?;
                    settings.SetShouldPrintHeaderAndFooter(false)?;
                    let done_tx = tx.clone();
                    let handler = PrintToPdfCompletedHandler::create(Box::new(move |result, ok| {
                        let _ = done_tx.send(match result {
                            Ok(()) if ok => Ok(()),
                            Ok(()) => Err("WebView2 n'a pas pu écrire le PDF (fichier ouvert ailleurs ?)".into()),
                            Err(e) => Err(e.message()),
                        });
                        Ok(())
                    }));
                    core.PrintToPdf(&HSTRING::from(path.as_str()), &settings, &handler)
                }
            };
            if let Err(e) = start() {
                let _ = tx.send(Err(format!("export PDF impossible : {}", e.message())));
            }
        })
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(60))
            .unwrap_or_else(|_| Err("l'export PDF n'a pas abouti".into()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(not(any(target_os = "macos", windows)))]
pub async fn export(
    _window: &tauri::WebviewWindow,
    _path: &str,
    _page: &PageSetup,
    _pages: u32,
) -> Result<(), String> {
    Err("L'export PDF direct n'existe que sur Mac et Windows pour l'instant.".into())
}
