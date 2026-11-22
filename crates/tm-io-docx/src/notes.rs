//! Notes de bas de page : ce que `docx-rs` ne sait pas faire seul.
//!
//! - À l'écriture, il n'ajoute pas le numéro de la note devant son texte
//!   (`<w:footnoteRef/>`) : on le met à la place d'un repère.
//! - À la lecture, il ignore les notes : on lit `word/footnotes.xml`
//!   nous-mêmes et on remplace chaque appel de note par un repère texte que
//!   `import` transforme en [`tm_model::Inline::Footnote`].

use std::collections::HashMap;
use std::io::{Read, Write};

use crate::DocxError;

/// Repère du numéro dans le texte d'une note (caractère à usage privé).
pub(crate) const NUMBER_MARK: &str = "\u{E000}";
/// Repère d'un appel de note à la lecture : `\u{E001}<id>\u{E002}`.
pub(crate) const REF_START: char = '\u{E001}';
pub(crate) const REF_END: char = '\u{E002}';

fn zip_err(e: impl std::fmt::Display) -> DocxError {
    DocxError::Docx(e.to_string())
}

/// Les fichiers du paquet `.docx`, dans l'ordre.
pub(crate) fn read_parts(bytes: &[u8]) -> Result<Vec<(String, Vec<u8>)>, DocxError> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(zip_err)?;
    let mut parts = Vec::with_capacity(zip.len());
    for i in 0..zip.len() {
        let mut file = zip.by_index(i).map_err(zip_err)?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        parts.push((file.name().to_string(), data));
    }
    Ok(parts)
}

pub(crate) fn write_parts(parts: &[(String, Vec<u8>)]) -> Result<Vec<u8>, DocxError> {
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in parts {
        zip.start_file(name.as_str(), options).map_err(zip_err)?;
        zip.write_all(data)?;
    }
    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

/// Met le vrai numéro de note (`<w:footnoteRef/>`) à la place du repère.
pub(crate) fn add_note_numbers(bytes: &[u8]) -> Result<Vec<u8>, DocxError> {
    let mut parts = read_parts(bytes)?;
    let Some((_, xml)) = parts.iter_mut().find(|(n, _)| n == "word/footnotes.xml") else {
        return Ok(bytes.to_vec());
    };
    let text = String::from_utf8_lossy(xml).into_owned();
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(i) = rest.find(NUMBER_MARK) {
        // Le repère est dans un `<w:t …>` : on remplace tout l'élément.
        let start = rest[..i].rfind("<w:t").unwrap_or(i);
        let end = rest[i..]
            .find("</w:t>")
            .map(|j| i + j + 6)
            .unwrap_or(i + NUMBER_MARK.len());
        out.push_str(&rest[..start]);
        out.push_str("<w:footnoteRef/>");
        rest = &rest[end..];
    }
    out.push_str(rest);
    *xml = out.into_bytes();
    write_parts(&parts)
}

/// Lit le texte des notes et remplace chaque appel de note du document par
/// un repère texte. Renvoie le paquet modifié et le texte de chaque note.
pub(crate) fn extract_notes(bytes: &[u8]) -> Result<(Vec<u8>, HashMap<String, String>), DocxError> {
    let mut parts = read_parts(bytes)?;
    let Some((_, notes_xml)) = parts.iter().find(|(n, _)| n == "word/footnotes.xml") else {
        return Ok((bytes.to_vec(), HashMap::new()));
    };
    let notes = parse_notes(&String::from_utf8_lossy(notes_xml));
    if notes.is_empty() {
        return Ok((bytes.to_vec(), notes));
    }
    if let Some((_, doc)) = parts.iter_mut().find(|(n, _)| n == "word/document.xml") {
        let text = String::from_utf8_lossy(doc).into_owned();
        let mut out = String::with_capacity(text.len());
        let mut rest = text.as_str();
        while let Some(i) = rest.find("<w:footnoteReference") {
            let Some(len) = rest[i..].find('>') else {
                break;
            };
            let tag = &rest[i..i + len + 1];
            out.push_str(&rest[..i]);
            match attr(tag, "w:id") {
                Some(id) => out.push_str(&format!("<w:t>{REF_START}{id}{REF_END}</w:t>")),
                None => out.push_str(tag),
            }
            rest = &rest[i + len + 1..];
        }
        out.push_str(rest);
        *doc = out.into_bytes();
    }
    Ok((write_parts(&parts)?, notes))
}

pub(crate) fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let i = tag.find(&format!("{name}=\""))? + name.len() + 2;
    let len = tag[i..].find('"')?;
    Some(&tag[i..i + len])
}

/// Le texte de chaque note de `footnotes.xml` (un paragraphe par ligne),
/// sans les séparateurs.
fn parse_notes(xml: &str) -> HashMap<String, String> {
    let mut notes = HashMap::new();
    let mut rest = xml;
    while let Some(i) = rest.find("<w:footnote ") {
        let Some(len) = rest[i..].find('>') else {
            break;
        };
        let tag = &rest[i..i + len + 1];
        let body_start = i + len + 1;
        let end = rest[body_start..]
            .find("</w:footnote>")
            .map(|j| body_start + j)
            .unwrap_or(rest.len());
        let body = if tag.ends_with("/>") {
            ""
        } else {
            &rest[body_start..end]
        };
        if let (Some(id), None) = (attr(tag, "w:id"), attr(tag, "w:type")) {
            notes.insert(id.to_string(), note_text(body));
        }
        rest = &rest[end.min(rest.len())..];
        if rest.starts_with("</w:footnote>") {
            rest = &rest["</w:footnote>".len()..];
        }
    }
    notes
}

fn note_text(body: &str) -> String {
    let mut paragraphs = Vec::new();
    for para in body.split("</w:p>") {
        let mut text = String::new();
        let mut rest = para;
        while let Some(i) = rest.find("<w:t") {
            let after = &rest[i + 4..];
            // `<w:t>` ou `<w:t xml:space="preserve">`, pas `<w:tab/>`.
            if !(after.starts_with('>') || after.starts_with(' ')) {
                rest = after;
                continue;
            }
            let Some(open) = after.find('>') else { break };
            let content = &after[open + 1..];
            let Some(close) = content.find("</w:t>") else {
                break;
            };
            text.push_str(&unescape(&content[..close]));
            rest = &content[close..];
        }
        paragraphs.push(text);
    }
    while paragraphs.last().is_some_and(|p| p.trim().is_empty()) {
        paragraphs.pop();
    }
    paragraphs.join("\n").trim().to_string()
}

fn unescape(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}
