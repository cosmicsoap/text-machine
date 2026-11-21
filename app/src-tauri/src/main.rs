// Évite une fenêtre de console supplémentaire sous Windows en mode release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    text_machine_lib::run()
}
