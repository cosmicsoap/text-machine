// Différences entre Mac et Windows (ou Linux) côté éditeur.
//
// Les raccourcis sont écrits à la façon du Mac (« ⇧⌘S ») ; ailleurs, on les
// affiche « Ctrl+Maj+S ». Les touches elles-mêmes marchent déjà partout :
// l'éditeur accepte ⌘ comme Ctrl.

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const MODIFIERS: Record<string, string> = { "⌃": "Ctrl", "⌘": "Ctrl", "⌥": "Alt", "⇧": "Maj" };
const ORDER = ["Ctrl", "Alt", "Maj"];
const KEYS: Record<string, string> = { "↩": "Entrée", "⌫": "Retour arrière", "⇥": "Tab" };

/** « ⇧⌘S » → « Ctrl+Maj+S » hors Mac ; inchangé sur Mac. */
export function shortcutLabel(shortcut: string, mac = isMac): string {
  if (mac) return shortcut;
  const mods = new Set<string>();
  let key = "";
  for (const ch of shortcut) {
    if (MODIFIERS[ch]) mods.add(MODIFIERS[ch]);
    else key += ch;
  }
  if (mods.size === 0) return shortcut;
  key = KEYS[key] ?? key.toUpperCase();
  return [...ORDER.filter((m) => mods.has(m)), key].join("+");
}

/** Bulles d'aide de la barre d'outils : « Gras (⌘B) » → « Gras (Ctrl+B) ». */
export function localizeShortcutTitles(root: ParentNode = document) {
  if (isMac) return;
  root.querySelectorAll<HTMLElement>("[title]").forEach((el) => {
    el.title = el.title.replace(/\(([⌃⌥⇧⌘]+[^)]+)\)/g, (_, s: string) => `(${shortcutLabel(s)})`);
  });
}
