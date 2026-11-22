// Polices : celles importées dans Text Machine (fichiers .ttf/.otf/.ttc ou
// un dossier) et celles de l'ordinateur. Les polices importées sont copiées
// par le cœur Rust dans le dossier de l'application, puis chargées ici dans
// la page (FontFace), à chaque lancement.
//
// Chaque police est une famille (« Lexend ») avec ses formes : graisses
// (Light, Medium, SemiBold…) et italiques. Par défaut, la liste ne montre que
// « Mes polices » : les polices importées et celles marquées d'une étoile.
// Les polices de l'ordinateur s'affichent sur demande.

import { invoke } from "@tauri-apps/api/core";
import { ask, open } from "@tauri-apps/plugin-dialog";
import { closeMenus } from "./menus";
import { faceName } from "./stylesheet";

interface ImportedFont {
  family: string;
  file: string;
  index: number;
  weight: number;
  weightMax: number;
  italic: boolean;
}

/** Une forme d'une famille ; `weightMax` > `weight` : police variable. */
export interface Face {
  weight: number;
  weightMax: number;
  italic: boolean;
}

interface Family {
  family: string;
  faces: Face[];
}

/** Ce que l'utilisateur choisit : une famille, et parfois une forme. */
export interface FontChoice {
  family: string;
  /** Absente : la graisse normale (ou celle du style). */
  weight?: number;
  italic?: boolean;
}

/** Si la liste du système n'est pas lisible (navigateur). */
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

/** Les polices de l'ordinateur proposées d'office dans « Mes polices ». */
const DEFAULT_FAVORITES = ["Georgia", "Helvetica Neue", "Times New Roman", "Courier New"];

let systemFonts: Family[] = [];
const importedFaces = new Map<string, Face[]>();
const loadedFiles = new Set<string>();
const listeners: (() => void)[] = [];

// --- Préférences : étoiles et affichage des polices de l'ordinateur ---------

interface FontPrefs {
  showSystem: boolean;
  favorites: string[];
}

function readPrefs(): FontPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem("tm.fonts") ?? "null");
    if (raw && Array.isArray(raw.favorites)) return { showSystem: !!raw.showSystem, favorites: raw.favorites };
  } catch {
    /* préférences illisibles : valeurs par défaut */
  }
  return { showSystem: false, favorites: [...DEFAULT_FAVORITES] };
}

const prefs = readPrefs();

function savePrefs() {
  try {
    localStorage.setItem("tm.fonts", JSON.stringify(prefs));
  } catch {
    /* pas grave */
  }
}

const byName = (a: string, b: string) => a.localeCompare(b, "fr");
const unique = (list: string[]) => [...new Set(list)].sort(byName);

const systemNames = () => (systemFonts.length ? systemFonts.map((f) => f.family) : FALLBACK_FONTS);

export const isImported = (family: string) => importedFaces.has(family);
export const isFavorite = (family: string) => prefs.favorites.includes(family);

/** « Mes polices » : importées, puis celles de l'ordinateur marquées d'une étoile. */
export function myFonts() {
  const system = new Set(systemNames());
  return unique([...importedFaces.keys(), ...prefs.favorites.filter((f) => system.has(f))]);
}

/** Toutes les polices connues, dans l'ordre alphabétique. */
export function allFonts() {
  return unique([...systemNames(), ...importedFaces.keys()]);
}

/**
 * Les formes d'une famille, une par graisse et par style. Une police
 * variable donne les graisses rondes (100, 200…) de sa plage.
 */
export function facesOf(family: string): { weight: number; italic: boolean }[] {
  const faces = importedFaces.get(family) ?? systemFonts.find((f) => f.family === family)?.faces ?? [];
  const out = new Map<string, { weight: number; italic: boolean }>();
  for (const face of faces) {
    const max = Math.max(face.weight, face.weightMax || face.weight);
    const weights =
      max > face.weight
        ? [100, 200, 300, 400, 500, 600, 700, 800, 900].filter((w) => w >= face.weight && w <= max)
        : [face.weight];
    for (const weight of weights) out.set(`${weight}-${face.italic}`, { weight, italic: face.italic });
  }
  return [...out.values()].sort((a, b) => a.weight - b.weight || Number(a.italic) - Number(b.italic));
}

