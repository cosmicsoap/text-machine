// Pagination à l'écran : le texte reste un seul bloc éditable, mais on
// dessine des feuilles derrière lui et on insère des espaces (décorations
// ProseMirror, qui ne font pas partie du document) pour repousser à la page
// suivante chaque bloc qui dépasserait du bas de sa page.
//
// Limite connue : un bloc n'est jamais coupé en deux. Un paragraphe qui ne
// tient pas en bas d'une page passe en entier sur la suivante, et un bloc
// plus haut qu'une page entière déborde.

import { Extension, Node, mergeAttributes } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface PageSetup {
  size: "A4" | "Letter";
  landscape: boolean;
  /** Marges en millimètres. */
  margins: { top: number; bottom: number; left: number; right: number };
  pageNumbers: boolean;
  /** Affichage continu, sans pages (l'export PDF garde les pages). */
  pageless: boolean;
  /** En-tête et pied de page (le même sur chaque page ; vide : aucun). */
  header: string;
  footer: string;
  /** Rien en haut ni en bas de la première page (page de titre). */
  differentFirstPage: boolean;
}

export const DEFAULT_PAGE_SETUP: PageSetup = {
  size: "A4",
  landscape: false,
  margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
  pageNumbers: true,
  pageless: false,
  header: "",
  footer: "",
  differentFirstPage: false,
};

const SIZES_MM = { A4: [210, 297], Letter: [215.9, 279.4] } as const;
const PX_PER_MM = 96 / 25.4;
/** Espace gris entre deux feuilles à l'écran (`--page-gap`, 0 à l'impression). */
export const SCREEN_GAP_PX = 24;

export function pageSizePx(setup: PageSetup) {
  const [w, h] = SIZES_MM[setup.size];
  const [width, height] = setup.landscape ? [h, w] : [w, h];
  return { width: width * PX_PER_MM, height: height * PX_PER_MM };
}

export const mmToPx = (mm: number) => mm * PX_PER_MM;

// --- Saut de page manuel -----------------------------------------------------

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    pageBreak: { setPageBreak: () => ReturnType };
  }
}

export const PageBreak = Node.create({
  name: "pageBreak",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-page-break]" }],
  renderHTML: ({ HTMLAttributes }) => [
    "div",
    mergeAttributes(HTMLAttributes, { "data-page-break": "", class: "page-break" }),
  ],
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ chain }) =>
          chain()
            .insertContent([{ type: "pageBreak" }, { type: "paragraph" }])
            .run(),
    };
  },
  addKeyboardShortcuts() {
    return { "Mod-Enter": () => this.editor.commands.setPageBreak() };
  },
});

// --- Calcul des pages --------------------------------------------------------

const key = new PluginKey<{ decorations: DecorationSet; breaks: string }>("pagination");

interface Layout {
  /** Position (dans le document) du bloc qui commence chaque nouvelle page, et hauteur de l'espace à insérer avant. */
  breaks: { pos: number; height: number }[];
  pages: number;
  /** Page (à partir de 0) de chaque note de bas de page, dans l'ordre. */
  notePages: number[];
}

/** Hauteurs des notes d'un bloc (en pixels de la page). */
function blockNotes(node: PMNode, noteHeight: PaginationOptions["noteHeight"], index: number) {
  const heights: number[] = [];
  node.descendants((child) => {
    if (child.type.name === "footnote") heights.push(noteHeight(child.attrs.content ?? "", index + heights.length));
    return true;
  });
  return heights;
}

/**
 * Mesure chaque bloc tel qu'il est affiché et décide où commencent les
 * pages. On parcourt les blocs de haut en bas : dès qu'un bloc (avec les
 * notes de bas de page qu'il appelle) dépasserait du bas de la page en
 * cours, il commence une nouvelle page, et on note la hauteur de l'espace à
 * insérer avant lui pour le pousser en haut de la feuille suivante.
 */
