// Éditeur web : TipTap s'occupe de la saisie et de l'affichage, le cœur
// Rust (via les commandes Tauri) s'occupe du document, des fichiers et des
// calculs comme le nombre de mots.
//
// L'interface s'inspire de Google Docs : menus, barre d'outils arrondie,
// panneau des onglets et du plan à gauche, pages au centre.

import { Editor, createDocument, type JSONContent } from "@tiptap/core";
import FileHandler from "@tiptap/extension-file-handler";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import {
  DEFAULT_PAGE_SETUP,
  Pagination,
  SCREEN_GAP_PX,
  mmToPx,
  pageSizePx,
  refreshPagination,
  type PageSetup,
} from "./extensions/pagination";
import { Search, getSearchState } from "./extensions/search";
import { documentExtensions } from "./schema";
import { collectNotes } from "./extensions/footnote";
import { refreshTocs } from "./extensions/toc";
import { Suggestions, changeAt, listChanges } from "./extensions/suggestions";
import { NotesView } from "./notes";
import { CommentsView } from "./comments";
import { CommentFocus } from "./extensions/comments";
import { FocusParagraph } from "./extensions/focus-paragraph";
import { FocusMode, toggleFullscreen, isFullscreen } from "./focus";
import { CompareView } from "./compare";
import { choiceLabel, facesOf, initFonts, onFontsChange, openFontPicker, type FontChoice } from "./fonts";
import { MAX_TAB_LEVEL, TabTree, type TabData, type TabNode } from "./tabs";
import {
  DEFAULT_STYLES,
  STYLE_KEYS,
  STYLE_LEVEL,
  customId,
  customRef,
  findCustom,
  fontOf,
  getStyle,
  newStyleId,
  styleName,
  normalizeStyles,
  previewCss,
  styleOfLevel,
  stylesToCss,
  weightOf,
  WEIGHT_NAMES,
  type CustomStyle,
  type ParagraphStyle,
  type StyleKey,
  type StyleRef,
  type StyleSheet,
} from "./stylesheet";
import { ICONS } from "./icons";
import { SEP, closeMenus, popup, setupMenubar, type MenuItem } from "./menus";
import { checkForUpdates } from "./updates";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { localizeShortcutTitles } from "./platform";
import { MarginsView } from "./headers";
import { setupToolbarOverflow } from "./toolbar-overflow";

/** Formats que l'application ouvre et enregistre directement. */
const OPEN_FILTERS = [
  { name: "Documents", extensions: ["docx", "md", "markdown", "txt", "tmd"] },
];
const SAVE_FILTERS = [
  { name: "Document Word", extensions: ["docx"] },
  { name: "Markdown", extensions: ["md"] },
  { name: "Texte brut", extensions: ["txt"] },
];

/**
 * Sous Windows, si l'on retape le nom dans la fenêtre « Enregistrer », le
 * fichier peut revenir sans extension : Windows ne sait alors plus avec
 * quoi l'ouvrir. On ajoute l'extension attendue quand elle manque.
 */
function withExtension(path: string, ext: string, known: string[] = [ext]): string {
  const current = path.match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase();
  return current && known.includes(current) ? path : `${path}.${ext}`;
}

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;

