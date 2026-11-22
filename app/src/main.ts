// Éditeur web : TipTap s'occupe de la saisie et de l'affichage, le cœur
// Rust (via les commandes Tauri) s'occupe du document, des fichiers et des
// calculs comme le nombre de mots.

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import FileHandler from "@tiptap/extension-file-handler";
import {
  DEFAULT_PAGE_SETUP,
  PageBreak,
  Pagination,
  SCREEN_GAP_PX,
  mmToPx,
  pageSizePx,
  refreshPagination,
  type PageSetup,
} from "./extensions/pagination";
import { Search, getSearchState } from "./extensions/search";
import { ParagraphFormat } from "./extensions/paragraph-format";
import { invoke } from "@tauri-apps/api/core";
import { ask, open, save } from "@tauri-apps/plugin-dialog";

/** Formats que l'application ouvre et enregistre directement. */
const OPEN_FILTERS = [
  { name: "Documents", extensions: ["docx", "md", "markdown", "txt", "tmd"] },
];
const SAVE_FILTERS = [
  { name: "Document Word", extensions: ["docx"] },
  { name: "Markdown", extensions: ["md"] },
  { name: "Texte brut", extensions: ["txt"] },
];

let currentPath: string | null = null;
let pageSetup: PageSetup = structuredClone(DEFAULT_PAGE_SETUP);

const editor = new Editor({
  element: document.querySelector<HTMLElement>("#editor")!,
  extensions: [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // Un clic sur un lien ne doit pas quitter l'éditeur.
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    // Police, taille, couleur du texte (lineHeight se règle par paragraphe).
    TextStyleKit.configure({ lineHeight: false }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    ParagraphFormat,
    PageBreak,
    Search,
    Pagination.configure({
      getSetup: () => pageSetup,
      onLayout: (pages) => drawSheets(pages),
    }),
    TableKit.configure({ table: { resizable: true } }),
    Image.configure({
      allowBase64: true,
      resize: { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 40, minHeight: 40 },
    }),
    // Images collées (⌘V) ou glissées dans la page.
    FileHandler.configure({
      allowedMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"],
      onPaste: (ed, files) => files.forEach((f) => insertImageFile(f, ed.state.selection.from)),
      onDrop: (_ed, files, pos) => files.forEach((f) => insertImageFile(f, pos)),
    }),
  ],
  content: "<h1>Bienvenue dans Text Machine</h1><p>Commencez à écrire ici.</p>",
  autofocus: "end",
  // Correcteur orthographique du système (macOS), en français.
  editorProps: { attributes: { spellcheck: "true", lang: "fr" } },
  onUpdate: () => {
    markDirty();
    scheduleWordCount();
    scheduleOutline();
  },
  onSelectionUpdate: () => refreshToolbar(),
  onTransaction: () => refreshToolbar(),
});

// --- Plan du document -------------------------------------------------------

const outline = document.querySelector<HTMLElement>("#outline")!;
const outlineList = document.querySelector<HTMLOListElement>("#outline-list")!;
let outlineTimer: number | undefined;

function scheduleOutline() {
  window.clearTimeout(outlineTimer);
  outlineTimer = window.setTimeout(updateOutline, 250);
}

function updateOutline() {
  if (outline.hidden) return;
  const items: HTMLLIElement[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const li = document.createElement("li");
    li.className = `level-${node.attrs.level}`;
    li.textContent = node.textContent || "(titre vide)";
    li.addEventListener("click", () => {
      editor.chain().focus().setTextSelection(pos + 1).run();
      (editor.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    items.push(li);
    return false;
  });
  outlineList.replaceChildren(...items);
  document.querySelector<HTMLElement>("#outline-empty")!.hidden = items.length > 0;
}

function toggleOutline() {
  outline.hidden = !outline.hidden;
  toolbar.querySelector('[data-action="outline"]')?.classList.toggle("active", !outline.hidden);
  updateOutline();
}

// --- Correcteur orthographique --------------------------------------------

function toggleSpellcheck() {
  const dom = editor.view.dom as HTMLElement;
  const on = dom.spellcheck;
  dom.spellcheck = !on;
  toolbar.querySelector('[data-action="spellcheck"]')?.classList.toggle("active", !on);
  // Force le navigateur à revérifier (ou effacer) les soulignements.
  dom.blur();
  editor.commands.focus();
}

// --- Rechercher / remplacer -------------------------------------------------

const findBar = document.querySelector<HTMLElement>("#find-bar")!;
const findInput = document.querySelector<HTMLInputElement>("#find-input")!;
const replaceInput = document.querySelector<HTMLInputElement>("#replace-input")!;
const findCase = document.querySelector<HTMLInputElement>("#find-case")!;
const findCount = document.querySelector<HTMLElement>("#find-count")!;

function openFind() {
  findBar.hidden = false;
  const { from, to, empty } = editor.state.selection;
  if (!empty) findInput.value = editor.state.doc.textBetween(from, to, " ");
  findInput.focus();
  findInput.select();
  runSearch();
}

function closeFind() {
  findBar.hidden = true;
  editor.chain().setSearch("").focus().run();
}

function runSearch() {
  editor.commands.setSearch(findInput.value, findCase.checked);
  refreshFindCount();
}

function refreshFindCount() {
  const s = getSearchState(editor.state);
  findCount.textContent = !s.query
    ? ""
    : s.matches.length
      ? `${s.current + 1} sur ${s.matches.length}`
      : "Aucun résultat";
}

findInput.addEventListener("input", runSearch);
findCase.addEventListener("change", runSearch);
findBar.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeFind();
  else if (event.key === "Enter" && event.target === findInput) {
    event.preventDefault();
    if (event.shiftKey) editor.commands.previousMatch();
    else editor.commands.nextMatch();
    refreshFindCount();
  }
});
findBar.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest("button")?.dataset.find;
  if (action === "next") editor.commands.nextMatch();
  else if (action === "prev") editor.commands.previousMatch();
  else if (action === "replace") editor.commands.replaceCurrent(replaceInput.value);
  else if (action === "replaceAll") editor.commands.replaceAll(replaceInput.value);
  else if (action === "close") return closeFind();
  refreshFindCount();
});

