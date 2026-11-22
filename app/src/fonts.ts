// Polices : celles installées sur le Mac et celles importées dans Text
// Machine (fichiers .ttf/.otf/.ttc ou un dossier). Les polices importées
// sont copiées par le cœur Rust dans le dossier de l'application, puis
// chargées ici dans la page (FontFace), à chaque lancement.

import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { closeMenus } from "./menus";

interface ImportedFont {
  family: string;
  file: string;
  index: number;
  weight: number;
  italic: boolean;
}

/** Si la liste du système n'est pas lisible (hors Mac, navigateur). */
const FALLBACK_FONTS = [
  "Arial",
  "Avenir Next",
  "Baskerville",
  "Courier New",
  "Garamond",
  "Georgia",
  "Helvetica Neue",
  "Palatino",
  "Times New Roman",
  "Verdana",
];

let systemFonts: string[] = [];
let importedFamilies: string[] = [];
const loadedFiles = new Set<string>();
const listeners: (() => void)[] = [];

const unique = (list: string[]) => [...new Set(list)].sort((a, b) => a.localeCompare(b, "fr"));

/** Toutes les polices proposées, dans l'ordre alphabétique. */
export function allFonts() {
  return unique([...(systemFonts.length ? systemFonts : FALLBACK_FONTS), ...importedFamilies]);
}

export const isImported = (family: string) => importedFamilies.includes(family);

/** Prévenu quand la liste des polices change (import, retrait). */
export function onFontsChange(listener: () => void) {
  listeners.push(listener);
}

const changed = () => listeners.forEach((l) => l());

async function loadImported() {
  const fonts = await invoke<ImportedFont[]>("list_imported_fonts").catch(() => [] as ImportedFont[]);
  importedFamilies = unique(fonts.map((f) => f.family));
  for (const font of fonts) {
    const key = `${font.file}#${font.index}`;
    if (loadedFiles.has(key)) continue;
    try {
      const data = await invoke<ArrayBuffer>("read_imported_font", { file: font.file });
      // Un fichier .ttc contient plusieurs polices : on prend la bonne.
      const face = new FontFace(font.family, data, {
        weight: String(font.weight || 400),
        style: font.italic ? "italic" : "normal",
      });
      await face.load();
      document.fonts.add(face);
      loadedFiles.add(key);
    } catch {
      // Police illisible pour le navigateur : elle reste dans la liste.
    }
  }
}

/** Au lancement : polices du système et polices importées. */
export async function initFonts() {
  await loadImported();
  changed();
  systemFonts = await invoke<string[]>("list_system_fonts").catch(() => [] as string[]);
  changed();
}

async function importFonts(directory: boolean) {
  const picked = await open(
    directory
      ? { directory: true, multiple: false, title: "Dossier de polices à importer" }
      : {
          multiple: true,
          title: "Polices à importer",
          filters: [{ name: "Polices", extensions: ["ttf", "otf", "ttc", "otc"] }],
        },
  );
  const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
  if (!paths.length) return [];
  try {
    const families = await invoke<string[]>("import_fonts", { paths });
    await loadImported();
    changed();
    return families;
  } catch (e) {
    alert(String(e));
    return [];
  }
}

async function removeImported(family: string) {
  const message = `Retirer la police « ${family} » de Text Machine ? Le texte qui l'utilise s'affichera dans une autre police.`;
  const ok = await ask(message, { title: "Text Machine", kind: "warning", okLabel: "Retirer", cancelLabel: "Annuler" }).catch(
    () => window.confirm(message),
  );
  if (!ok) return;
  try {
    await invoke("remove_imported_font", { family });
    importedFamilies = importedFamilies.filter((f) => f !== family);
    changed();
  } catch (e) {
    alert(String(e));
  }
}

const cssFamily = (font: string) => `"${font.replace(/"/g, "")}", Georgia, serif`;

/**
 * Sélecteur de police façon Google Docs : une liste où chaque police est
 * écrite dans sa propre forme, avec une recherche, et l'import de polices.
 */
export function openFontPicker(anchor: HTMLElement, current: string, choose: (font: string) => void) {
  closeMenus();
  document.querySelector(".font-picker")?.remove();
  const panel = document.createElement("div");
  panel.className = "font-picker menu popup";
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "Rechercher une police";
  const list = document.createElement("div");
  list.className = "font-list";
  const actions = document.createElement("div");
  actions.className = "font-actions";
  const importFiles = document.createElement("button");
  importFiles.type = "button";
  importFiles.textContent = "Importer des fichiers de police…";
  const importDir = document.createElement("button");
  importDir.type = "button";
  importDir.textContent = "Importer un dossier de polices…";
  actions.append(importFiles, importDir);
  panel.append(search, list, actions);

  const close = () => {
    panel.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  const outside = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };

  const row = (font: string) => {
    const item = document.createElement("div");
    item.className = "font-item";
    item.classList.toggle("current", font === current);
    const name = document.createElement("button");
    name.type = "button";
    name.className = "font-name";
    name.textContent = font;
    name.title = font;
    name.style.fontFamily = cssFamily(font);
    name.addEventListener("click", () => {
      close();
      choose(font);
    });
    item.append(name);
    if (isImported(font)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "font-remove";
      remove.title = "Retirer cette police importée";
      remove.textContent = "✕";
      remove.addEventListener("click", async () => {
        await removeImported(font);
        render();
      });
      item.append(remove);
    }
    return item;
  };

  const section = (title: string, fonts: string[]) => {
    if (!fonts.length) return [];
    const h = document.createElement("div");
    h.className = "font-section";
    h.textContent = title;
    return [h, ...fonts.map(row)];
  };

  function render() {
    const q = search.value.trim().toLocaleLowerCase("fr");
    const match = (f: string) => !q || f.toLocaleLowerCase("fr").includes(q);
    const imported = importedFamilies.filter(match);
    const others = allFonts().filter((f) => match(f) && !isImported(f));
    const items = [
      ...section("Polices importées", imported),
      ...section(systemFonts.length ? "Polices de l'ordinateur" : "Polices", others),
    ];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "font-section";
      empty.textContent = "Aucune police ne correspond.";
      items.push(empty);
    }
    list.replaceChildren(...items);
  }

  const doImport = async (directory: boolean) => {
    const families = await importFonts(directory);
    render();
    if (families.length === 1) {
      close();
      choose(families[0]);
    }
  };
  importFiles.addEventListener("click", () => doImport(false));
  importDir.addEventListener("click", () => doImport(true));
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      const first = list.querySelector<HTMLButtonElement>(".font-name");
      if (first) first.click();
    }
  });

  render();
  document.body.append(panel);
  const r = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - panel.offsetWidth - 4))}px`;
  panel.style.top = `${r.bottom + 2}px`;
  list.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 140)}px`;
  list.querySelector(".current")?.scrollIntoView({ block: "center" });
  search.focus();
  document.addEventListener("mousedown", outside, true);
}