function computeLayout(view: EditorView, setup: PageSetup, options: PaginationOptions): Layout {
  const notePages: number[] = [];
  if (setup.pageless) {
    view.state.doc.descendants((n) => {
      if (n.type.name === "footnote") notePages.push(0);
      return true;
    });
    return { breaks: [], pages: 1, notePages };
  }
  const { width, height } = pageSizePx(setup);
  const top = mmToPx(setup.margins.top);
  const bottom = mmToPx(setup.margins.bottom);
  const usable = height - top - bottom;
  const root = view.dom as HTMLElement;
  // Avec le zoom, les mesures à l'écran sont agrandies : on les ramène en
  // pixels de la page.
  const rootRect = root.getBoundingClientRect();
  const scale = rootRect.width > 0 ? rootRect.width / width : 1;
  const rootTop = rootRect.top / scale + top;

  const breaks: Layout["breaks"] = [];
  let spacers = 0; // hauteur des espaces déjà présents au-dessus du bloc courant
  let pageStart = 0; // début de la page courante, en coordonnées « sans espaces »
  let first = true;
  let forceBreak = false;
  let notesHeight = 0; // hauteur des notes de la page courante (séparateur compris)

  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return;
    // Les espaces insérés avant ce bloc ne comptent pas dans sa position.
    const prev = dom.previousElementSibling;
    if (prev?.classList.contains("page-spacer")) spacers += prev.getBoundingClientRect().height / scale;
    const rect = dom.getBoundingClientRect();
    const blockTop = rect.top / scale - rootTop - spacers;
    const blockBottom = rect.bottom / scale - rootTop - spacers;

    // Les notes appelées dans ce bloc vont en bas de la même page.
    const notes = blockNotes(node, options.noteHeight, notePages.length);
    const own = notes.reduce((a, b) => a + b, 0);
    const withNotes = (current: number) => (current + own > 0 ? current + own + NOTE_SEPARATOR_PX : 0);
    if (!first && (forceBreak || blockBottom - pageStart > usable - withNotes(notesHeight))) {
      const used = blockTop - pageStart;
      breaks.push({ pos: offset, height: Math.max(0, usable - used) + bottom + top });
      pageStart = blockTop;
      notesHeight = 0;
    }
    notesHeight += own;
    for (let i = 0; i < notes.length; i++) notePages.push(breaks.length);
    first = false;
    forceBreak = node.type.name === "pageBreak";
  });

  return { breaks, pages: breaks.length + 1, notePages };
}

/**
 * L'espace entre deux feuilles dépend de `--page-gap` (24 px à l'écran,
 * 0 à l'impression) : l'impression découpe ainsi exactement aux mêmes
 * endroits qu'à l'écran, sans recalcul.
 */
function spacer(height: number) {
  const el = document.createElement("div");
  el.className = "page-spacer";
  el.contentEditable = "false";
  el.style.height = `calc(${height}px + var(--page-gap))`;
  return el;
}

/** Place du trait au-dessus des notes de bas de page. */
export const NOTE_SEPARATOR_PX = 18;

export interface PaginationOptions {
  getSetup: () => PageSetup;
  /** Appelé après chaque calcul, pour dessiner les feuilles et les notes. */
  onLayout: (pages: number, notePages: number[]) => void;
  /** Hauteur d'une note de bas de page (texte, numéro `index` à partir de 0). */
  noteHeight: (content: string, index: number) => number;
}

export const Pagination = Extension.create<PaginationOptions>({
  name: "pagination",

  addOptions() {
    return {
      getSetup: () => DEFAULT_PAGE_SETUP,
      onLayout: () => {},
      noteHeight: () => 0,
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let frame = 0;

    // Recalcul des pages, au plus une fois par image affichée
    // (requestAnimationFrame) : taper plusieurs lettres très vite ne lance
    // qu'un calcul. Si les coupures n'ont pas changé (même « signature »),
    // on ne touche à rien ; sinon on remplace les espaces entre les pages.
    const relayout = (view: EditorView) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (view.isDestroyed) return;
        const layout = computeLayout(view, options.getSetup(), options);
        const signature = layout.breaks.map((b) => `${b.pos}:${Math.round(b.height)}`).join(",");
        options.onLayout(layout.pages, layout.notePages);
        if (signature === key.getState(view.state)!.breaks) return;
        const decorations = DecorationSet.create(
          view.state.doc,
          layout.breaks.map((b) =>
            Decoration.widget(b.pos, () => spacer(b.height), {
              side: -1,
              key: `page-${b.pos}-${Math.round(b.height)}`,
              ignoreSelection: true,
            }),
          ),
        );
        view.dispatch(
          view.state.tr.setMeta(key, { decorations, breaks: signature }).setMeta("addToHistory", false),
        );
      });
    };

    return [
      new Plugin({
        key,
        state: {
          init: () => ({ decorations: DecorationSet.empty, breaks: "" }),
          apply(tr, value) {
            const next = tr.getMeta(key);
            if (next) return next;
            return { ...value, decorations: value.decorations.map(tr.mapping, tr.doc) };
          },
        },
        props: {
          decorations: (state) => key.getState(state)!.decorations,
        },
        view(view) {
          relayout(view);
          // Les images se chargent après coup et changent les hauteurs.
          const onLoad = () => relayout(view);
          view.dom.addEventListener("load", onLoad, true);
          return {
            update: (v) => relayout(v),
            destroy: () => view.dom.removeEventListener("load", onLoad, true),
          };
        },
      }),
    ];
  },
});

/** Force un nouveau calcul (après un changement de format de page). */
export function refreshPagination(view: EditorView) {
  view.dispatch(
    view.state.tr.setMeta(key, { decorations: DecorationSet.empty, breaks: "" }).setMeta("addToHistory", false),
  );
}