// --- Pages -----------------------------------------------------------------

const paper = document.querySelector<HTMLElement>("#paper")!;
const sheets = document.querySelector<HTMLElement>("#sheets")!;
const printStyle = document.head.appendChild(document.createElement("style"));

/** Applique le format de page : taille de la feuille et marges. */
function applyPageSetup() {
  const { width, height } = pageSizePx(pageSetup);
  const m = pageSetup.margins;
  paper.style.setProperty("--page-w", `${width}px`);
  paper.style.setProperty("--page-h", `${height}px`);
  paper.style.setProperty("--page-gap", `${SCREEN_GAP_PX}px`);
  // Taille du papier à l'impression (et donc du PDF).
  printStyle.textContent = `@page { size: ${width}px ${height}px; margin: 0; }`;
  paper.style.setProperty("--m-top", `${mmToPx(m.top)}px`);
  paper.style.setProperty("--m-bottom", `${mmToPx(m.bottom)}px`);
  paper.style.setProperty("--m-left", `${mmToPx(m.left)}px`);
  paper.style.setProperty("--m-right", `${mmToPx(m.right)}px`);
  lastPages = -1;
}

let lastPages = -1;
/** Dessine une feuille blanche (avec son numéro) par page. */
function drawSheets(pages: number) {
  if (pages === lastPages) return;
  lastPages = pages;
  paper.style.setProperty("--pages", String(pages));
  sheets.replaceChildren(
    ...Array.from({ length: pages }, (_, i) => {
      const sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.style.top = `calc(${i} * (var(--page-h) + var(--page-gap)))`;
      if (pageSetup.pageNumbers) {
        const number = document.createElement("span");
        number.className = "page-number";
        number.textContent = String(i + 1);
        sheet.append(number);
      }
      return sheet;
    }),
  );
  document.querySelector("#page-count")!.textContent = `${pages} page${pages > 1 ? "s" : ""}`;
}

