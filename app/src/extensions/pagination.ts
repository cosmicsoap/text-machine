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

export interface PageSetup {
  size: "A4" | "Letter";
  landscape: boolean;
  /** Marges en millimètres. */
  margins: { top: number; bottom: number; left: number; right: number };
  pageNumbers: boolean;
  /** Affichage continu, sans pages (l'export PDF garde les pages). */
  pageless: boolean;
}

export const DEFAULT_PAGE_SETUP: PageSetup = {
  size: "A4",
  landscape: false,
  margins: { top: 25.4, bottom: 25.4, left: 25.4, right: 25.4 },
  pageNumbers: true,
  pageless: false,
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
}

function computeLayout(view: EditorView, setup: PageSetup): Layout {
  if (setup.pageless) return { breaks: [], pages: 1 };
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

  view.state.doc.forEach((node, offset) => {
    const dom = view.nodeDOM(offset) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return;
    // Les espaces insérés avant ce bloc ne comptent pas dans sa position.
    const prev = dom.previousElementSibling;
    if (prev?.classList.contains("page-spacer")) spacers += prev.getBoundingClientRect().height / scale;
    const rect = dom.getBoundingClientRect();
    const blockTop = rect.top / scale - rootTop - spacers;
    const blockBottom = rect.bottom / scale - rootTop - spacers;

    if (!first && (forceBreak || blockBottom - pageStart > usable)) {
      const used = blockTop - pageStart;
      breaks.push({ pos: offset, height: Math.max(0, usable - used) + bottom + top });
      pageStart = blockTop;
    }
    first = false;
    forceBreak = node.type.name === "pageBreak";
  });

  return { breaks, pages: breaks.length + 1 };
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

export interface PaginationOptions {
  getSetup: () => PageSetup;
  /** Appelé quand le nombre de pages change, pour dessiner les feuilles. */
  onLayout: (pages: number) => void;
}

export const Pagination = Extension.create<PaginationOptions>({
  name: "pagination",

  addOptions() {
    return {
      getSetup: () => DEFAULT_PAGE_SETUP,
      onLayout: () => {},
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    let frame = 0;

    const relayout = (view: EditorView) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (view.isDestroyed) return;
        const layout = computeLayout(view, options.getSetup());
        const signature = layout.breaks.map((b) => `${b.pos}:${Math.round(b.height)}`).join(",");
        options.onLayout(layout.pages);
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