/** Préférences de l'interface (pas du document), gardées par la fenêtre. */
const prefs = {
  get(key: string, fallback: string) {
    try {
      return localStorage.getItem(`tm.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`tm.${key}`, value);
    } catch {
      /* pas grave */
    }
  },
};

let currentPath: string | null = null;

/**
 * Dossier où s'ouvrent « Enregistrer sous », les exports et « Ouvrir »
 * (vide : celui que propose le système, souvent le dernier utilisé).
 */
const saveFolder = () => prefs.get("saveFolder", "");

/** Chemin proposé pour un nouveau fichier : dans le dossier choisi, s'il y en a un. */
function inSaveFolder(name: string) {
  const dir = saveFolder();
  if (!dir) return name;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}
let pageSetup: PageSetup = structuredClone(DEFAULT_PAGE_SETUP);
let styles: StyleSheet = structuredClone(DEFAULT_STYLES);
/** Styles des nouveaux documents (« Enregistrer comme styles par défaut »). */
let defaultStyles: StyleSheet | null = null;
/** Pendant un export PDF ou une impression d'un document sans pagination. */
let forcePaged = false;
/** Pendant un export PDF : l'éditeur montre un document temporaire. */
let busy = false;

// Icônes : chaque `data-icon` reçoit son dessin.
for (const el of document.querySelectorAll<HTMLElement>("[data-icon]")) {
  el.insertAdjacentHTML("afterbegin", ICONS[el.dataset.icon!] ?? "");
}

/** Mode suggestion : les modifications sont proposées, pas appliquées. */
let suggesting = false;
/** Nom affiché sur les suggestions. */
let authorName = prefs.get("author", "Moi");
/** Niveau de révision des nouvelles suggestions (couleurs, comme Scrivener). */
let revisionLevel = Number(prefs.get("revisionLevel", "1")) || 1;
let notesView: NotesView | null = null;
let marginsView: MarginsView | null = null;
let compare: CompareView | null = null;
let commentsView: CommentsView | null = null;
let focusMode: FocusMode | null = null;

/** Numéro de page d'une position (tables des matières), null sans pages. */
function pageOf(ed: Editor, pos: number): number | null {
  if (isPageless()) return null;
  const dom = ed.view.nodeDOM(pos) as HTMLElement | null;
  if (!dom?.getBoundingClientRect) return null;
  const { width, height } = pageSizePx(pageSetup);
  const paperRect = paper.getBoundingClientRect();
  const scale = paperRect.width > 0 ? paperRect.width / width : 1;
  const top = (dom.getBoundingClientRect().top - paperRect.top) / scale;
  return Math.max(1, Math.floor(top / (height + SCREEN_GAP_PX)) + 1);
}

const editor = new Editor({
  element: $("#editor"),
  extensions: [
    ...documentExtensions({ pageOf }),
    Suggestions.configure({ isOn: () => suggesting, author: () => authorName, level: () => revisionLevel }),
    CommentFocus,
    FocusParagraph.configure({ isOn: () => !!focusMode?.on && focusMode.paragraph }),
    Search,
    Pagination.configure({
      getSetup: () =>
        forcePaged ? { ...pageSetup, pageless: false } : focusMode?.on ? { ...pageSetup, pageless: true } : pageSetup,
      onLayout: (pages, notePages) => {
        drawSheets(pages);
        commentsView?.schedule();
        notesView?.setPages(notePages);
        refreshTocs();
      },
      noteHeight: (content, index) => notesView?.height(content, index) ?? 0,
    }),
    // Images collées (⌘V) ou glissées dans la page.
    FileHandler.configure({
      allowedMimeTypes: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"],
      onPaste: (ed, files) => files.forEach((f) => insertImageFile(f, ed.state.selection.from)),
      onDrop: (_ed, files, pos) => files.forEach((f) => insertImageFile(f, pos)),
    }),
  ],
  content:
    "<h1>Bienvenue dans Text Machine</h1><p>Commencez à écrire ici. Les onglets du document sont dans le panneau de gauche.</p>",
  autofocus: "end",
  // Correcteur orthographique du système (macOS), en français.
  editorProps: { attributes: { spellcheck: "true", lang: "fr" } },
  onUpdate: () => {
    if (busy) return;
    markDirty();
    scheduleCounts();
    schedulePanel();
    compare?.schedule();
  },
  onSelectionUpdate: () => {
    refreshToolbar();
    scheduleCounts();
  },
  onTransaction: () => {
    refreshToolbar();
    refreshChangeBubble();
    focusMode?.update();
  },
  onBlur: () => window.setTimeout(refreshChangeBubble, 0),
  onFocus: () => refreshChangeBubble(),
});

const chain = () => editor.chain().focus();

// --- Onglets -------------------------------------------------------------------

const tabs = new TabTree(
  editor,
  () => {
    // Un autre onglet est affiché.
    closeFind();
    refreshToolbar();
    renderPanel();
    updateCounts();
    $("#desk").scrollTop = 0;
    compare?.showTab();
    commentsView?.schedule();
  },
  () => {
    markDirty();
    renderPanel();
  },
);
// --- Panneau de gauche : onglets et plan ------------------------------------------

const sidePanel = $<HTMLElement>("#side-panel");
const panelShow = $<HTMLButtonElement>("#panel-show");
const tabTree = $<HTMLUListElement>("#tab-tree");
let panelTimer: number | undefined;

function schedulePanel() {
  window.clearTimeout(panelTimer);
  panelTimer = window.setTimeout(renderPanel, 250);
}

/** Panneau masqué tout seul parce que la fenêtre est étroite (voir fitPanel). */
let panelAutoHidden = false;

function setPanelVisible(visible: boolean) {
  panelAutoHidden = false;
  sidePanel.hidden = !visible;
  panelShow.hidden = visible;
  prefs.set("panel", visible ? "1" : "0");
  if (visible) renderPanel();
}

/** Les titres de l'onglet ouvert, affichés sous lui comme dans Google Docs. */
function outlineItems(): HTMLLIElement[] {
  const items: HTMLLIElement[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true;
    const li = document.createElement("li");
    li.className = `outline-item level-${node.attrs.level}`;
    li.textContent = node.textContent || "(titre vide)";
    li.title = li.textContent;
    li.addEventListener("click", () => {
      editor.chain().focus().setTextSelection(pos + 1).run();
      (editor.view.nodeDOM(pos) as HTMLElement | null)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
    items.push(li);
    return false;
  });
  return items;
}

/** Onglet en cours de glisser-déposer. */
let draggedTab: string | null = null;

function clearDropMarks() {
  for (const el of tabTree.querySelectorAll(".drop-before, .drop-after, .drop-inside")) {
    el.classList.remove("drop-before", "drop-after", "drop-inside");
  }
}

function tabRow(node: TabNode, depth: number): HTMLLIElement {
  const li = document.createElement("li");
  li.setAttribute("role", "treeitem");
  const row = document.createElement("div");
  row.className = "tab-row";
  row.classList.toggle("active", node.id === tabs.activeId);
  row.style.paddingLeft = `${8 + depth * 16}px`;
  row.title = node.title;

  const caret = document.createElement("button");
  caret.className = "caret";
  caret.type = "button";
  caret.innerHTML = ICONS.caret;
  caret.classList.toggle("open", node.expanded);
  caret.style.visibility = node.children.length ? "visible" : "hidden";
  caret.title = node.expanded ? "Masquer les sous-onglets" : "Afficher les sous-onglets";
  caret.addEventListener("click", (e) => {
    e.stopPropagation();
    node.expanded = !node.expanded;
    renderPanel();
  });

  const icon = document.createElement("span");
  icon.className = "tab-icon";
  icon.innerHTML = ICONS.tab;
  const title = document.createElement("span");
  title.className = "tab-title";
  title.textContent = node.title;

  const more = document.createElement("button");
  more.className = "more";
  more.type = "button";
  more.title = "Options de l'onglet";
  more.innerHTML = ICONS.more;
  more.addEventListener("click", (e) => {
    e.stopPropagation();
    popup(more, tabMenu(node, depth), { align: "left" });
  });

  row.append(caret, icon, title, more);
  row.addEventListener("click", () => {
    tabs.activate(node.id);
    editor.commands.focus();
  });
  row.addEventListener("dblclick", () => renameTab(node));

  // Glisser-déposer : en haut de la ligne = avant, en bas = après, au
  // milieu = comme sous-onglet (comme le classeur de Scrivener).
  row.draggable = true;
  row.addEventListener("dragstart", (e) => {
    draggedTab = node.id;
    e.dataTransfer?.setData("text/plain", node.title);
    if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => {
    draggedTab = null;
    row.classList.remove("dragging");
    clearDropMarks();
  });
  const zone = (e: DragEvent): "before" | "after" | "inside" | null => {
    if (!draggedTab) return null;
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    const wanted = y < 0.3 ? "before" : y > 0.7 ? "after" : "inside";
    if (tabs.canMoveTo(draggedTab, node.id, wanted)) return wanted;
    // Trop profond pour « dans » : on se rabat sur avant / après.
    const fallback = y < 0.5 ? "before" : "after";
    return tabs.canMoveTo(draggedTab, node.id, fallback) ? fallback : null;
  };
  row.addEventListener("dragover", (e) => {
    const where = zone(e);
    if (!where) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    clearDropMarks();
    row.classList.add(`drop-${where}`);
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-before", "drop-after", "drop-inside"));
  row.addEventListener("drop", (e) => {
    const where = zone(e);
    const id = draggedTab;
    clearDropMarks();
    if (!where || !id) return;
    e.preventDefault();
    e.stopPropagation();
    if (tabs.moveTo(id, node.id, where)) setSaveStatus("Onglet déplacé : l'ordre du document suit celui du panneau");
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    popup(more, tabMenu(node, depth));
  });
  li.append(row);

  if (node.id === tabs.activeId) {
    const outline = document.createElement("ul");
    outline.className = "outline";
    outline.style.paddingLeft = `${30 + depth * 16}px`;
    const items = outlineItems();
    if (items.length) outline.append(...items);
    else {
      const empty = document.createElement("li");
      empty.className = "outline-empty";
      empty.textContent = "Les titres ajoutés au document s'afficheront ici.";
      outline.append(empty);
    }
    li.append(outline);
  }
  if (node.children.length && node.expanded) {
    const sub = document.createElement("ul");
    sub.setAttribute("role", "group");
    sub.append(...node.children.map((c) => tabRow(c, depth + 1)));
    li.append(sub);
  }
  return li;
}

function renderPanel() {
  if (sidePanel.hidden) return;
  tabTree.replaceChildren(...tabs.roots.map((n) => tabRow(n, 0)));
}

function tabMenu(node: TabNode, depth: number): MenuItem[] {
  const onlyOne = tabs.roots.length === 1 && tabs.roots[0] === node;
  return [
    { label: "Renommer", action: () => renameTab(node) },
    {
      label: "Ajouter un sous-onglet",
      disabled: depth >= MAX_TAB_LEVEL - 1,
      action: () => tabs.add({ parentId: node.id }),
    },
    { label: "Dupliquer", action: () => tabs.duplicate(node.id) },
    SEP,
    { label: "Monter", action: () => tabs.move(node.id, -1) },
    { label: "Descendre", action: () => tabs.move(node.id, 1) },
    {
      label: "Mettre en sous-onglet de l'onglet du dessus",
      disabled: !tabs.canIndent(node.id),
      action: () => tabs.indent(node.id),
    },
    { label: "Remonter d'un niveau", disabled: depth === 0, action: () => tabs.outdent(node.id) },
    SEP,
    { label: "Supprimer", disabled: onlyOne, action: () => deleteTab(node) },
  ];
}

const renameDialog = $<HTMLDialogElement>("#rename-dialog");
const renameInput = $<HTMLInputElement>("#rename-input");
let renaming: TabNode | null = null;

function renameTab(node: TabNode) {
  renaming = node;
  renameInput.value = node.title;
  renameDialog.returnValue = "";
  renameDialog.showModal();
  renameInput.select();
}

renameDialog.addEventListener("close", () => {
  if (renameDialog.returnValue === "ok" && renaming) tabs.rename(renaming.id, renameInput.value);
  renaming = null;
  setTimeout(() => editor.commands.focus());
});

async function deleteTab(node: TabNode) {
  const sub = node.children.length ? " et ses sous-onglets" : "";
  const ok = await confirmDialog(`Supprimer l'onglet « ${node.title} »${sub} ? Son contenu sera perdu.`, "Supprimer");
  if (ok) tabs.remove(node.id);
}

async function confirmDialog(message: string, okLabel: string) {
  try {
    return await ask(message, { title: "Text Machine", kind: "warning", okLabel, cancelLabel: "Annuler" });
  } catch {
    return window.confirm(message);
  }
}

sidePanel.addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest<HTMLElement>("[data-panel]")?.dataset.panel;
  if (action === "hide") setPanelVisible(false);
  else if (action === "add") tabs.add();
});
panelShow.addEventListener("click", () => setPanelVisible(true));

// --- Feuille de styles -------------------------------------------------------------

const styleElement = document.head.appendChild(document.createElement("style"));

function setStyles(next: StyleSheet, dirty = true) {
  styles = normalizeStyles(next);
  styleElement.textContent = stylesToCss(styles) + "\n" + stylesToCss(styles, "#compare-editor .tiptap");
  // Les notes de bas de page prennent la police du texte normal.
  document.documentElement.style.setProperty("--tm-font", getComputedStyle(editor.view.dom).fontFamily);
  notesView?.invalidate();
  renderStyleSelect();
  if (dirty) markDirty();
  refreshToolbar();
  // Les hauteurs changent : on recalcule les pages.
  refreshPagination(editor.view);
}

/** Style du paragraphe où se trouve le curseur. */
function currentStyleKey(): StyleRef {
  const level = [1, 2, 3, 4].find((l) => editor.isActive("heading", { level: l }));
  if (level) return styleOfLevel(level);
  const custom = editor.getAttributes("paragraph").customStyle;
  return custom && styles.custom.some((c) => c.id === custom && c.kind === "paragraph") ? customRef(custom) : "normal";
}

/** Style de caractère du texte au curseur. */
function currentCharStyle(): string | null {
  return editor.getAttributes("charStyle").id ?? null;
}

function applyStyle(ref: StyleRef) {
  const custom = findCustom(styles, ref);
  if (custom?.kind === "character") {
    if (currentCharStyle() === custom.id) chain().unsetCharStyle().run();
    else chain().setCharStyle(custom.id).run();
    return;
  }
  if (custom) return void chain().setCustomParagraphStyle(custom.id).run();
  const level = STYLE_LEVEL[ref as StyleKey];
  if (level === 0) chain().setCustomParagraphStyle(null).run();
  else chain().setHeading({ level: level as 1 | 2 | 3 | 4 }).run();
}

/** Remplace un style de la feuille (intégré ou créé par l'utilisateur). */
function withStyle(sheet: StyleSheet, ref: StyleRef, style: ParagraphStyle): StyleSheet {
  const id = customId(ref);
  if (!id) return { ...sheet, [ref]: style };
  return { ...sheet, custom: sheet.custom.map((c) => (c.id === id ? { ...c, style } : c)) };
}

/** La mise en forme du texte au curseur, vue comme un style. */
function styleFromSelection(base: ParagraphStyle, withBlock: boolean): ParagraphStyle {
  const style = { ...base };
  const text = editor.getAttributes("textStyle");
  const block = blockAttrs();
  if (text.fontFamily) style.fontFamily = String(text.fontFamily).replace(/["']/g, "");
  if (text.fontSize) style.fontSize = parseFloat(text.fontSize) || style.fontSize;
  if (text.color) style.color = text.color;
  if (editor.isActive("bold")) style.bold = true;
  if (text.fontWeight) style.fontWeight = Number(text.fontWeight) || null;
  else if (editor.isActive("bold")) style.fontWeight = 700;
  if (editor.isActive("italic")) style.italic = true;
  if (editor.isActive("underline")) style.underline = true;
  if (editor.isActive("strike")) style.strike = true;
  if (editor.isActive("superscript")) style.verticalAlign = "super";
  if (editor.isActive("subscript")) style.verticalAlign = "sub";
  const mark = editor.getAttributes("highlight");
  if (editor.isActive("highlight")) style.highlight = mark.color || "#fff3a3";
  if (withBlock && block.lineHeight) style.lineHeight = parseFloat(block.lineHeight) || style.lineHeight;
  if (withBlock && block.textAlign && block.textAlign !== "left") style.textAlign = block.textAlign;
  return style;
}

/**
 * « Mettre à jour le style selon la sélection » : le style prend la mise en
 * forme du paragraphe où est le curseur, qui perd alors sa mise en forme
 * directe (elle vient maintenant du style).
 */
function updateStyleFromSelection() {
  const key = currentStyleKey();
  setStyles(withStyle(styles, key, styleFromSelection(getStyle(styles, key), true)));
  const { $from, from, to } = editor.state.selection;
  editor
    .chain()
    .focus()
    .setTextSelection({ from: $from.start(), to: $from.end() })
    .unsetFontFamily()
    .unsetFontSize()
    .setFontWeight(null)
    .unsetColor()
    .unsetBold()
    .unsetItalic()
    .unsetUnderline()
    .unsetStrike()
    .unsetHighlight()
    .unsetSuperscript()
    .unsetSubscript()
    .unsetTextAlign()
    .setBlockLineHeight(null)
    .setTextSelection({ from, to })
    .run();
  setSaveStatus(`Style « ${styleName(styles, key)} » mis à jour`);
}

/** Nouveau style, d'après la mise en forme du texte au curseur. */
function createStyle(kind: CustomStyle["kind"], openDialog = true) {
  const n = styles.custom.filter((c) => c.kind === kind).length + 1;
  const base = getStyle(styles, currentStyleKey());
  const style: ParagraphStyle =
    kind === "paragraph"
      ? styleFromSelection({ ...base }, true)
      : { ...styleFromSelection({ ...DEFAULT_STYLES.normal, fontFamily: null, fontSize: currentFontSize() }, false) };
  if (kind === "character" && !editor.getAttributes("textStyle").fontFamily) style.fontFamily = null;
  const custom: CustomStyle = {
    id: newStyleId(),
    name: kind === "paragraph" ? `Mon style ${n}` : `Style de caractère ${n}`,
    kind,
    style,
  };
  setStyles({ ...styles, custom: [...styles.custom, custom] });
  if (openDialog) {
    editingStyle = customRef(custom.id);
    renderStyleDialog();
    if (!stylesDialog.open) stylesDialog.showModal();
    styleField("name").select();
  }
  return custom;
}

async function deleteStyle(ref: StyleRef) {
  const custom = findCustom(styles, ref);
  if (!custom) return;
  const ok = await confirmDialog(
    `Supprimer le style « ${custom.name} » ? Le texte de ce style reprendra le style « Texte normal ».`,
    "Supprimer",
  );
  if (!ok) return;
  setStyles({ ...styles, custom: styles.custom.filter((c) => c.id !== custom.id) });
  editingStyle = "normal";
  if (stylesDialog.open) renderStyleDialog();
}

// Fenêtre « Styles ».
const stylesDialog = $<HTMLDialogElement>("#styles-dialog");
const styleList = $<HTMLUListElement>("#style-list");
const styleForm = $<HTMLElement>("#style-form");
let editingStyle: StyleRef = "normal";
const styleField = (name: string) => styleForm.querySelector<HTMLInputElement & HTMLSelectElement>(`[name="${name}"]`)!;

const styleFont = $<HTMLButtonElement>("#style-font");
const styleFontName = $<HTMLElement>("#style-font-name");
const styleFontInherit = $<HTMLButtonElement>("#style-font-inherit");

/** Les graisses proposées pour une police (celles qu'elle possède). */
function weightOptions(select: HTMLSelectElement, font: string, current: number) {
  const weights = new Set(facesOf(font).map((f) => f.weight));
  if (weights.size < 2) [400, 700].forEach((w) => weights.add(w));
  weights.add(current);
  select.replaceChildren(
    ...[...weights].sort((a, b) => a - b).map((w) => new Option(`${WEIGHT_NAMES[w] ?? w} (${w})`, String(w))),
  );
  select.value = String(current);
}

/** Tous les styles, dans l'ordre des listes : intégrés, puis créés. */
function allStyleRefs(): StyleRef[] {
  return [...STYLE_KEYS, ...styles.custom.map((c) => customRef(c.id))];
}

function renderStyleDialog() {
  const item = (ref: StyleRef) => {
    const li = document.createElement("li");
    li.textContent = styleName(styles, ref);
    li.setAttribute("style", previewCss(styles, ref));
    li.dataset.ref = ref;
    li.classList.toggle("active", ref === editingStyle);
    li.addEventListener("click", () => {
      editingStyle = ref;
      renderStyleDialog();
    });
    return li;
  };
  const heading = (text: string) => {
    const li = document.createElement("li");
    li.className = "style-group";
    li.textContent = text;
    return li;
  };
  const paras = styles.custom.filter((c) => c.kind === "paragraph").map((c) => customRef(c.id));
  const chars = styles.custom.filter((c) => c.kind === "character").map((c) => customRef(c.id));
  styleList.replaceChildren(
    heading("Styles de paragraphe"),
    ...[...STYLE_KEYS, ...paras].map(item),
    ...(chars.length ? [heading("Styles de caractère"), ...chars.map(item)] : []),
  );
  const custom = findCustom(styles, editingStyle);
  const character = custom?.kind === "character";
  const s = getStyle(styles, editingStyle);
  $("#style-name-row").hidden = !custom;
  styleField("name").value = custom?.name ?? "";
  $("#style-paragraph").hidden = character;
  $("#style-delete").hidden = !custom;
  $("#style-reset").hidden = !!custom;
  // Police : celle du style, ou héritée (texte normal, ou paragraphe).
  const inherited = character ? "Celle du paragraphe" : `Comme le texte normal (${fontOf(styles, "normal")})`;
  const font = editingStyle === "normal" ? fontOf(styles, "normal") : s.fontFamily;
  styleFontName.textContent = font ?? inherited;
  styleFont.style.fontFamily = font ? `"${font}", Georgia, serif` : "";
  styleFontInherit.hidden = editingStyle === "normal" || !s.fontFamily;
  styleFontInherit.textContent = character ? "Garder celle du paragraphe" : "Comme le texte normal";
  weightOptions(styleField("fontWeight"), font ?? fontOf(styles, "normal"), weightOf(s));
  styleField("fontSize").value = String(s.fontSize);
  styleField("color").value = s.color || "#000000";
  styleField("hasHighlight").checked = !!s.highlight;
  styleField("highlight").value = s.highlight || "#fff3a3";
  styleField("italic").checked = s.italic;
  styleField("underline").checked = !!s.underline;
  styleField("strike").checked = !!s.strike;
  styleField("smallCaps").checked = !!s.smallCaps;
  styleField("verticalAlign").value = s.verticalAlign ?? "";
  styleField("textTransform").value = s.textTransform ?? "";
  styleField("letterSpacing").value = s.letterSpacing ? String(s.letterSpacing) : "0";
  styleField("textAlign").value = s.textAlign && s.textAlign !== "left" ? s.textAlign : "";
  styleField("indentLeft").value = String(s.indentLeft ?? 0);
  styleField("indentRight").value = String(s.indentRight ?? 0);
  styleField("firstLineIndent").value = String(s.firstLineIndent ?? 0);
  const lh = styleField("lineHeight");
  if (![...lh.options].some((o) => Number(o.value) === s.lineHeight)) lh.append(new Option(String(s.lineHeight).replace(".", ","), String(s.lineHeight)));
  lh.value = [...lh.options].find((o) => Number(o.value) === s.lineHeight)!.value;
  styleField("spaceBefore").value = String(s.spaceBefore);
  styleField("spaceAfter").value = String(s.spaceAfter);
}

function readStyleForm(event: Event) {
  const num = (name: string, fallback: number, min: number, max: number) => {
    const v = parseFloat(styleField(name).value.replace(",", "."));
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  const s = getStyle(styles, editingStyle);
  const color = styleField("color").value;
  const weight = Number(styleField("fontWeight").value) || weightOf(s);
  const target = (event.target as HTMLElement).getAttribute("name");
  // Choisir une couleur de surlignage coche la case.
  if (target === "highlight") styleField("hasHighlight").checked = true;
  const opt = (v: number) => (v ? v : null);
  let next = withStyle(styles, editingStyle, {
    ...s,
    fontSize: num("fontSize", s.fontSize, 6, 96),
    bold: weight >= 600,
    fontWeight: weight === 400 || weight === 700 ? null : weight,
    italic: styleField("italic").checked,
    color: color.toLowerCase() === "#000000" ? null : color,
    highlight: styleField("hasHighlight").checked ? styleField("highlight").value : null,
    underline: styleField("underline").checked,
    strike: styleField("strike").checked,
    smallCaps: styleField("smallCaps").checked,
    verticalAlign: (styleField("verticalAlign").value || null) as ParagraphStyle["verticalAlign"],
    textTransform: (styleField("textTransform").value || null) as ParagraphStyle["textTransform"],
    letterSpacing: opt(num("letterSpacing", 0, -5, 20)),
    textAlign: (styleField("textAlign").value || null) as ParagraphStyle["textAlign"],
    lineHeight: num("lineHeight", s.lineHeight, 0.8, 3),
    spaceBefore: num("spaceBefore", s.spaceBefore, 0, 96),
    spaceAfter: num("spaceAfter", s.spaceAfter, 0, 96),
    indentLeft: opt(num("indentLeft", 0, 0, 15)),
    indentRight: opt(num("indentRight", 0, 0, 15)),
    firstLineIndent: opt(num("firstLineIndent", 0, -10, 10)),
  });
  const id = customId(editingStyle);
  const name = styleField("name").value.trim();
  if (id && name && target === "name") {
    next = { ...next, custom: next.custom.map((c) => (c.id === id ? { ...c, name } : c)) };
  }
  setStyles(next);
  // Seule la liste change (le formulaire garde le champ en cours de saisie).
  for (const li of styleList.querySelectorAll<HTMLElement>("li[data-ref]")) {
    const ref = li.dataset.ref as StyleRef;
    li.setAttribute("style", previewCss(styles, ref));
    li.textContent = styleName(styles, ref);
  }
}

styleForm.addEventListener("input", readStyleForm);

/** Police d'un style, choisie dans le sélecteur (avec sa graisse). */
function setStyleFont(choice: FontChoice | null) {
  const s = getStyle(styles, editingStyle);
  const style: ParagraphStyle = { ...s, fontFamily: choice?.family ?? null };
  if (choice?.weight) {
    style.fontWeight = choice.weight === 400 || choice.weight === 700 ? null : choice.weight;
    style.bold = choice.weight >= 600;
    style.italic = !!choice.italic;
  }
  setStyles(withStyle(styles, editingStyle, style));
  renderStyleDialog();
}

styleFont.addEventListener("click", () => {
  const s = getStyle(styles, editingStyle);
  const family = editingStyle === "normal" ? fontOf(styles, "normal") : (s.fontFamily ?? "");
  openFontPicker(styleFont, { family, weight: weightOf(s), italic: s.italic }, setStyleFont);
});
styleFontInherit.addEventListener("click", () => setStyleFont(null));
styleForm.addEventListener("change", readStyleForm);
$("#style-reset").addEventListener("click", () => {
  const key = editingStyle as StyleKey;
  setStyles({ ...styles, [key]: structuredClone((defaultStyles ?? DEFAULT_STYLES)[key]) });
  renderStyleDialog();
});
$("#style-delete").addEventListener("click", () => deleteStyle(editingStyle));
$("#style-new-para").addEventListener("click", () => createStyle("paragraph"));
$("#style-new-char").addEventListener("click", () => createStyle("character"));
$("#styles-save-default").addEventListener("click", saveDefaultStyles);

function openStylesDialog(ref?: StyleRef) {
  editingStyle = ref ?? currentStyleKey();
  renderStyleDialog();
  stylesDialog.showModal();
}
stylesDialog.addEventListener("close", () => setTimeout(() => editor.commands.focus()));

async function saveDefaultStyles() {
  try {
    await invoke("save_default_styles", { styles });
    defaultStyles = structuredClone(styles);
    setSaveStatus("Styles enregistrés pour les nouveaux documents");
  } catch (e) {
    alert(String(e));
  }
}

function useDefaultStyles() {
  setStyles(structuredClone(defaultStyles ?? DEFAULT_STYLES));
}

function styleMenu(): MenuItem[] {
  const current = currentStyleKey();
  const char = currentCharStyle();
  const paras = allStyleRefs().filter((r) => findCustom(styles, r)?.kind !== "character");
  const chars = styles.custom.filter((c) => c.kind === "character");
  return [
    ...paras.map((ref) => ({
      label: styleName(styles, ref),
      checked: ref === current,
      submenu: [
        { label: `Appliquer « ${styleName(styles, ref)} »`, action: () => applyStyle(ref) },
        {
          label: `Mettre à jour « ${styleName(styles, ref)} » selon la sélection`,
          disabled: ref !== current,
          action: updateStyleFromSelection,
        },
        { label: "Modifier…", action: () => openStylesDialog(ref) },
      ],
    })),
    ...(chars.length
      ? [
          SEP,
          ...chars.map((c) => ({
            label: c.name,
            checked: c.id === char,
            action: () => applyStyle(customRef(c.id)),
          })),
        ]
      : []),
    SEP,
    { label: "Nouveau style de paragraphe…", action: () => createStyle("paragraph") },
    { label: "Nouveau style de caractère…", action: () => createStyle("character") },
    { label: "Modifier les styles…", action: () => openStylesDialog() },
    SEP,
    { label: "Enregistrer comme styles par défaut", action: saveDefaultStyles },
    { label: "Utiliser les styles par défaut", action: useDefaultStyles },
    {
      label: "Revenir aux styles d'origine de Text Machine",
      action: () => setStyles(structuredClone(DEFAULT_STYLES)),
    },
  ];
}

/** La liste « Style » de la barre d'outils : intégrés, créés, caractère. */
function renderStyleSelect() {
  const groups: [string, StyleRef[]][] = [
    ["", [...STYLE_KEYS]],
    ["Mes styles de paragraphe", styles.custom.filter((c) => c.kind === "paragraph").map((c) => customRef(c.id))],
    ["Styles de caractère", styles.custom.filter((c) => c.kind === "character").map((c) => customRef(c.id))],
  ];
  blockSelect.replaceChildren();
  for (const [label, refs] of groups) {
    if (!refs.length) continue;
    const parent = label ? document.createElement("optgroup") : blockSelect;
    if (parent instanceof HTMLOptGroupElement) parent.label = label;
    for (const ref of refs) parent.append(new Option(styleName(styles, ref), ref));
    if (parent !== blockSelect) blockSelect.append(parent);
  }
  const more = document.createElement("optgroup");
  more.label = "──────────";
  more.append(new Option("Nouveau style de paragraphe…", "new:paragraph"));
  more.append(new Option("Nouveau style de caractère…", "new:character"));
  more.append(new Option("Modifier les styles…", "edit"));
  blockSelect.append(more);
}

// --- Majuscules / minuscules ------------------------------------------------------

type CaseMode = "lower" | "upper" | "title";

function changeCase(mode: CaseMode) {
  const { from, to, empty } = editor.state.selection;
  if (empty) return;
  const { tr, doc, schema } = editor.state;
  const pieces: { from: number; to: number; text: string; marks: readonly any[] }[] = [];
  let previous = " ";
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) {
      if (node.isBlock) previous = " ";
      return true;
    }
    const start = Math.max(from, pos);
    const end = Math.min(to, pos + node.nodeSize);
    const text = node.text!.slice(start - pos, end - pos);
    let out = "";
    for (const ch of text) {
      if (mode === "lower") out += ch.toLocaleLowerCase("fr");
      else if (mode === "upper") out += ch.toLocaleUpperCase("fr");
      else out += /[\s\-'’(«"]/.test(previous) ? ch.toLocaleUpperCase("fr") : ch.toLocaleLowerCase("fr");
      previous = ch;
    }
    if (out !== text) pieces.push({ from: start, to: end, text: out, marks: node.marks });
    return false;
  });
  // De la fin vers le début : les positions restent justes.
  for (const p of pieces.reverse()) {
    tr.replaceWith(p.from, p.to, schema.text(p.text, p.marks as any));
  }
  if (tr.docChanged) {
    // La sélection garde le texte transformé.
    tr.setSelection(TextSelection.create(tr.doc, from, tr.mapping.map(to)));
    editor.view.dispatch(tr);
  }
  editor.commands.focus();
}

function insertDate() {
  const today = new Date().toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  chain().insertContent(today).run();
}

// --- Rechercher / remplacer -------------------------------------------------

const findBar = $<HTMLElement>("#find-bar");
const findInput = $<HTMLInputElement>("#find-input");
const replaceInput = $<HTMLInputElement>("#replace-input");
const findCase = $<HTMLInputElement>("#find-case");
const findCount = $<HTMLElement>("#find-count");

function openFind() {
  findBar.hidden = false;
  const { from, to, empty } = editor.state.selection;
  if (!empty) findInput.value = editor.state.doc.textBetween(from, to, " ");
  findInput.focus();
  findInput.select();
  runSearch();
}

function closeFind() {
  if (findBar.hidden) return;
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

// --- Pages, affichage sans pagination, zoom -------------------------------------

const paper = $<HTMLElement>("#paper");
const sheets = $<HTMLElement>("#sheets");
const desk = $<HTMLElement>("#desk");
const printStyle = document.head.appendChild(document.createElement("style"));
let zoom = Number(prefs.get("zoom", "1")) || 1;
let pageCount = 1;

// Sans distraction : toujours sans pagination (le texte seul, en continu).
const isPageless = () => (pageSetup.pageless || !!focusMode?.on) && !forcePaged;

// En-têtes et pieds de page, modifiables directement dans les marges.
marginsView = new MarginsView(paper, {
  setup: () => pageSetup,
  isPageless,
  onInput: (part, text) => {
    pageSetup = { ...pageSetup, [part]: text };
    markDirty();
  },
  onLeave: () => editor.commands.focus(),
});

/** Insertion > En-tête / Pied de page. */
function editMargin(part: "header" | "footer") {
  if (!isPageless() && marginsView?.focus(part, desk.getBoundingClientRect().top + desk.clientHeight / 2)) return;
  // Sans pagination (ou sur une page de titre seule) : par la mise en page.
  openPageDialog();
  requestAnimationFrame(() => field(part).focus());
}

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
  paper.classList.toggle("pageless", isPageless());
  lastPages = -1;
  compare?.copyPage();
}

let lastPages = -1;
/** Dessine une feuille blanche (avec son numéro) par page. */
function drawSheets(pages: number) {
  const key = isPageless() ? 0 : pages;
  if (key === lastPages) return;
  lastPages = key;
  pageCount = pages;
  paper.style.setProperty("--pages", String(pages));
  sheets.replaceChildren(
    ...Array.from({ length: pages }, (_, i) => {
      const sheet = document.createElement("div");
      sheet.className = "sheet";
      sheet.style.top = `calc(${i} * (var(--page-h) + var(--page-gap)))`;
      return sheet;
    }),
  );
  marginsView?.render(pages);
  renderWordBox();
}

function setPageSetup(setup: PageSetup, dirty = true) {
  pageSetup = { ...structuredClone(DEFAULT_PAGE_SETUP), ...setup };
  if (dirty) markDirty();
  applyPageSetup();
  refreshPagination(editor.view);
}

function setPageless(pageless: boolean) {
  if (pageless === pageSetup.pageless) return;
  setPageSetup({ ...pageSetup, pageless });
}

/** Le temps que la mise en page (et le découpage en pages) se refasse. */
const waitForLayout = () =>
  new Promise<void>((resolve) => {
    let n = 0;
    const tick = () => (++n >= 4 ? setTimeout(resolve, 60) : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });

/** Passe en mode page le temps d'un export ou d'une impression. */
async function withPages<T>(run: () => Promise<T>): Promise<T> {
  if (!pageSetup.pageless) return run();
  forcePaged = true;
  applyPageSetup();
  refreshPagination(editor.view);
  await waitForLayout();
  try {
    return await run();
  } finally {
    leavePages();
  }
}

function leavePages() {
  if (!forcePaged) return;
  forcePaged = false;
  applyPageSetup();
  refreshPagination(editor.view);
}

/** En comparaison, les deux pages doivent tenir côte à côte : zoom réduit si besoin. */
function shownZoom() {
  if (compare?.isOpen) {
    const available = (desk.clientWidth - 32) / pageSizePx(pageSetup).width;
    return Math.max(0.3, Math.min(zoom, Math.floor(available * 20) / 20));
  }
  // Avec des commentaires, la page garde sa taille, comme dans Google Docs :
  // si la fenêtre est trop étroite, on fait défiler de côté.
  return zoom;
}

function setZoom(value: number) {
  zoom = Math.min(3, Math.max(0.3, value));
  paper.style.setProperty("zoom", String(shownZoom()));
  compare?.copyPage();
  prefs.set("zoom", String(zoom));
  const select = $<HTMLSelectElement>("#zoom");
  if (![...select.options].some((o) => Number(o.value) === zoom)) {
    select.append(new Option(`${Math.round(zoom * 100)} %`, String(zoom)));
  }
  select.value = [...select.options].find((o) => Number(o.value) === zoom)!.value;
  refreshPagination(editor.view);
}

$<HTMLSelectElement>("#zoom").addEventListener("change", (e) => {
  setZoom(Number((e.target as HTMLSelectElement).value));
  editor.commands.focus();
});

// --- Images ----------------------------------------------------------------

// Un fichier lâché à côté de la page ne doit pas remplacer l'application
// (le navigateur l'ouvrirait) : seule la page accepte les images.
for (const type of ["dragover", "drop"] as const) {
  window.addEventListener(type, (event) => {
    if (!(event.target as HTMLElement).closest?.(".tiptap")) event.preventDefault();
  });
}

/** Les images sont gardées dans le document (adresse `data:` en base64). */
function insertImageFile(file: File, pos?: number) {
  const reader = new FileReader();
  reader.onload = () => {
    const image = { type: "image", attrs: { src: String(reader.result), alt: file.name } };
    const c = editor.chain().focus();
    if (pos === undefined) c.insertContent(image).run();
    else c.insertContentAt(pos, image).run();
  };
  reader.readAsDataURL(file);
}

// --- Nombre de mots et de signes, calculés par le cœur Rust -----------------------

interface TextStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
}

const wordBox = $<HTMLButtonElement>("#word-box");
let showWordBox = prefs.get("wordBox", "0") === "1";
let tabStats: TextStats = { words: 0, characters: 0, charactersNoSpaces: 0 };
let selectionStats: TextStats | null = null;
let countTimer: number | undefined;

const stats = (doc: JSONContent) =>
  invoke<TextStats>("text_stats", { doc }).catch(() => ({ words: 0, characters: 0, charactersNoSpaces: 0 }));

function selectionDoc(): JSONContent | null {
  const { from, to, empty } = editor.state.selection;
  if (empty) return null;
  return editor.state.doc.cut(from, to).toJSON();
}

/** Tous les onglets à la suite (pour compter tout le document). */
function allTabsDoc(): JSONContent {
  return {
    type: "doc",
    content: tabs.flat().flatMap(({ node }) => tabs.documentOf(node).content ?? []),
  };
}

function scheduleCounts() {
  window.clearTimeout(countTimer);
  countTimer = window.setTimeout(updateCounts, 300);
}

async function updateCounts() {
  if (busy) return;
  const sel = selectionDoc();
  [tabStats, selectionStats] = await Promise.all([stats(editor.getJSON()), sel ? stats(sel) : null]);
  renderWordBox();
}

const plural = (n: number, word: string) => `${n.toLocaleString("fr-FR")} ${word}${n > 1 ? "s" : ""}`;

function renderWordBox() {
  wordBox.hidden = !showWordBox;
  if (!showWordBox) return;
  const s = selectionStats ?? tabStats;
  const parts = [
    selectionStats ? `${plural(s.words, "mot")} sur ${tabStats.words.toLocaleString("fr-FR")}` : plural(s.words, "mot"),
    plural(s.characters, "signe"),
  ];
  if (!isPageless()) parts.push(plural(pageCount, "page"));
  wordBox.textContent = parts.join(" · ");
}

function setShowWordBox(on: boolean) {
  showWordBox = on;
  prefs.set("wordBox", on ? "1" : "0");
  renderWordBox();
}

const countDialog = $<HTMLDialogElement>("#count-dialog");

async function openCountDialog() {
  const sel = selectionDoc();
  const several = tabs.count() > 1;
  const [tab, all, selection] = await Promise.all([
    stats(editor.getJSON()),
    several ? stats(allTabsDoc()) : null,
    sel ? stats(sel) : null,
  ]);
  const columns: [string, TextStats | null][] = [
    ["Sélection", selection],
    [several ? "Onglet" : "Document", tab],
    ["Tous les onglets", all],
  ];
  const shown = columns.filter(([, s]) => s) as [string, TextStats][];
  const row = (label: string, cells: string[]) =>
    `<tr><th>${label}</th>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
  const n = (v: number) => v.toLocaleString("fr-FR");
  $("#count-table").innerHTML = [
    shown.length > 1 ? `<tr><th></th>${shown.map(([l]) => `<td class="head">${l}</td>`).join("")}</tr>` : "",
    !isPageless() ? row("Pages", shown.map(([l]) => (l === "Sélection" || l === "Tous les onglets" ? "" : n(pageCount)))) : "",
    row("Mots", shown.map(([, s]) => n(s.words))),
    row("Signes (espaces compris)", shown.map(([, s]) => n(s.characters))),
    row("Signes (sans les espaces)", shown.map(([, s]) => n(s.charactersNoSpaces))),
  ].join("");
  $<HTMLInputElement>("#count-live").checked = showWordBox;
  countDialog.showModal();
}

$<HTMLInputElement>("#count-live").addEventListener("change", (e) =>
  setShowWordBox((e.target as HTMLInputElement).checked),
);
countDialog.addEventListener("close", () => setTimeout(() => editor.commands.focus()));
wordBox.addEventListener("click", openCountDialog);

// --- Fichiers ---------------------------------------------------------------

interface NativeFile {
  tabs: TabData[];
  page: PageSetup;
  styles?: StyleSheet;
}

interface Session {
  recent: string[];
  lastFile: string | null;
  defaultStyles: StyleSheet | null;
}

/** Modifications pas encore écrites sur le disque. */
let dirty = false;
/** Vrai pendant le chargement d'un document (ce n'est pas une modification). */
let loading = false;
let autosaveTimer: number | undefined;
const AUTOSAVE_DELAY_MS = 1500;
const fileName = (path: string) => path.split(/[\\/]/).pop()!;
let recentFiles: string[] = [];

function fileData(): NativeFile {
  return { tabs: tabs.toData(), page: pageSetup, styles };
}

function setPath(path: string | null) {
  currentPath = path;
  const name = path ? fileName(path) : "Sans titre";
  $("#file-name").textContent = name;
  $("#file-name").title = path ?? "Document pas encore enregistré";
  document.title = `${name} — Text Machine`;
}

function setSaveStatus(text: string) {
  $("#save-status").textContent = text;
}

/** Appelé à chaque modification du document ou de ses réglages. */
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
  if (busy) {
    // Un export est en cours : l'éditeur montre un document temporaire.
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(autosave, AUTOSAVE_DELAY_MS);
    return;
  }
  try {
    if (currentPath) {
      await writeFile(currentPath);
    } else {
      await invoke("save_draft", { file: fileData() });
      dirty = false;
      setSaveStatus("Brouillon enregistré");
    }
  } catch (e) {
    setSaveStatus(`Échec de l'enregistrement : ${e}`);
  }
}

async function writeFile(path: string) {
  setSaveStatus("Enregistrement…");
  await invoke("save_document", { path, file: fileData() });
  // Nouveau nom (premier enregistrement, « Enregistrer sous ») : les
  // versions suivent le document.
  if (path !== currentPath) {
    await invoke("copy_versions", { from: currentPath, to: path }).catch(() => {});
    window.setTimeout(refreshVersions, 0);
  }
  dirty = false;
  setPath(path);
  setSaveStatus(savedLabel(path));
  refreshRecent();
}

/** Markdown et texte ne gardent pas toute la mise en forme : on le rappelle. */
function savedLabel(path: string) {
  if (/\.(md|markdown)$/i.test(path)) return "Enregistré en Markdown (sans couleurs, polices ni styles)";
  if (/\.txt$/i.test(path)) return "Enregistré en texte brut (sans mise en forme)";
  return "Enregistré";
}

function loadFile(file: NativeFile, path: string | null) {
  compare?.close();
  loading = true;
  tabs.load(file.tabs);
  setStyles(file.styles ?? DEFAULT_STYLES, false);
  setPageSetup(file.page, false);
  loading = false;
  dirty = false;
  setPath(path);
  refreshVersions();
  setSaveStatus(path ? savedLabel(path) : "");
  updateCounts();
  renderPanel();
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
  const path = await open({ multiple: false, filters: OPEN_FILTERS, defaultPath: saveFolder() || undefined });
  if (typeof path === "string") await openPath(path);
}

async function saveFile() {
  if (currentPath) return writeFile(currentPath).catch((e) => alert(String(e)));
  return saveFileAs();
}

async function saveFileAs() {
  let path = await save({
    filters: SAVE_FILTERS,
    defaultPath: currentPath?.replace(/\.tmd$/i, ".docx") ?? inSaveFolder(`${suggestedName()}.docx`),
  });
  if (!path) return;
  path = withExtension(path, "docx", ["docx", "md", "markdown", "txt", "tmd"]);
  try {
    await writeFile(path);
  } catch (e) {
    alert(String(e));
  }
}

/** Nom proposé : le premier titre (ou la première ligne) du premier onglet. */
/** Le texte d'un onglet (sans mise en forme). */
function tabText(node: TabNode) {
  try {
    return editor.schema.nodeFromJSON(tabs.documentOf(node)).textContent;
  } catch {
    return "";
  }
}

function suggestedName() {
  let text = "";
  try {
    text = editor.schema.nodeFromJSON(tabs.documentOf(tabs.roots[0])).firstChild?.textContent.trim() ?? "";
  } catch {
    /* nom par défaut */
  }
  return text.replace(/[\\/:*?"<>|]/g, "").slice(0, 60) || "Sans titre";
}

/** Termine un enregistrement automatique en attente avant de changer de document. */
async function flush() {
  window.clearTimeout(autosaveTimer);
  await autosave();
}

/** Le document contient-il du texte (dans un onglet quelconque) ? */
function hasText() {
  return tabs.flat().some(({ node }) => tabText(node).trim());
}

/**
 * Avant de quitter un document sans titre qui contient du texte, propose de
 * l'enregistrer (sinon il serait remplacé par le suivant dans le brouillon).
 * Renvoie `false` si l'utilisateur annule.
 */
async function leaveUntitled(): Promise<boolean> {
  await flush();
  if (currentPath || !hasText()) return true;
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
    tabs: [{ title: "Onglet 1", document: { type: "doc", content: [{ type: "paragraph" }] } }],
    page: structuredClone(DEFAULT_PAGE_SETUP),
    styles: structuredClone(defaultStyles ?? DEFAULT_STYLES),
  };
  loadFile(empty, null);
  await invoke("forget_last_file").catch(() => {});
  // Les versions de l'ancien brouillon ne concernent pas ce nouveau texte.
  await invoke("clear_versions", { path: null }).catch(() => {});
  await refreshVersions();
  await invoke("save_draft", { file: fileData() }).catch(() => {});
  editor.commands.focus();
}

// --- Impression, PDF, export ---------------------------------------------------

/** Impression du système ; sur Mac, « PDF > Enregistrer au format PDF ». */
async function printDocument() {
  if (pageSetup.pageless) {
    // Le temps de l'impression, le document est découpé en pages.
    forcePaged = true;
    applyPageSetup();
    refreshPagination(editor.view);
    await waitForLayout();
    window.addEventListener("afterprint", leavePages, { once: true });
  }
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

/** Word, Markdown et texte : tous les onglets, chacun avec son titre. */
async function exportAs(kind: keyof typeof EXPORTS) {
  const filter = EXPORTS[kind];
  const chosen = await save({ filters: [filter], defaultPath: inSaveFolder(`${suggestedName()}.${filter.extensions[0]}`) });
  if (!chosen) return;
  const path = withExtension(chosen, filter.extensions[0]);
  try {
    await invoke("export_document", { path, file: fileData() });
    setSaveStatus(`Exporté : ${fileName(path)}`);
  } catch (e) {
    alert(String(e));
  }
}

/** Tous les onglets à la suite, chacun sur une nouvelle page avec son titre. */
function printableAllTabs(): JSONContent {
  const content: JSONContent[] = [];
  tabs.flat().forEach(({ node, depth }, i) => {
    if (i > 0) content.push({ type: "pageBreak" });
    content.push({
      type: "heading",
      attrs: { level: depth + 1 },
      content: [{ type: "text", text: node.title, marks: [{ type: "bold" }] }],
    });
    content.push(...(tabs.documentOf(node).content ?? []));
  });
  return { type: "doc", content };
}

/**
 * Export PDF direct : choix du fichier, puis la page est écrite telle
 * qu'à l'écran. Si ce n'est pas possible (hors Mac), on passe par l'impression.
 */
async function exportPdf(allTabs: boolean) {
  const several = allTabs && tabs.count() > 1;
  let path = await save({
    filters: [{ name: "PDF", extensions: ["pdf"] }],
    defaultPath: inSaveFolder(several || tabs.count() === 1 ? `${suggestedName()}.pdf` : `${tabs.active().title}.pdf`),
  });
  if (!path) return;
  path = withExtension(path, "pdf");
  await flush();
  busy = true;
  // Sans curseur ni sélection dans le PDF : on les remet après.
  const saved = editor.state;
  const selection = saved.selection;
  editor.commands.blur();
  window.getSelection()?.removeAllRanges();
  const scroll = desk.scrollTop;
  let failure: unknown = null;
  try {
    if (several) {
      const doc = createDocument(printableAllTabs(), editor.schema);
      editor.view.updateState(EditorState.create({ doc, plugins: saved.plugins }));
    }
    await withPages(async () => {
      // Mode export : seules les feuilles, collées en haut à gauche (styles.css).
      document.body.classList.add("exporting");
      refreshPagination(editor.view);
      await waitForLayout();
      try {
        await invoke("export_pdf", { path, page: pageSetup, pages: pageCount || 1 });
      } finally {
        document.body.classList.remove("exporting");
      }
    });
    setSaveStatus(`PDF enregistré : ${fileName(path)}`);
  } catch (e) {
    failure = e;
  } finally {
    if (several) editor.view.updateState(saved);
    busy = false;
    refreshPagination(editor.view);
    desk.scrollTop = scroll;
  }
  if (failure) {
    alert(`${failure}\nLa fenêtre d'impression va s'ouvrir : choisissez « Enregistrer au format PDF ».`);
    printDocument();
    return;
  }
  editor.chain().setTextSelection({ from: selection.from, to: selection.to }).focus().run();
}

function exportMenu(): MenuItem[] {
  const several = tabs.count() > 1;
  return [
    ...(several
      ? [
          { label: "PDF, tous les onglets (.pdf)…", action: () => exportPdf(true) },
          { label: "PDF, onglet actuel (.pdf)…", action: () => exportPdf(false) },
        ]
      : [{ label: "PDF (.pdf)…", action: () => exportPdf(false) }]),
    { label: "Word (.docx)…", action: () => exportAs("docx") },
    { label: "Markdown (.md)…", action: () => exportAs("md") },
    { label: "Texte brut (.txt)…", action: () => exportAs("txt") },
  ];
}

// Fichiers récents.
async function refreshRecent() {
  const session = await invoke<Session>("load_session").catch(() => null);
  recentFiles = session?.recent ?? [];
}

function recentMenu(): MenuItem[] {
  if (!recentFiles.length) return [{ label: "Aucun fichier récent", disabled: true }];
  return recentFiles.map((path) => ({ label: fileName(path), action: () => openPath(path) }));
}

/** Au lancement : on rouvre le dernier fichier, ou le brouillon. */
async function restoreSession() {
  try {
    const session = await invoke<Session>("load_session");
    recentFiles = session.recent ?? [];
    defaultStyles = session.defaultStyles ? normalizeStyles(session.defaultStyles) : null;
    // Pas de question « enregistrer ? » ici : le document d'accueil n'est
    // pas celui de l'utilisateur.
    if (session.lastFile) {
      // Fichier déplacé ou supprimé : on reprend le brouillon.
      const file = await invoke<NativeFile>("open_document", { path: session.lastFile }).catch(() => null);
      if (file) return loadFile(file, session.lastFile);
    }
    const draft = await invoke<NativeFile | null>("load_draft");
    if (draft) loadFile(draft, null);
    else if (defaultStyles) setStyles(defaultStyles, false);
  } catch {
    // Pas de session (premier lancement) : on garde le document d'accueil.
  }
}

/**
 * Fichiers ouverts d'un double-clic (ou « Ouvrir avec » Text Machine) : au
 * lancement, ou pendant que l'app tourne. Une seule fenêtre : on ouvre le
 * dernier reçu.
 */
async function openRequestedFiles(): Promise<void> {
  const paths = await invoke<string[]>("take_opened_files").catch(() => [] as string[]);
  const last = paths.at(-1);
  if (last) await openPath(last);
}

// Fermeture de la fenêtre : on enregistre ce qui ne l'est pas encore.
window.addEventListener("beforeunload", () => {
  if (dirty) autosave();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flush();
});

// --- Barre de menus ----------------------------------------------------------------

const LINE_HEIGHTS: [string, string][] = [
  ["1", "Simple"],
  ["1.15", "1,15"],
  ["1.5", "1,5"],
  ["2", "Double"],
];

function lineHeightMenu(): MenuItem[] {
  const current = blockAttrs().lineHeight ?? null;
  return [
    ...LINE_HEIGHTS.map(([value, label]) => ({
      label,
      checked: current === value,
      action: () => chain().setBlockLineHeight(value).run(),
    })),
    SEP,
    {
      label: `Celui du style (${String(getStyle(styles, currentStyleKey()).lineHeight).replace(".", ",")})`,
      checked: current === null,
      action: () => chain().setBlockLineHeight(null).run(),
    },
  ];
}

function tableMenu(): MenuItem[] {
  return [
    { label: "Insérer une ligne au-dessus", action: () => chain().addRowBefore().run() },
    { label: "Insérer une ligne en dessous", action: () => chain().addRowAfter().run() },
    { label: "Insérer une colonne à gauche", action: () => chain().addColumnBefore().run() },
    { label: "Insérer une colonne à droite", action: () => chain().addColumnAfter().run() },
    SEP,
    { label: "Supprimer la ligne", action: () => chain().deleteRow().run() },
    { label: "Supprimer la colonne", action: () => chain().deleteColumn().run() },
    { label: "Première ligne en en-tête", action: () => chain().toggleHeaderRow().run() },
    SEP,
    { label: "Supprimer le tableau", action: () => chain().deleteTable().run() },
  ];
}

setupMenubar($("#menubar"), [
  {
    label: "Fichier",
    items: () => [
      { label: "Nouveau document", shortcut: "⌘N", action: newFile },
      { label: "Ouvrir…", shortcut: "⌘O", action: openFile },
      { label: "Fichiers récents", submenu: recentMenu() },
      SEP,
      { label: "Enregistrer", shortcut: "⌘S", action: saveFile },
      { label: "Enregistrer sous…", shortcut: "⇧⌘S", action: saveFileAs },
      { label: "Exporter", submenu: exportMenu() },
      SEP,
      { label: "Versions", submenu: versionsMenu() },
      SEP,
      { label: "Dossier d'enregistrement…", action: openFolderDialog },
      { label: "Mise en page…", action: openPageDialog },
      { label: "Imprimer…", shortcut: "⌘P", action: printDocument },
      SEP,
      { label: "Rechercher des mises à jour…", action: () => updateApp(true) },
    ],
  },
  {
    label: "Édition",
    items: () => [
      { label: "Annuler", shortcut: "⌘Z", disabled: !editor.can().undo(), action: () => chain().undo().run() },
      { label: "Rétablir", shortcut: "⇧⌘Z", disabled: !editor.can().redo(), action: () => chain().redo().run() },
      SEP,
      { label: "Tout sélectionner", shortcut: "⌘A", action: () => chain().selectAll().run() },
      SEP,
      { label: "Rechercher et remplacer", shortcut: "⌘F", action: openFind },
    ],
  },
  {
    label: "Affichage",
    items: () => [
      { label: "Mode page", checked: !pageSetup.pageless, action: () => setPageless(false) },
      { label: "Sans pagination (défilement continu)", checked: pageSetup.pageless, action: () => setPageless(true) },
      SEP,
      {
        label: "Afficher les onglets et le plan",
        shortcut: "⇧⌘O",
        checked: !sidePanel.hidden,
        action: () => setPanelVisible(sidePanel.hidden),
      },
      { label: "Afficher le nombre de mots", checked: showWordBox, action: () => setShowWordBox(!showWordBox) },
      {
        label: "Commentaires résolus",
        checked: !!commentsView?.showResolved,
        disabled: !commentsView?.resolvedCount && !commentsView?.showResolved,
        action: () => commentsView?.setShowResolved(!commentsView.showResolved),
      },
      SEP,
      { label: "Plein écran", shortcut: "⌃⌘F", checked: document.body.classList.contains("fullscreen"), action: toggleFullscreen },
      { label: "Mode sans distraction", shortcut: "⇧⌘D", checked: !!focusMode?.on, action: () => focusMode?.toggle() },
      SEP,
      {
        label: "Zoom",
        submenu: [0.5, 0.75, 0.9, 1, 1.25, 1.5, 2].map((z) => ({
          label: `${z * 100} %`,
          checked: z === zoom,
          action: () => setZoom(z),
        })),
      },
    ],
  },
  {
    label: "Insertion",
    items: () => [
      { label: "Image…", action: () => imageInput.click() },
      { label: "Tableau", action: () => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
      { label: "Lien…", shortcut: "⌘K", action: openLinkDialog },
      { label: "Ligne horizontale", action: () => chain().setHorizontalRule().run() },
      { label: "Saut de page", shortcut: "⌘↩", action: () => chain().setPageBreak().run() },
      { label: "Date du jour", action: insertDate },
      SEP,
      { label: "Commentaire", shortcut: "⌥⌘M", action: () => commentsView?.start() },
      { label: "Note de bas de page", shortcut: "⌥⌘F", action: insertFootnote },
      { label: "Table des matières", action: () => chain().insertTableOfContents().run() },
      { label: "En-tête", action: () => editMargin("header") },
      { label: "Pied de page", action: () => editMargin("footer") },
      SEP,
      { label: "Onglet", action: () => tabs.add({ afterId: tabs.activeId }) },
      {
        label: "Sous-onglet",
        disabled: (tabs.find(tabs.activeId)?.depth ?? 0) >= MAX_TAB_LEVEL - 1,
        action: () => tabs.add({ parentId: tabs.activeId }),
      },
    ],
  },
  {
    label: "Format",
    items: () => [
      {
        label: "Texte",
        submenu: [
          { label: "Gras", shortcut: "⌘B", checked: editor.isActive("bold"), action: () => chain().toggleBold().run() },
          { label: "Italique", shortcut: "⌘I", checked: editor.isActive("italic"), action: () => chain().toggleItalic().run() },
          { label: "Souligné", shortcut: "⌘U", checked: editor.isActive("underline"), action: () => chain().toggleUnderline().run() },
          { label: "Barré", shortcut: "⇧⌘X", checked: editor.isActive("strike"), action: () => chain().toggleStrike().run() },
          { label: "Exposant", shortcut: "⌘.", checked: editor.isActive("superscript"), action: actions.superscript },
          { label: "Indice", shortcut: "⌘,", checked: editor.isActive("subscript"), action: actions.subscript },
          SEP,
          {
            label: "Majuscules",
            submenu: [
              { label: "minuscules", action: () => changeCase("lower") },
              { label: "MAJUSCULES", action: () => changeCase("upper") },
              { label: "Majuscule À Chaque Mot", action: () => changeCase("title") },
            ],
          },
        ],
      },
      { label: "Styles", submenu: styleMenu() },
      {
        label: "Aligner et mettre en retrait",
        submenu: [
          { label: "À gauche", shortcut: "⇧⌘L", action: actions.alignLeft },
          { label: "Centré", shortcut: "⇧⌘E", action: actions.alignCenter },
          { label: "À droite", shortcut: "⇧⌘R", action: actions.alignRight },
          { label: "Justifié", shortcut: "⇧⌘J", action: actions.alignJustify },
          SEP,
          { label: "Augmenter le retrait", shortcut: "Tab", action: actions.indent },
          { label: "Diminuer le retrait", shortcut: "⇧Tab", action: actions.outdent },
        ],
      },
      { label: "Interligne", submenu: lineHeightMenu() },
      {
        label: "Listes",
        submenu: [
          { label: "Liste à puces", shortcut: "⇧⌘8", checked: editor.isActive("bulletList"), action: actions.bulletList },
          { label: "Liste numérotée", shortcut: "⇧⌘7", checked: editor.isActive("orderedList"), action: actions.orderedList },
          { label: "Cases à cocher", shortcut: "⇧⌘9", checked: editor.isActive("taskList"), action: actions.taskList },
        ],
      },
      { label: "Citation", checked: editor.isActive("blockquote"), action: actions.blockquote },
      ...(editor.isActive("table") ? [{ label: "Tableau", submenu: tableMenu() }] : []),
      SEP,
      { label: "Effacer la mise en forme", shortcut: "⌘\\", action: actions.clearFormat },
    ],
  },
  {
    label: "Outils",
    items: () => [
      { label: "Nombre de mots…", shortcut: "⇧⌘C", action: openCountDialog },
      { label: "Correcteur orthographique", checked: (editor.view.dom as HTMLElement).spellcheck, action: toggleSpellcheck },
      SEP,
      { label: "Suggestions", submenu: suggestionsMenu() },
      { label: "Comparer avec l'original", action: compareWithOriginal },
      SEP,
      { label: "Modifier les styles…", action: () => openStylesDialog() },
      { label: "Polices…", action: openToolbarFonts },
    ],
  },
]);

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

// --- Barre d'outils ---------------------------------------------------------

const toolbar = $<HTMLElement>("#toolbar");
const blockSelect = $<HTMLSelectElement>("#block-style");
const fontButton = $<HTMLButtonElement>("#font-button");
const fontName = $<HTMLElement>("#font-name");
const fontSizeInput = $<HTMLInputElement>("#font-size");
const textColor = $<HTMLInputElement>("#text-color");
const highlightColor = $<HTMLInputElement>("#highlight-color");
const linkDialog = $<HTMLDialogElement>("#link-dialog");
const linkUrl = $<HTMLInputElement>("#link-url");
const imageInput = $<HTMLInputElement>("#image-file");
const tableTools = $<HTMLElement>("#table-tools");
setupToolbarOverflow(toolbar);

const blockAttrs = () =>
  editor.isActive("heading") ? editor.getAttributes("heading") : editor.getAttributes("paragraph");

/** Taille du texte au curseur, en points (celle du style si rien n'est choisi). */
function currentFontSize() {
  const size = parseFloat(editor.getAttributes("textStyle").fontSize ?? "");
  if (Number.isFinite(size)) return size;
  const char = currentCharStyle();
  const custom = char ? findCustom(styles, customRef(char)) : undefined;
  return custom ? custom.style.fontSize : getStyle(styles, currentStyleKey()).fontSize;
}

function setFontSize(size: number) {
  const clean = Math.round(Math.min(400, Math.max(1, size)) * 2) / 2;
  chain().setFontSize(`${clean}pt`).run();
}

const actions: Record<string, () => unknown> = {
  undo: () => chain().undo().run(),
  redo: () => chain().redo().run(),
  print: printDocument,
  bold: () => chain().toggleBold().run(),
  italic: () => chain().toggleItalic().run(),
  underline: () => chain().toggleUnderline().run(),
  strike: () => chain().toggleStrike().run(),
  superscript: () => chain().unsetSubscript().toggleSuperscript().run(),
  subscript: () => chain().unsetSuperscript().toggleSubscript().run(),
  link: openLinkDialog,
  // Les commentaires ne sont pas de la mise en forme : ils restent.
  clearFormat: () =>
    chain()
      .command(({ tr, state }) => {
        const { from, to } = state.selection;
        for (const type of Object.values(state.schema.marks)) {
          if (type.name !== "comment") tr.removeMark(from, to, type);
        }
        return true;
      })
      .unsetTextAlign()
      .setBlockLineHeight(null)
      .run(),
  comment: () => commentsView?.start(),
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
  rowAfter: () => chain().addRowAfter().run(),
  colAfter: () => chain().addColumnAfter().run(),
  find: openFind,
  spellcheck: toggleSpellcheck,
  sizeDown: () => setFontSize(currentFontSize() - 1),
  sizeUp: () => setFontSize(currentFontSize() + 1),
};

// Mise en page : affichage, format, orientation, marges (en cm), numéros.
const pageDialog = $<HTMLDialogElement>("#page-dialog");
const pageForm = pageDialog.querySelector("form")!;
const field = (name: string) => pageForm.elements.namedItem(name) as HTMLInputElement;
const SIDES = ["top", "bottom", "left", "right"] as const;

function openPageDialog() {
  field("size").value = pageSetup.size;
  for (const radio of pageForm.querySelectorAll<HTMLInputElement>('[name="orientation"]')) {
    radio.checked = radio.value === (pageSetup.landscape ? "landscape" : "portrait");
  }
  for (const radio of pageForm.querySelectorAll<HTMLInputElement>('[name="mode"]')) {
    radio.checked = radio.value === (pageSetup.pageless ? "pageless" : "pages");
  }
  for (const side of SIDES) field(side).value = String(+(pageSetup.margins[side] / 10).toFixed(2));
  field("pageNumbers").checked = pageSetup.pageNumbers;
  field("header").value = pageSetup.header ?? "";
  field("footer").value = pageSetup.footer ?? "";
  field("differentFirstPage").checked = !!pageSetup.differentFirstPage;
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
    header: field("header").value.replace(/\s+$/, ""),
    footer: field("footer").value.replace(/\s+$/, ""),
    differentFirstPage: field("differentFirstPage").checked,
    pageless: pageForm.querySelector<HTMLInputElement>('[name="mode"]:checked')?.value === "pageless",
  });
});

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
  if (action === "lineHeight") popup(button!, lineHeightMenu());
  else if (action === "tableMenu") popup(button!, tableMenu());
  else if (action && actions[action]) actions[action]();
});