function setPageSetup(setup: PageSetup) {
  pageSetup = setup;
  markDirty();
  applyPageSetup();
  refreshPagination(editor.view);
}

applyPageSetup();

// --- Images ----------------------------------------------------------------

/** Les images sont gardées dans le document (adresse `data:` en base64). */
function insertImageFile(file: File, pos?: number) {
  const reader = new FileReader();
  reader.onload = () => {
    const image = { type: "image", attrs: { src: String(reader.result), alt: file.name } };
    const chain = editor.chain().focus();
    if (pos === undefined) chain.insertContent(image).run();
    else chain.insertContentAt(pos, image).run();
  };
  reader.readAsDataURL(file);
}

// --- Nombre de mots, calculé par le cœur Rust -------------------------------

let wordTimer: number | undefined;
function scheduleWordCount() {
  window.clearTimeout(wordTimer);
  wordTimer = window.setTimeout(updateWordCount, 300);
}

async function updateWordCount() {
  const n = await invoke<number>("word_count", { doc: editor.getJSON() });
  document.querySelector("#word-count")!.textContent =
    `${n} mot${n > 1 ? "s" : ""}`;
}

// --- Fichiers ---------------------------------------------------------------

interface NativeFile {
  document: JSONContent;
  page: PageSetup;
}

interface Session {
  recent: string[];
  lastFile: string | null;
}

/** Modifications pas encore écrites sur le disque. */
let dirty = false;
/** Vrai pendant le chargement d'un document (ce n'est pas une modification). */
let loading = false;
let autosaveTimer: number | undefined;
const AUTOSAVE_DELAY_MS = 1500;
const fileName = (path: string) => path.split(/[\\/]/).pop()!;

function setPath(path: string | null) {
  currentPath = path;
  const name = path ? fileName(path) : "Sans titre";
  document.querySelector("#file-name")!.textContent = name;
  document.title = `${name} — Text Machine`;
}

function setSaveStatus(text: string) {
  document.querySelector("#save-status")!.textContent = text;
}

/** Appelé à chaque modification du document ou de la mise en page. */
function markDirty() {
  if (loading) return;
  dirty = true;
  setSaveStatus("Modifications non enregistrées");
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(autosave, AUTOSAVE_DELAY_MS);
}

/**
 * Enregistrement automatique : dans le fichier s'il a un nom, sinon dans un
 * brouillon que l'application rouvre au prochain lancement.
 */
async function autosave() {
  if (!dirty) return;
  try {
    if (currentPath) {
      await writeFile(currentPath);
    } else {
      await invoke("save_draft", { doc: editor.getJSON(), page: pageSetup });
      dirty = false;
      setSaveStatus("Brouillon enregistré");
    }
  } catch (e) {
    setSaveStatus(`Échec de l'enregistrement : ${e}`);
  }
}

async function writeFile(path: string) {
  setSaveStatus("Enregistrement…");
  await invoke("save_document", { path, doc: editor.getJSON(), page: pageSetup });
  dirty = false;
  setPath(path);
  setSaveStatus(savedLabel(path));
  refreshRecent();
}

/** Markdown et texte ne gardent pas toute la mise en forme : on le rappelle. */
function savedLabel(path: string) {
  if (/\.(md|markdown)$/i.test(path)) return "Enregistré en Markdown (sans couleurs ni polices)";
  if (/\.txt$/i.test(path)) return "Enregistré en texte brut (sans mise en forme)";
  return "Enregistré";
}

function loadFile(file: NativeFile, path: string | null) {
  loading = true;
  editor.commands.setContent(file.document);
  setPageSetup(file.page);
  loading = false;
  dirty = false;
  setPath(path);
  setSaveStatus(path ? savedLabel(path) : "");
  updateWordCount();
  scheduleOutline();
}

