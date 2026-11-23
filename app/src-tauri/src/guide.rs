//! Le guide intégré (Aide > Guide de Text Machine) : un document Text
//! Machine écrit en Markdown, avec un onglet de présentation (et ses
//! sous-onglets) et un onglet « Nouveautés ».
//!
//! - `docs/guide.md` : la présentation de l'application.
//! - `CHANGELOG.md` : les nouveautés, version par version. À compléter à
//!   chaque changement visible : l'onglet « Nouveautés » le reprend tel quel.
//!
//! Les deux fichiers sont inclus dans l'application à la compilation : le
//! guide n'est jamais lu ni écrit sur le disque, il ne peut donc remplacer
//! aucun document de l'utilisateur.

use tm_io_native::NativeFile;
use tm_model::{PageSetup, StyleSheet};

const GUIDE: &str = include_str!("../../../docs/guide.md");
const CHANGELOG: &str = include_str!("../../../CHANGELOG.md");

/// Titre de l'onglet des nouveautés (l'interface l'ouvre après une mise à jour).
pub const NEWS_TAB: &str = "Nouveautés";

/// Le guide complet, en Markdown, pour la version `version` de l'application.
pub fn markdown(version: &str) -> String {
    // Le titre « # Nouveautés » du fichier devient le titre de l'onglet.
    let changelog = CHANGELOG
        .trim_start()
        .strip_prefix("# ")
        .and_then(|rest| rest.split_once('\n'))
        .map_or(CHANGELOG, |(_, body)| body);
    format!(
        "{}\n\n<!-- text-machine:onglet niveau=1 -->\n# {NEWS_TAB}\n\n\
         # Nouveautés de Text Machine\n\nVous utilisez la version **{version}** de Text Machine.\n\n{}",
        GUIDE.trim_end(),
        changelog.trim()
    )
}

pub fn document(version: &str) -> NativeFile {
    NativeFile::from_flat(
        tm_io_markdown::import(&markdown(version)),
        PageSetup::default(),
        StyleSheet::default(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_avec_sous_onglets_puis_nouveautes() {
        let file = document("1.2.3");
        let titles: Vec<&str> = file.tabs.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["Présentation", NEWS_TAB]);
        let presentation = &file.tabs[0];
        assert!(presentation.children.len() >= 8, "{:?}", presentation.children.len());
        assert!(presentation.children.iter().any(|t| t.title == "Relecture"));
        let news = serde_json::to_string(&file.tabs[1].document).unwrap();
        assert!(news.contains("1.2.3"), "{news}");
        assert!(news.contains("novembre 2026"), "{news}");
    }
}