blockSelect.addEventListener("change", () => {
  const value = blockSelect.value;
  if (value === "new:paragraph" || value === "new:character") createStyle(value.slice(4) as CustomStyle["kind"]);
  else if (value === "edit") openStylesDialog();
  else applyStyle(value as StyleRef);
  refreshToolbar();
});

/** La police et la graisse que donne le style au texte du curseur. */
function styleFontAt(): FontChoice {
  const key = currentStyleKey();
  const char = currentCharStyle();
  const charStyle = char ? findCustom(styles, customRef(char))?.style : undefined;
  const base = getStyle(styles, key);
  return {
    family: charStyle?.fontFamily ?? fontOf(styles, key),
    weight: charStyle ? weightOf(charStyle) : weightOf(base),
  };
}

/** La police du texte au curseur, avec sa graisse. */
function currentFont(): FontChoice {
  const style = editor.getAttributes("textStyle");
  const fromStyle = styleFontAt();
  const family = style.fontFamily ? String(style.fontFamily).replace(/["']/g, "") : fromStyle.family;
  const weight = style.fontWeight ? Number(style.fontWeight) : editor.isActive("bold") ? 700 : fromStyle.weight;
  return { family, weight, italic: editor.isActive("italic") };
}

/** Applique une police (et peut-être une graisse) au texte sélectionné. */
function chooseFont(choice: FontChoice) {
  const fromStyle = styleFontAt();
  let c = chain();
  // La police du style : on retire la police choisie à la main.
  c = choice.family === fromStyle.family ? c.unsetFontFamily() : c.setFontFamily(choice.family);
  if (choice.weight) {
    c = c.unsetBold().setFontWeight(choice.weight === fromStyle.weight ? null : String(choice.weight));
    c = choice.italic ? c.setItalic() : c.unsetItalic();
  } else {
    c = c.setFontWeight(null);
  }
  c.run();
}

const openToolbarFonts = () => openFontPicker(fontButton, currentFont(), chooseFont);
fontButton.addEventListener("mousedown", (e) => e.preventDefault());
fontButton.addEventListener("click", openToolbarFonts);

fontSizeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    const size = parseFloat(fontSizeInput.value.replace(",", "."));
    if (Number.isFinite(size)) setFontSize(size);
    else editor.commands.focus();
  } else if (event.key === "Escape") {
    editor.commands.focus();
  }
});
fontSizeInput.addEventListener("focus", () => fontSizeInput.select());

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