async function openPath(path: string) {
  if (!(await leaveUntitled())) return;
  try {
    loadFile(await invoke<NativeFile>("open_document", { path }), path);
    refreshRecent();
  } catch (e) {
    alert(String(e));
  }
}

async function openFile() {
  const path = await open({ multiple: false, filters: OPEN_FILTERS });
  if (typeof path === "string") await openPath(path);
}

async function saveFile() {
  if (currentPath) return writeFile(currentPath).catch((e) => alert(String(e)));
  return saveFileAs();
}

async function saveFileAs() {
  const path = await save({
    filters: SAVE_FILTERS,
    defaultPath: currentPath?.replace(/\.tmd$/i, ".docx") ?? `${suggestedName()}.docx`,
  });
  if (!path) return;
  try {
    await writeFile(path);
  } catch (e) {
    alert(String(e));
  }
}

/** Nom proposé : le premier titre (ou la première ligne) du document. */
function suggestedName() {
  const first = editor.state.doc.firstChild?.textContent.trim() ?? "";
  return first.replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "Sans titre";
}

/** Termine un enregistrement automatique en attente avant de changer de document. */
async function flush() {
  window.clearTimeout(autosaveTimer);
  await autosave();
}

/**
 * Avant de quitter un document sans titre qui contient du texte, propose de
 * l'enregistrer (sinon il serait remplacé par le suivant dans le brouillon).
 * Renvoie `false` si l'utilisateur annule.
 */
async function leaveUntitled(): Promise<boolean> {
  await flush();
  if (currentPath || !editor.getText().trim()) return true;
  const keep = await ask("Ce document n'a pas encore de nom. Voulez-vous l'enregistrer ?", {
    title: "Text Machine",
    kind: "warning",
    okLabel: "Enregistrer…",
    cancelLabel: "Ne pas enregistrer",
  });
  if (!keep) return true;
  await saveFileAs();
  return currentPath !== null;
}

async function newFile() {
  if (!(await leaveUntitled())) return;
  const empty: NativeFile = {
    document: { type: "doc", content: [{ type: "paragraph" }] },
    page: structuredClone(DEFAULT_PAGE_SETUP),
  };
  loadFile(empty, null);
  await invoke("forget_last_file").catch(() => {});
  await invoke("save_draft", { doc: empty.document, page: empty.page }).catch(() => {});
  editor.commands.focus();
}

// --- Impression, PDF, export et import -------------------------------------

/** Impression du système ; sur Mac, « PDF > Enregistrer au format PDF ». */
async function printDocument() {
  try {
    await invoke("print_document");
  } catch {
    window.print();
  }
}

const EXPORTS: Record<"docx" | "md" | "txt", { name: string; extensions: string[] }> = {
  docx: { name: "Document Word", extensions: ["docx"] },
  md: { name: "Markdown", extensions: ["md"] },
  txt: { name: "Texte brut", extensions: ["txt"] },
};

async function exportAs(kind: keyof typeof EXPORTS) {
  const filter = EXPORTS[kind];
  const path = await save({ filters: [filter], defaultPath: `${suggestedName()}.${filter.extensions[0]}` });
  if (!path) return;
  try {
    await invoke("export_document", { path, doc: editor.getJSON(), page: pageSetup });
  } catch (e) {
    alert(String(e));
  }
}

/**
 * Export PDF direct : choix du fichier, puis la page est écrite telle
 * qu'à l'écran. Si ce n'est pas possible (hors Mac), on passe par l'impression.
 */
async function exportPdf() {
  const path = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: `${suggestedName()}.pdf`,
  });
  if (!path) return;
  try {
    await invoke("export_pdf", { path, page: pageSetup });
    setSaveStatus(`PDF enregistré : ${fileName(path)}`);
  } catch (e) {
    alert(`${e}\nLa fenêtre d'impression va s'ouvrir : choisissez « Enregistrer au format PDF ».`);
    printDocument();
  }
}

