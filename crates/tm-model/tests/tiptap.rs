//! Vérifie que le modèle lit un document réellement produit par l'éditeur
//! TipTap de l'application (capturé depuis `editor.getJSON()`).

use tm_model::Document;

#[test]
fn lit_un_document_capture_dans_l_editeur() {
    let json = include_str!("fixtures/tiptap-starterkit.json");
    let doc = Document::from_json(json).expect("JSON TipTap lisible");
    assert_eq!(doc.content.len(), 4);
    assert_eq!(doc.word_count(), 4 + 4 + 2 + 2 + 4);
    // L'écriture redonne exactement le même JSON que TipTap.
    let back: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
    let original: serde_json::Value = serde_json::from_str(json).unwrap();
    assert_eq!(back, original);
}