/** Prévenu quand la liste des polices change (import, retrait, étoile). */
export function onFontsChange(listener: () => void) {
  listeners.push(listener);
}

const changed = () => listeners.forEach((l) => l());

async function loadImported() {
  const fonts = await invoke<ImportedFont[]>("list_imported_fonts").catch(() => [] as ImportedFont[]);
  importedFaces.clear();
  for (const font of fonts) {
    const faces = importedFaces.get(font.family) ?? [];
    faces.push({ weight: font.weight, weightMax: font.weightMax ?? font.weight, italic: font.italic });
    importedFaces.set(font.family, faces);
  }
  for (const font of fonts) {
    const key = `${font.file}#${font.index}`;
    if (loadedFiles.has(key)) continue;
    try {
      const data = await invoke<ArrayBuffer>("read_imported_font", { file: font.file });
      const max = font.weightMax ?? font.weight;
      // Une police variable couvre toute sa plage de graisses.
      const face = new FontFace(font.family, data, {
        weight: max > font.weight ? `${font.weight} ${max}` : String(font.weight || 400),
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

/** Au lancement : polices importées, puis celles de l'ordinateur. */
export async function initFonts() {
  await loadImported();
  changed();
  systemFonts = await invoke<Family[]>("list_system_fonts").catch(() => [] as Family[]);
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
    importedFaces.delete(family);
    changed();
  } catch (e) {
    alert(String(e));
  }
}

function toggleFavorite(family: string) {
  prefs.favorites = isFavorite(family) ? prefs.favorites.filter((f) => f !== family) : [...prefs.favorites, family];
  savePrefs();
  changed();
}

const cssFamily = (font: string) => `"${font.replace(/"/g, "")}", Georgia, serif`;

/** « Lexend Light », « Lexend » : le nom affiché d'une police et de sa forme. */
export function choiceLabel(c: FontChoice) {
  const w = c.weight ?? 400;
  return w === 400 && !c.italic ? c.family : `${c.family} ${faceName(w, !!c.italic)}`;
}

const button = (className: string, text: string, title = text) => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.textContent = text;
  b.title = title;
  return b;
};

/**
 * Sélecteur de police façon Google Docs : une liste où chaque police est
 * écrite dans sa propre forme, avec une recherche, les graisses de chaque
 * famille, et l'import de polices.
 */
export function openFontPicker(anchor: HTMLElement, current: FontChoice, choose: (choice: FontChoice) => void) {
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
  const importFiles = button("", "Importer des fichiers de police…");
  const importDir = button("", "Importer un dossier de polices…");
  const showAll = document.createElement("label");
  showAll.className = "font-show-all";
  const showAllBox = document.createElement("input");
  showAllBox.type = "checkbox";
  showAllBox.checked = prefs.showSystem;
  showAll.append(showAllBox, " Afficher toutes les polices de l'ordinateur");
  actions.append(importDir, importFiles, showAll);
  panel.append(search, list, actions);
  let expanded = current.family;

  const close = () => {
    panel.remove();
    document.removeEventListener("mousedown", outside, true);
  };
  const outside = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const pick = (choice: FontChoice) => {
    close();
    choose(choice);
  };

  const row = (font: string) => {
    const faces = facesOf(font);
    const item = document.createElement("div");
    item.className = "font-item";
    item.classList.toggle("current", font === current.family);
    const name = button("font-name", font);
    name.style.fontFamily = cssFamily(font);
    name.addEventListener("click", () => pick({ family: font }));
    item.append(name);
    if (faces.length > 1) {
      const more = button("font-more", "›", "Graisses et styles");
      more.classList.toggle("open", expanded === font);
      more.addEventListener("click", () => {
        expanded = expanded === font ? "" : font;
        render();
      });
      item.append(more);
    }
    if (isImported(font)) {
      const remove = button("font-remove", "✕", "Retirer cette police importée");
      remove.addEventListener("click", async () => {
        await removeImported(font);
        render();
      });
      item.append(remove);
    } else {
      const star = button("font-star", isFavorite(font) ? "★" : "☆");
      star.title = isFavorite(font) ? "Retirer de « Mes polices »" : "Ajouter à « Mes polices »";
      star.classList.toggle("on", isFavorite(font));
      star.addEventListener("click", () => {
        toggleFavorite(font);
        render();
      });
      item.append(star);
    }
    if (expanded !== font || faces.length < 2) return [item];
    const variants = faces.map((f) => {
      const b = button("font-face", faceName(f.weight, f.italic));
      b.style.fontFamily = cssFamily(font);
      b.style.fontWeight = String(f.weight);
      b.style.fontStyle = f.italic ? "italic" : "normal";
      const isCurrent =
        font === current.family && (current.weight ?? 400) === f.weight && !!current.italic === f.italic;
      b.classList.toggle("current", isCurrent);
      b.addEventListener("click", () => pick({ family: font, weight: f.weight, italic: f.italic }));
      return b;
    });
    const box = document.createElement("div");
    box.className = "font-faces";
    box.append(...variants);
    return [item, box];
  };

  const section = (title: string, fonts: string[]) => {
    if (!fonts.length) return [];
    const h = document.createElement("div");
    h.className = "font-section";
    h.textContent = title;
    return [h, ...fonts.flatMap(row)];
  };

  function render() {
    const q = search.value.trim().toLocaleLowerCase("fr");
    const match = (f: string) => !q || f.toLocaleLowerCase("fr").includes(q);
    // La police en cours fait partie de la liste, même sans étoile.
    const mine = current.family && !myFonts().includes(current.family) ? [current.family, ...myFonts()] : myFonts();
    const mineSet = new Set(mine);
    // La recherche porte toujours sur toutes les polices.
    const others = prefs.showSystem || q ? allFonts().filter((f) => !mineSet.has(f) && match(f)) : [];
    const items = [
      ...section("Mes polices", mine.filter(match)),
      ...section(systemFonts.length ? "Polices de l'ordinateur" : "Autres polices", others),
    ];
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "font-section";
      empty.textContent = q ? "Aucune police ne correspond." : "Importez un dossier de polices pour commencer.";
      items.push(empty);
    }
    list.replaceChildren(...items);
  }

  const doImport = async (directory: boolean) => {
    const families = await importFonts(directory);
    render();
    if (families.length === 1) pick({ family: families[0] });
  };
  importFiles.addEventListener("click", () => doImport(false));
  importDir.addEventListener("click", () => doImport(true));
  showAllBox.addEventListener("change", () => {
    prefs.showSystem = showAllBox.checked;
    savePrefs();
    render();
  });
  search.addEventListener("input", render);
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    if (e.key === "Enter") {
      e.preventDefault();
      list.querySelector<HTMLButtonElement>(".font-name")?.click();
    }
  });

  render();
  // Dans une fenêtre (Styles), le panneau doit être dans la fenêtre pour s'afficher devant.
  (anchor.closest("dialog") ?? document.body).append(panel);
  const r = anchor.getBoundingClientRect();
  panel.style.left = `${Math.max(4, Math.min(r.left, window.innerWidth - panel.offsetWidth - 4))}px`;
  panel.style.top = `${r.bottom + 2}px`;
  list.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 170)}px`;
  list.querySelector(".font-item.current")?.scrollIntoView({ block: "center" });
  search.focus();
  document.addEventListener("mousedown", outside, true);
}