const exportMenu = document.querySelector<HTMLElement>("#export-menu")!;
exportMenu.addEventListener("click", (event) => {
  const kind = (event.target as HTMLElement).closest("button")?.dataset.export;
  exportMenu.hidden = true;
  if (kind === "pdf") exportPdf();
  else if (kind === "print") printDocument();
  else if (kind === "docx" || kind === "md" || kind === "txt") exportAs(kind);
});

// Fichiers récents : un petit menu sous le bouton.
const recentMenu = document.querySelector<HTMLElement>("#recent-menu")!;

async function refreshRecent() {
  const session = await invoke<Session>("load_session").catch(() => null);
  const items = (session?.recent ?? []).map((path) => {
    const button = document.createElement("button");
    button.textContent = fileName(path);
    button.title = path;
    button.addEventListener("click", () => {
      recentMenu.hidden = true;
      openPath(path);
    });
    return button;
  });
  if (!items.length) {
    const empty = document.createElement("span");
    empty.className = "empty";
    empty.textContent = "Aucun fichier récent";
    items.push(empty as HTMLButtonElement);
  }
  recentMenu.replaceChildren(...items);
}

function toggleRecent() {
  recentMenu.hidden = !recentMenu.hidden;
  if (!recentMenu.hidden) refreshRecent();
}

document.addEventListener("mousedown", (event) => {
  const target = event.target as HTMLElement;
  if (!recentMenu.hidden && !target.closest("#recent-menu, [data-action=recent]")) {
    recentMenu.hidden = true;
  }
  if (!exportMenu.hidden && !target.closest("#export-menu, [data-action=export]")) {
    exportMenu.hidden = true;
  }
});

/** Au lancement : on rouvre le dernier fichier, ou le brouillon. */
async function restoreSession() {
  try {
    const session = await invoke<Session>("load_session");
    if (session.lastFile) return await openPath(session.lastFile);
    const draft = await invoke<NativeFile | null>("load_draft");
    if (draft) loadFile(draft, null);
  } catch {
    // Pas de session (premier lancement) : on garde le document d'accueil.
  }
}

// Fermeture de la fenêtre : on enregistre ce qui ne l'est pas encore.
window.addEventListener("beforeunload", () => {
  if (dirty) autosave();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});

// --- Barre d'outils ---------------------------------------------------------

const toolbar = document.querySelector<HTMLElement>("#toolbar")!;
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const blockSelect = $<HTMLSelectElement>("#block-style");
const fontFamilySelect = $<HTMLSelectElement>("#font-family");
const fontSizeSelect = $<HTMLSelectElement>("#font-size");
const lineHeightSelect = $<HTMLSelectElement>("#line-height");
const textColor = $<HTMLInputElement>("#text-color");
const highlightColor = $<HTMLInputElement>("#highlight-color");
const linkDialog = $<HTMLDialogElement>("#link-dialog");
const linkUrl = $<HTMLInputElement>("#link-url");

const chain = () => editor.chain().focus();

const actions: Record<string, () => unknown> = {
  new: newFile,
  open: openFile,
  recent: toggleRecent,
  export: () => (exportMenu.hidden = !exportMenu.hidden),
  save: saveFile,
  undo: () => chain().undo().run(),
  redo: () => chain().redo().run(),
  bold: () => chain().toggleBold().run(),
  italic: () => chain().toggleItalic().run(),
  underline: () => chain().toggleUnderline().run(),
  strike: () => chain().toggleStrike().run(),
  superscript: () => chain().unsetSubscript().toggleSuperscript().run(),
  subscript: () => chain().unsetSuperscript().toggleSubscript().run(),
  link: openLinkDialog,
  clearFormat: () => chain().unsetAllMarks().unsetTextAlign().setBlockLineHeight(null).run(),
  alignLeft: () => chain().setTextAlign("left").run(),
  alignCenter: () => chain().setTextAlign("center").run(),
  alignRight: () => chain().setTextAlign("right").run(),
  alignJustify: () => chain().setTextAlign("justify").run(),
  indent: () => chain().indent().run(),
  outdent: () => chain().outdent().run(),
  bulletList: () => chain().toggleBulletList().run(),
  orderedList: () => chain().toggleOrderedList().run(),
  taskList: () => chain().toggleTaskList().run(),
  blockquote: () => chain().toggleBlockquote().run(),
  image: () => imageInput.click(),
  table: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  rowBefore: () => chain().addRowBefore().run(),
  rowAfter: () => chain().addRowAfter().run(),
  colBefore: () => chain().addColumnBefore().run(),
  colAfter: () => chain().addColumnAfter().run(),
  deleteRow: () => chain().deleteRow().run(),
  deleteCol: () => chain().deleteColumn().run(),
  toggleHeaderRow: () => chain().toggleHeaderRow().run(),
  deleteTable: () => chain().deleteTable().run(),
  pageBreak: () => chain().setPageBreak().run(),
  outline: toggleOutline,
  find: openFind,
  spellcheck: toggleSpellcheck,
  pageSetup: openPageDialog,
};

