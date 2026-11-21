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
import { ParagraphFormat } from "./extensions/paragraph-format";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

const FILTERS = [{ name: "Document Text Machine", extensions: ["tmd"] }];

let currentPath: string | null = null;
let pageSetup: PageSetup = structuredClone(DEFAULT_PAGE_SETUP);
let pageGap = SCREEN_GAP_PX;

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
    Pagination.configure({
      getSetup: () => pageSetup,
      getGap: () => pageGap,
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
  onUpdate: () => scheduleWordCount(),
  onSelectionUpdate: () => refreshToolbar(),
  onTransaction: () => refreshToolbar(),
});

// --- Pages -----------------------------------------------------------------

const paper = document.querySelector<HTMLElement>("#paper")!;
const sheets = document.querySelector<HTMLElement>("#sheets")!;

/** Applique le format de page : taille de la feuille et marges. */
function applyPageSetup() {
  const { width, height } = pageSizePx(pageSetup);
  const m = pageSetup.margins;
  paper.style.setProperty("--page-w", `${width}px`);
  paper.style.setProperty("--page-h", `${height}px`);
  paper.style.setProperty("--page-gap", `${pageGap}px`);
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
  const { height } = pageSizePx(pageSetup);
  paper.style.setProperty("--pages", String(pages));
  sheets.replaceChildren(
    ...Array.from({ length: pages }, (_, i) => {
      const sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.style.top = `${i * (height + pageGap)}px`;
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

function setPath(path: string | null) {
  currentPath = path;
  const name = path ? path.split(/[\\/]/).pop()! : "Sans titre";
  document.querySelector("#file-name")!.textContent = name;
  document.title = `${name} — Text Machine`;
}

async function openFile() {
  const path = await open({ multiple: false, filters: FILTERS });
  if (typeof path !== "string") return;
  try {
    const file = await invoke<{ document: JSONContent; page: PageSetup }>("open_document", {
      path,
    });
    editor.commands.setContent(file.document);
    setPageSetup(file.page);
    setPath(path);
    updateWordCount();
  } catch (e) {
    alert(String(e));
  }
}

async function saveFile() {
  let path = currentPath;
  if (!path) {
    path = await save({ filters: FILTERS, defaultPath: "Sans titre.tmd" });
    if (!path) return;
  }
  try {
    await invoke("save_document", { path, doc: editor.getJSON(), page: pageSetup });
    setPath(path);
  } catch (e) {
    alert(String(e));
  }
}

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
  open: openFile,
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
  pageDialog.showModal();
}

pageDialog.addEventListener("close", () => {
  setTimeout(() => editor.commands.focus());
  if (pageDialog.returnValue !== "ok") return;
  const cm = (side: (typeof SIDES)[number]) => {
    const value = parseFloat(field(side).value.replace(",", "."));
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
  linkDialog.showModal();
  linkUrl.select();
}

// Le navigateur rend le focus au bouton après la fermeture : on attend
// qu'il l'ait fait avant de revenir dans le texte.
linkDialog.addEventListener("close", () => setTimeout(applyLinkDialog));

function applyLinkDialog() {
  const choice = linkDialog.returnValue;
  const href = linkUrl.value.trim();
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
  if (event.key === "s") {
    event.preventDefault();
    saveFile();
  } else if (event.key === "o") {
    event.preventDefault();
    openFile();
  } else if (event.key === "k") {
    event.preventDefault();
    openLinkDialog();
  } else if (event.key === "\\") {
    event.preventDefault();
    actions.clearFormat();
  }
});

refreshToolbar();
updateWordCount();

// En développement, l'éditeur est accessible depuis la console (`editor`).
if (import.meta.env.DEV) (window as unknown as { editor: Editor }).editor = editor;
