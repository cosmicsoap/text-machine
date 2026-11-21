// Éditeur web : TipTap s'occupe de la saisie et de l'affichage, le cœur
// Rust (via les commandes Tauri) s'occupe du document, des fichiers et des
// calculs comme le nombre de mots.

import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

const FILTERS = [{ name: "Document Text Machine", extensions: ["tmd"] }];

let currentPath: string | null = null;

const editor = new Editor({
  element: document.querySelector<HTMLElement>("#editor")!,
  extensions: [StarterKit],
  content: "<h1>Bienvenue dans Text Machine</h1><p>Commencez à écrire ici.</p>",
  autofocus: "end",
  onUpdate: () => scheduleWordCount(),
  onSelectionUpdate: () => refreshToolbar(),
  onTransaction: () => refreshToolbar(),
});

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
    const doc = await invoke<JSONContent>("open_document", { path });
    editor.commands.setContent(doc);
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
    await invoke("save_document", { path, doc: editor.getJSON() });
    setPath(path);
  } catch (e) {
    alert(String(e));
  }
}

// --- Barre d'outils ---------------------------------------------------------

const toolbar = document.querySelector<HTMLElement>("#toolbar")!;
const blockSelect = toolbar.querySelector<HTMLSelectElement>("select")!;

const actions: Record<string, () => unknown> = {
  open: openFile,
  save: saveFile,
  undo: () => editor.chain().focus().undo().run(),
  redo: () => editor.chain().focus().redo().run(),
  bold: () => editor.chain().focus().toggleBold().run(),
  italic: () => editor.chain().focus().toggleItalic().run(),
  underline: () => editor.chain().focus().toggleUnderline().run(),
  strike: () => editor.chain().focus().toggleStrike().run(),
  bulletList: () => editor.chain().focus().toggleBulletList().run(),
  orderedList: () => editor.chain().focus().toggleOrderedList().run(),
  blockquote: () => editor.chain().focus().toggleBlockquote().run(),
};

toolbar.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest("button");
  const action = button?.dataset.action;
  if (action && actions[action]) actions[action]();
});

blockSelect.addEventListener("change", () => {
  const value = blockSelect.value;
  const chain = editor.chain().focus();
  if (value === "p") chain.setParagraph().run();
  else chain.setHeading({ level: Number(value) as 1 | 2 | 3 }).run();
});

const MARKS = ["bold", "italic", "underline", "strike", "bulletList", "orderedList", "blockquote"];

function refreshToolbar() {
  for (const name of MARKS) {
    toolbar
      .querySelector(`[data-action="${name}"]`)
      ?.classList.toggle("active", editor.isActive(name));
  }
  const level = [1, 2, 3].find((l) => editor.isActive("heading", { level: l }));
  blockSelect.value = level ? String(level) : "p";
}

window.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key === "s") {
    event.preventDefault();
    saveFile();
  } else if (event.key === "o") {
    event.preventDefault();
    openFile();
  }
});

refreshToolbar();
updateWordCount();
