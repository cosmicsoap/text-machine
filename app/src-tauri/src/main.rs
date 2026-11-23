// Point de départ du programme : quand on lance Text Machine, l'ordinateur
// exécute la fonction `main` ci-dessous. Elle passe aussitôt la main à
// `run()`, dans `lib.rs`, où tout se met en place.
//
// Évite une fenêtre de console supplémentaire sous Windows en mode release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    text_machine_lib::run()
}