const TOGGLES = ["bold", "italic", "underline", "link", "bulletList", "orderedList", "taskList"];

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
  toolbar.querySelector('[data-action="undo"]')?.toggleAttribute("disabled", !editor.can().undo());
  toolbar.querySelector('[data-action="redo"]')?.toggleAttribute("disabled", !editor.can().redo());

  const key = currentStyleKey();
  // Un style de caractère au curseur passe avant le style du paragraphe.
  const char = currentCharStyle();
  const shown: StyleRef = char && styles.custom.some((c) => c.id === char) ? customRef(char) : key;
  if (blockSelect.value !== shown) blockSelect.value = shown;

  const font = currentFont();
  fontName.textContent = choiceLabel({ family: font.family, weight: font.weight });
  fontButton.style.fontFamily = `"${font.family}", Georgia, serif`;
  if (document.activeElement !== fontSizeInput) {
    fontSizeInput.value = String(currentFontSize()).replace(".", ",");
  }
}

window.addEventListener("keydown", (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  // Sous Windows, AltGr compte comme Ctrl+Alt : AltGr+0 (@), AltGr+3 (#)…
  // doivent écrire le caractère, pas changer de style.
  if (event.getModifierState("AltGraph")) return;
  const key = event.key.toLowerCase();
  // ⌘⌥0 : texte normal ; ⌘⌥1 à 3 : titres 1 à 3 (comme Google Docs).
  if (event.altKey && /^Digit[0-4]$/.test(event.code)) {
    event.preventDefault();
    const n = Number(event.code.slice(5));
    applyStyle(n === 0 ? "normal" : n === 4 ? "title" : styleOfLevel(n + 1));
    return;
  }
  if (event.code === "KeyX" && event.altKey && event.shiftKey) {
    event.preventDefault();
    setSuggesting(!suggesting);
    return;
  }
  if (event.code === "KeyF" && event.altKey && !event.shiftKey) {
    event.preventDefault();
    insertFootnote();
    return;
  }
  if (event.code === "KeyM" && event.altKey && !event.shiftKey) {
    event.preventDefault();
    commentsView?.start();
    return;
  }
  if (event.code === "KeyD" && event.shiftKey && !event.altKey) {
    event.preventDefault();
    void focusMode?.toggle();
    return;
  }
  // ⌃⌘F : plein écran (comme les autres applications du Mac).
  if (event.code === "KeyF" && event.ctrlKey && event.metaKey) {
    event.preventDefault();
    void toggleFullscreen();
    return;
  }
  if (key === "s") {
    event.preventDefault();
    if (event.shiftKey) saveFileAs();
    else saveFile();
  } else if (key === "p" && !event.shiftKey) {
    event.preventDefault();
    printDocument();
  } else if (key === "n" && !event.shiftKey) {
    event.preventDefault();
    newFile();
  } else if (key === "o" && event.shiftKey) {
    event.preventDefault();
    setPanelVisible(sidePanel.hidden);
  } else if (key === "o") {
    event.preventDefault();
    openFile();
  } else if (key === "f") {
    event.preventDefault();
    openFind();
  } else if (key === "c" && event.shiftKey) {
    event.preventDefault();
    openCountDialog();
  } else if (key === "k") {
    event.preventDefault();
    openLinkDialog();
  } else if (event.key === "\\") {
    event.preventDefault();
    actions.clearFormat();
  } else if (event.shiftKey && (event.key === ">" || event.key === ".")) {
    event.preventDefault();
    actions.sizeUp();
  } else if (event.shiftKey && (event.key === "<" || event.key === ",")) {
    event.preventDefault();
    actions.sizeDown();
  }
});