// Mise en page : format, orientation, marges (affichées en cm), numéros.
const pageDialog = $<HTMLDialogElement>("#page-dialog");
const pageForm = pageDialog.querySelector("form")!;
const field = (name: string) => pageForm.elements.namedItem(name) as HTMLInputElement;
const SIDES = ["top", "bottom", "left", "right"] as const;

function openPageDialog() {
  field("size").value = pageSetup.size;
  for (const radio of pageForm.querySelectorAll<HTMLInputElement>('[name="orientation"]')) {
    radio.checked = radio.value === (pageSetup.landscape ? "landscape" : "portrait");
  }
  for (const side of SIDES) field(side).value = String(+(pageSetup.margins[side] / 10).toFixed(2));
  field("pageNumbers").checked = pageSetup.pageNumbers;
  pageDialog.returnValue = "";
  pageDialog.showModal();
}

pageDialog.addEventListener("close", () => {
  setTimeout(() => editor.commands.focus());
  if (pageDialog.returnValue !== "ok") return;
  const cm = (side: (typeof SIDES)[number]) => {
    const value = parseFloat(field(side).value.replace(",", "."));
    // Marges entre 0 et 10 cm ; une case vide ou illisible garde l'ancienne valeur.
    return Number.isFinite(value) ? Math.min(100, Math.max(0, value * 10)) : pageSetup.margins[side];
  };
  setPageSetup({
    size: field("size").value as PageSetup["size"],
    landscape:
      pageForm.querySelector<HTMLInputElement>('[name="orientation"]:checked')?.value === "landscape",
    margins: { top: cm("top"), bottom: cm("bottom"), left: cm("left"), right: cm("right") },
    pageNumbers: field("pageNumbers").checked,
  });
});

const imageInput = $<HTMLInputElement>("#image-file");
const tableTools = $<HTMLElement>("#table-tools");
imageInput.addEventListener("change", () => {
  const file = imageInput.files?.[0];
  if (file) insertImageFile(file);
  imageInput.value = "";
});

// Les boutons ne prennent pas le focus : le curseur reste dans le texte.
toolbar.addEventListener("mousedown", (event) => {
  if ((event.target as HTMLElement).closest("button")) event.preventDefault();
});

toolbar.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  const action = button?.dataset.action;
  if (action && actions[action]) actions[action]();
});

blockSelect.addEventListener("change", () => {
  const value = blockSelect.value;
  if (value === "p") chain().setParagraph().run();
  else chain().setHeading({ level: Number(value) as 1 | 2 | 3 | 4 }).run();
});

fontFamilySelect.addEventListener("change", () => {
  const font = fontFamilySelect.value;
  if (font) chain().setFontFamily(font).run();
  else chain().unsetFontFamily().run();
});

fontSizeSelect.addEventListener("change", () => {
  const size = fontSizeSelect.value;
  if (size) chain().setFontSize(`${size}pt`).run();
  else chain().unsetFontSize().run();
});

