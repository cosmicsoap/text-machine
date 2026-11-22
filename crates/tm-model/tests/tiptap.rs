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

/// Retire ce que le modèle ne garde volontairement pas : les valeurs `null`
/// (valeur par défaut), les objets `attrs` devenus vides et les attributs
/// techniques des liens (cible, `rel`…), recalculés par l'éditeur.
fn normalise(value: &mut serde_json::Value) {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            if map.get("type").and_then(Value::as_str) == Some("link") {
                if let Some(Value::Object(attrs)) = map.get_mut("attrs") {
                    attrs.retain(|k, _| k == "href");
                }
            }
            map.retain(|_, v| !v.is_null());
            for v in map.values_mut() {
                normalise(v);
            }
            map.retain(|k, v| !(k == "attrs" && v.as_object().is_some_and(|o| o.is_empty())));
        }
        Value::Array(items) => items.iter_mut().for_each(normalise),
        // 320 et 320.0 sont le même nombre.
        Value::Number(n) => *value = serde_json::json!(n.as_f64()),
        _ => {}
    }
}

#[test]
fn garde_toute_la_mise_en_forme() {
    let json = include_str!("fixtures/tiptap-formatting.json");
    let doc = Document::from_json(json).expect("JSON TipTap lisible");
    let mut back: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
    let mut original: serde_json::Value = serde_json::from_str(json).unwrap();
    normalise(&mut back);
    normalise(&mut original);
    assert_eq!(back, original);
}

#[test]
fn garde_tableaux_et_images() {
    let json = include_str!("fixtures/tiptap-table-image.json");
    let doc = Document::from_json(json).expect("JSON TipTap lisible");
    // « Tableau : Nom Âge Ada » : le « : » isolé n'est pas un mot.
    assert_eq!(doc.word_count(), 4);
    let mut back: serde_json::Value = serde_json::from_str(&doc.to_json().unwrap()).unwrap();
    let mut original: serde_json::Value = serde_json::from_str(json).unwrap();
    normalise(&mut back);
    normalise(&mut original);
    assert_eq!(back, original);
}