// Un clic sur le bureau gris (sous la dernière page) remet le curseur à la fin.
desk.addEventListener("mousedown", (event) => {
  if (event.target === desk) {
    event.preventDefault();
    editor.commands.focus("end");
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

// F11 : plein écran (Windows).
window.addEventListener("keydown", (event) => {
  if (event.key === "F11") {
    event.preventDefault();
    void toggleFullscreen();
  }
});
// Sortie du plein écran par le bouton vert ou Échap : la coche suit.
window.addEventListener("resize", () =>
  void isFullscreen().then((on) => document.body.classList.toggle("fullscreen", on)),
);

// --- Commentaires dans la marge, mode sans distraction ------------------------------

commentsView = new CommentsView(editor, paper, desk, {
  author: () => authorName,
  // La marge des commentaires apparaît ou disparaît : le zoom affiché peut changer.
  onLayoutChange: () => setZoom(zoom),
});

focusMode = new FocusMode({
  scroller: desk,
  onChange: () => {
    applyPageSetup();
    refreshPagination(editor.view);
    commentsView?.schedule();
    editor.commands.focus();
  },
  redraw: () => editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false)),
  words: () => plural(tabStats.words, "mot"),
  caretTop: () => {
    try {
      return editor.view.coordsAtPos(editor.state.selection.head).top;
    } catch {
      return null;
    }
  },
});

// --- Notes de bas de page ---------------------------------------------------------

notesView = new NotesView(editor, paper, isPageless);

function insertFootnote() {
  const before = collectNotes(editor.state.doc).length;
  chain().insertFootnote().run();
  // La nouvelle note : celle dont le numéro est juste avant le curseur.
  const pos = editor.state.selection.from - 1;
  const index = collectNotes(editor.state.doc).findIndex((n) => n.pos === pos);
  notesView?.focus(index >= 0 ? index : before);
}

// --- Petite fenêtre « nom » (version, auteur des suggestions) ---------------------

const textDialog = $<HTMLDialogElement>("#text-dialog");
const textInput = $<HTMLInputElement>("#text-input");

function askText(title: string, label: string, value: string, ok: string): Promise<string | null> {
  $("#text-title").textContent = title;
  $("#text-label").textContent = label;
  $<HTMLButtonElement>("#text-ok").textContent = ok;
  textInput.value = value;
  textDialog.returnValue = "";
  textDialog.showModal();
  textInput.select();
  return new Promise((resolve) => {
    textDialog.addEventListener(
      "close",
      () => {
        const text = textInput.value.trim();
        resolve(textDialog.returnValue === "ok" && text ? text : null);
        editor.commands.focus();
      },
      { once: true },
    );
  });
}

// --- Mode suggestion --------------------------------------------------------------

const modeSelect = $<HTMLSelectElement>("#edit-mode");

function setSuggesting(on: boolean) {
  suggesting = on;
  modeSelect.value = on ? "suggest" : "edit";
  document.body.dataset.revision = String(revisionLevel);
  document.body.classList.toggle("suggesting", on);
  setSaveStatus(on ? "Mode suggestion : vos modifications seront proposées" : "");
  editor.commands.focus();
}

modeSelect.addEventListener("change", () => setSuggesting(modeSelect.value === "suggest"));

async function askAuthor() {
  const name = await askText("Suggestions", "Votre nom (affiché sur vos suggestions)", authorName, "OK");
  if (!name) return;
  authorName = name;
  prefs.set("author", name);
}

function resolveAll(accept: boolean, level?: number) {
  const n = listChanges(editor.state.doc).length;
  if (!n) return;
  if (accept) chain().acceptAllChanges(level).run();
  else chain().rejectAllChanges(level).run();
}

const REVISION_COLORS = ["vert", "bleu", "violet", "orange", "rose"];

function setRevisionLevel(level: number) {
  revisionLevel = level;
  prefs.set("revisionLevel", String(level));
  document.body.dataset.revision = String(level);
  if (!suggesting) setSuggesting(true);
}

/** Les niveaux de révision présents dans l'onglet. */
function levelsIn() {
  return [...new Set(listChanges(editor.state.doc).map((c) => c.level))].sort();
}

function suggestionsMenu(): MenuItem[] {
  const changes = listChanges(editor.state.doc).length;
  return [
    { label: "Mode suggestion", shortcut: "⌥⇧⌘X", checked: suggesting, action: () => setSuggesting(!suggesting) },
    SEP,
    { label: `Accepter toutes les suggestions${changes ? ` (${changes})` : ""}`, disabled: !changes, action: () => resolveAll(true) },
    { label: "Refuser toutes les suggestions", disabled: !changes, action: () => resolveAll(false) },
    SEP,
    {
      label: "Niveau de révision",
      submenu: REVISION_COLORS.map((color, i) => ({
        label: `Révision ${i + 1} (${color})`,
        checked: revisionLevel === i + 1,
        action: () => setRevisionLevel(i + 1),
      })),
    },
    {
      label: "Accepter un niveau de révision",
      disabled: !changes,
      submenu: levelsIn().map((n) => ({
        label: `Révision ${n} (${REVISION_COLORS[n - 1]})`,
        action: () => resolveAll(true, n),
      })),
    },
    {
      label: "Refuser un niveau de révision",
      disabled: !changes,
      submenu: levelsIn().map((n) => ({
        label: `Révision ${n} (${REVISION_COLORS[n - 1]})`,
        action: () => resolveAll(false, n),
      })),
    },
    SEP,
    { label: `Votre nom : ${authorName}…`, action: askAuthor },
  ];
}

// Bulle « Accepter / Refuser » quand le curseur est dans une suggestion.
const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function refreshChangeBubble() {
  const bubble = document.getElementById("change-bubble");
  if (!bubble) return;
  const hasFocus = editor.isFocused || bubble.contains(document.activeElement);
  const change = hasFocus && !busy ? changeAt(editor.state) : null;
  if (!change) {
    bubble.hidden = true;
    return;
  }
  const kind = change.kind === "insertion" ? "Ajout" : "Suppression";
  const date = change.date ? DATE_FORMAT.format(new Date(change.date)) : "";
  const level = change.level > 1 ? ` · révision ${change.level}` : "";
  bubble.querySelector(".change-what")!.textContent = `${kind}${change.author ? ` · ${change.author}` : ""}${level}`;
  bubble.querySelector(".change-date")!.textContent = date;
  bubble.dataset.from = String(change.from);
  bubble.dataset.to = String(change.to);
  bubble.hidden = false;
  const at = editor.view.coordsAtPos(change.from);
  const box = bubble.getBoundingClientRect();
  const left = Math.min(window.innerWidth - box.width - 8, Math.max(8, at.left - 12));
  const top = at.top - box.height - 8 < 90 ? at.bottom + 8 : at.top - box.height - 8;
  bubble.style.left = `${left}px`;
  bubble.style.top = `${top}px`;
}

for (const button of document.querySelectorAll<HTMLButtonElement>("#change-bubble [data-change]")) {
  button.addEventListener("mousedown", (e) => e.preventDefault());
  button.addEventListener("click", () => {
    const bubble = $("#change-bubble");
    const from = Number(bubble.dataset.from);
    const to = Number(bubble.dataset.to);
    if (button.dataset.change === "accept") chain().acceptChange(from, to).run();
    else chain().rejectChange(from, to).run();
  });
}
desk.addEventListener("scroll", () => refreshChangeBubble(), { passive: true });
window.addEventListener("resize", () => {
  if (compare?.isOpen) setZoom(zoom);
  fitPanel();
});

/**
 * Comme dans Google Docs : quand la fenêtre devient trop étroite pour la page,
 * le panneau des onglets se replie (sans changer le réglage), puis revient
 * quand la fenêtre s'élargit.
 */
let panelNarrow: boolean | undefined;
function fitPanel() {
  const narrow = window.innerWidth < paper.getBoundingClientRect().width + 270 + 64;
  if (narrow === panelNarrow) return;
  panelNarrow = narrow;
  if (narrow && !sidePanel.hidden) {
    sidePanel.hidden = true;
    panelShow.hidden = false;
    panelAutoHidden = true;
  } else if (!narrow && panelAutoHidden) {
    panelAutoHidden = false;
    sidePanel.hidden = false;
    panelShow.hidden = true;
    renderPanel();
  }
}
fitPanel();

// --- Versions et comparaison côte à côte --------------------------------------------

interface VersionInfo {
  id: string;
  name: string;
  date: string;
}

let versionList: VersionInfo[] = [];
const comparePane = $<HTMLElement>("#compare-pane");
const compareSelect = $<HTMLSelectElement>("#compare-select");

compare = new CompareView({
  editor,
  tabs,
  pane: comparePane,
  paper: $("#compare-paper"),
  mainPaper: paper,
  desk,
  host: $("#compare-editor"),
  extensions: () => documentExtensions(),
  onChange: () => {
    renderCompareSelect();
    setZoom(zoom);
  },
  showCount: (changes, missing, before, after) => {
    $("#compare-count").textContent = missing
      ? "Cet onglet n'existe pas dans cette version"
      : changes === 0
        ? "Aucune différence"
        : `${changes.toLocaleString("fr-FR")} ${changes > 1 ? "différences" : "différence"}`;
    const line = (s: { words: number; characters: number }) =>
      `${plural(s.words, "mot")} · ${plural(s.characters, "signe")}`;
    const delta = (n: number, word: string) =>
      n === 0 ? "" : `${n > 0 ? "+" : "−"}${Math.abs(n).toLocaleString("fr-FR")} ${word}${Math.abs(n) > 1 ? "s" : ""}`;
    $("#stats-before").textContent = line(before);
    const changed = [delta(after.words - before.words, "mot"), delta(after.characters - before.characters, "signe")]
      .filter(Boolean)
      .join(", ");
    $("#stats-after").textContent = `${line(after)}${changed ? ` (${changed})` : ""}`;
    $("#stats-after").title = $("#stats-before").title =
      "Pour l'onglet affiché. Signes : espaces compris ; le texte barré d'une suggestion ne compte pas.";
  },
});

const versionDate = (iso: string) =>
  new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

async function refreshVersions() {
  versionList = await invoke<VersionInfo[]>("list_versions", { path: currentPath }).catch(() => []);
  return versionList;
}

async function saveVersion(name?: string) {
  const now = new Date();
  const label =
    name ?? (await askText("Enregistrer une version", "Nom de la version", `Version du ${versionDate(now.toISOString())}`, "Enregistrer"));
  if (!label) return null;
  try {
    const info = await invoke<VersionInfo>("save_version", {
      path: currentPath,
      name: label,
      date: now.toISOString(),
      tabs: tabs.toData(),
    });
    await refreshVersions();
    setSaveStatus(`Version enregistrée : ${label}`);
    return info;
  } catch (e) {
    alert(String(e));
    return null;
  }
}

async function compareWithVersion(version: VersionInfo) {
  try {
    const data = await invoke<TabData[]>("read_version", { path: currentPath, id: version.id });
    compare!.open({ label: `${version.name} (${versionDate(version.date)})`, tabs: data, versionId: version.id });
  } catch (e) {
    alert(String(e));
  }
}

async function compareWithFile() {
  const path = await open({ multiple: false, filters: OPEN_FILTERS });
  if (typeof path !== "string") return;
  try {
    const file = await invoke<NativeFile>("open_document", { path });
    compare!.open({ label: fileName(path), tabs: file.tabs });
  } catch (e) {
    alert(String(e));
  }
}

/** « Original » : la première version, ou une nouvelle si aucune n'existe. */
async function compareWithOriginal() {
  const list = await refreshVersions();
  const original = list[list.length - 1];
  if (original) return compareWithVersion(original);
  const ok = await confirmDialog(
    "Ce document n'a pas encore de version enregistrée. Enregistrer l'état actuel comme original ? Vos prochaines corrections seront comparées à lui.",
    "Enregistrer l'original",
  );
  if (!ok) return;
  const info = await saveVersion("Original");
  if (info) await compareWithVersion(info);
}

async function restoreVersion() {
  const source = compare?.source;
  if (!source) return;
  const ok = await confirmDialog(
    `Remplacer le texte en cours par « ${source.label} » ? L'état actuel est d'abord enregistré comme version, vous pourrez y revenir.`,
    "Restaurer",
  );
  if (!ok) return;
  await saveVersion(`Avant restauration (${versionDate(new Date().toISOString())})`);
  const tabsData = structuredClone(source.tabs);
  compare?.close();
  loading = true;
  tabs.load(tabsData);
  loading = false;
  markDirty();
  renderPanel();
  updateCounts();
}

async function deleteVersion(version: VersionInfo) {
  const ok = await confirmDialog(`Supprimer la version « ${version.name} » ?`, "Supprimer");
  if (!ok) return;
  await invoke("delete_version", { path: currentPath, id: version.id }).catch((e) => alert(String(e)));
  if (compare?.source?.versionId === version.id) compare.close();
  await refreshVersions();
}

function renderCompareSelect() {
  const current = compare?.source;
  compareSelect.replaceChildren(
    ...versionList.map((v) => new Option(`${v.name} — ${versionDate(v.date)}`, v.id)),
    new Option("Un autre fichier…", "__file"),
  );
  if (current && !current.versionId) {
    compareSelect.prepend(new Option(current.label, "__current"));
    compareSelect.value = "__current";
  } else if (current?.versionId) {
    compareSelect.value = current.versionId;
  }
}

compareSelect.addEventListener("change", () => {
  const value = compareSelect.value;
  if (value === "__file") {
    renderCompareSelect();
    compareWithFile();
    return;
  }
  const version = versionList.find((v) => v.id === value);
  if (version) compareWithVersion(version);
});
$("#compare-close").addEventListener("click", () => compare?.close());
const compareMode = $<HTMLSelectElement>("#compare-mode");
compareMode.value = prefs.get("compareMode", "original") === "both" ? "both" : "original";
compare.mode = compareMode.value as "original" | "both";
compareMode.addEventListener("change", () => {
  prefs.set("compareMode", compareMode.value);
  compare?.setMode(compareMode.value as "original" | "both");
});
// Couleurs des corrections : en couleur ou non, et lesquelles.
const DIFF_COLORS = { del: "#a50e0e", ins: "#0d652d" };
const diffColorsDialog = $<HTMLDialogElement>("#diff-colors-dialog");
const diffColored = $<HTMLInputElement>("#diff-colored");
const diffDel = $<HTMLInputElement>("#diff-del-color");
const diffIns = $<HTMLInputElement>("#diff-ins-color");
function applyDiffColors() {
  const colored = prefs.get("diffColored", "1") !== "0";
  const del = prefs.get("diffDel", DIFF_COLORS.del);
  const ins = prefs.get("diffIns", DIFF_COLORS.ins);
  document.body.classList.toggle("diff-plain", !colored);
  document.documentElement.style.setProperty("--diff-del", del);
  document.documentElement.style.setProperty("--diff-ins", ins);
  diffColored.checked = colored;
  diffDel.value = del;
  diffIns.value = ins;
  diffDel.disabled = diffIns.disabled = !colored;
}
applyDiffColors();
$("#compare-colors").addEventListener("click", () => diffColorsDialog.showModal());
diffColored.addEventListener("change", () => {
  prefs.set("diffColored", diffColored.checked ? "1" : "0");
  applyDiffColors();
});
diffDel.addEventListener("input", () => (prefs.set("diffDel", diffDel.value), applyDiffColors()));
diffIns.addEventListener("input", () => (prefs.set("diffIns", diffIns.value), applyDiffColors()));
$("#diff-colors-reset").addEventListener("click", () => {
  prefs.set("diffDel", DIFF_COLORS.del);
  prefs.set("diffIns", DIFF_COLORS.ins);
  applyDiffColors();
});
// Dossier d'enregistrement : choisi une fois, proposé ensuite partout.
const folderDialog = $<HTMLDialogElement>("#folder-dialog");
function showFolder() {
  const dir = saveFolder();
  $("#folder-path").textContent = dir || "Aucun : le système propose le dernier dossier utilisé.";
  $("#folder-path").classList.toggle("muted", !dir);
  $<HTMLButtonElement>("#folder-reset").hidden = !dir;
}
function openFolderDialog() {
  showFolder();
  folderDialog.showModal();
}
$("#folder-choose").addEventListener("click", async () => {
  const dir = await open({ directory: true, multiple: false, defaultPath: saveFolder() || undefined });
  if (typeof dir !== "string") return;
  prefs.set("saveFolder", dir);
  showFolder();
});
$("#folder-reset").addEventListener("click", () => {
  prefs.set("saveFolder", "");
  showFolder();
});
$("#diff-prev").addEventListener("click", () => compare?.go(-1));
$("#diff-next").addEventListener("click", () => compare?.go(1));
$("#compare-restore").addEventListener("click", restoreVersion);

function versionsMenu(): MenuItem[] {
  const list = versionList;
  return [
    { label: "Enregistrer une version…", action: () => saveVersion() },
    SEP,
    { label: "Comparer avec l'original", action: compareWithOriginal },
    {
      label: "Comparer avec une version",
      submenu: list.length
        ? list.map((v) => ({
            label: `${v.name} — ${versionDate(v.date)}`,
            checked: compare?.source?.versionId === v.id,
            action: () => compareWithVersion(v),
          }))
        : [{ label: "Aucune version enregistrée", disabled: true }],
    },
    { label: "Comparer avec un autre fichier…", action: compareWithFile },
    ...(compare?.isOpen ? [{ label: "Fermer la comparaison", action: () => compare?.close() }] : []),
    SEP,
    {
      label: "Supprimer une version",
      submenu: list.length
        ? list.map((v) => ({ label: `${v.name} — ${versionDate(v.date)}`, action: () => deleteVersion(v) }))
        : [{ label: "Aucune version enregistrée", disabled: true }],
    },
  ];
}

/** Recherche (et installe) une nouvelle version de l'application. */
function updateApp(manual: boolean) {
  return checkForUpdates({
    manual,
    save: async () => {
      window.clearTimeout(autosaveTimer);
      await autosave();
    },
    status: setSaveStatus,
  });
}

// --- Démarrage -----------------------------------------------------------------------

tabs.load([{ title: "Onglet 1", document: editor.getJSON() }]);
localizeShortcutTitles();
setStyles(styles, false);
applyPageSetup();
setZoom(zoom);
setPanelVisible(prefs.get("panel", "1") === "1");
refreshToolbar();
toolbar.querySelector('[data-action="spellcheck"]')?.classList.add("active");
updateCounts();
void listen("open-files", () => openRequestedFiles()).catch(() => {});
restoreSession().then(openRequestedFiles);
// Un peu après le lancement, pour ne pas ralentir l'ouverture du document.
setTimeout(() => updateApp(false), 3000);
onFontsChange(() => {
  if (stylesDialog.open) renderStyleDialog();
  refreshToolbar();
});
initFonts();

// En développement, l'éditeur est accessible depuis la console (`editor`).
if (import.meta.env.DEV) (window as unknown as { editor: Editor; tabs: TabTree }).editor = editor;
if (import.meta.env.DEV) (window as unknown as { tabs: TabTree }).tabs = tabs;