lineHeightSelect.addEventListener("change", () => {
  chain().setBlockLineHeight(lineHeightSelect.value || null).run();
});

textColor.addEventListener("change", () => chain().setColor(textColor.value).run());
highlightColor.addEventListener("change", () =>
  chain().setHighlight({ color: highlightColor.value }).run(),
);

// Liens : une petite fenêtre pour saisir l'adresse.
function openLinkDialog() {
  linkUrl.value = editor.getAttributes("link").href ?? "";
  linkDialog.returnValue = "";
  linkDialog.showModal();
  linkUrl.select();
}

// Le navigateur rend le focus au bouton après la fermeture : on attend
// qu'il l'ait fait avant de revenir dans le texte.
linkDialog.addEventListener("close", () => setTimeout(applyLinkDialog));

function applyLinkDialog() {
  const choice = linkDialog.returnValue;
  let href = linkUrl.value.trim();
  // « exemple.fr » devient « https://exemple.fr » ; mailto:, tel:… restent tels quels.
  if (href && !/^[a-z][a-z0-9+.-]*:/i.test(href)) href = `https://${href}`;
  if (choice === "remove") {
    chain().extendMarkRange("link").unsetLink().run();
  } else if (choice === "ok" && href) {
    const { empty } = editor.state.selection;
    if (empty && !editor.isActive("link")) {
      chain()
        .insertContent({ type: "text", text: href, marks: [{ type: "link", attrs: { href } }] })
        .unsetMark("link")
        .run();
    } else {
      chain().extendMarkRange("link").setLink({ href }).run();
    }
  } else {
    editor.commands.focus();
  }
}

const TOGGLES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "superscript",
  "subscript",
  "link",
  "bulletList",
  "orderedList",
  "taskList",
  "blockquote",
];

function refreshToolbar() {
  for (const name of TOGGLES) {
    toolbar
      .querySelector(`[data-action="${name}"]`)
      ?.classList.toggle("active", editor.isActive(name));
  }
  for (const align of ["left", "center", "right", "justify"]) {
    const name = `align${align[0].toUpperCase()}${align.slice(1)}`;
    toolbar
      .querySelector(`[data-action="${name}"]`)
      ?.classList.toggle("active", editor.isActive({ textAlign: align }));
  }
  tableTools.hidden = !editor.isActive("table");

  const level = [1, 2, 3, 4].find((l) => editor.isActive("heading", { level: l }));
  blockSelect.value = level ? String(level) : "p";

  const style = editor.getAttributes("textStyle");
  fontFamilySelect.value = style.fontFamily ?? "";
  fontSizeSelect.value = style.fontSize ? String(parseFloat(style.fontSize)) : "";
  if (fontSizeSelect.selectedIndex < 0) fontSizeSelect.value = "";

  const block = editor.isActive("heading")
    ? editor.getAttributes("heading")
    : editor.getAttributes("paragraph");
  lineHeightSelect.value = block.lineHeight ?? "";
  if (lineHeightSelect.selectedIndex < 0) lineHeightSelect.value = "";
}

window.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (event.shiftKey) saveFileAs();
    else saveFile();
  } else if (event.key === "p") {
    event.preventDefault();
    printDocument();
  } else if (event.key === "n") {
    event.preventDefault();
    newFile();
  } else if (event.key === "o") {
    event.preventDefault();
    openFile();
  } else if (event.key === "f") {
    event.preventDefault();
    openFind();
  } else if (event.key === "O" && event.shiftKey) {
    event.preventDefault();
    toggleOutline();
  } else if (event.key === "k") {
    event.preventDefault();
    openLinkDialog();
  } else if (event.key === "\\") {
    event.preventDefault();
    actions.clearFormat();
  }
});

refreshToolbar();
toolbar.querySelector('[data-action="spellcheck"]')?.classList.add("active");
updateWordCount();
restoreSession();

// En développement, l'éditeur est accessible depuis la console (`editor`).
if (import.meta.env.DEV) (window as unknown as { editor: Editor }).editor = editor;
