// Mise en forme des paragraphes qui manque à TipTap : interligne et retrait
// à gauche. Ces réglages sont des attributs des paragraphes et des titres,
// enregistrés dans le document (voir `BlockStyle` dans tm-model).

import { Extension } from "@tiptap/core";

/** Largeur d'un cran de retrait, comme dans Google Docs (0,5 pouce). */
export const INDENT_STEP_CM = 1.27;
export const MAX_INDENT = 8;

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    paragraphFormat: {
      setBlockLineHeight: (lineHeight: string | null) => ReturnType;
      indent: () => ReturnType;
      outdent: () => ReturnType;
    };
  }
}

const TYPES = ["paragraph", "heading"];

export const ParagraphFormat = Extension.create({
  name: "paragraphFormat",

  addGlobalAttributes() {
    return [
      {
        types: TYPES,
        attributes: {
          lineHeight: {
            default: null,
            parseHTML: (el) => el.style.lineHeight || null,
            renderHTML: (attrs) =>
              attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {},
          },
          indent: {
            default: null,
            parseHTML: (el) => {
              const cm = parseFloat(el.style.marginLeft);
              return cm > 0 ? Math.round(cm / INDENT_STEP_CM) || null : null;
            },
            renderHTML: (attrs) =>
              attrs.indent
                ? { style: `margin-left: ${attrs.indent * INDENT_STEP_CM}cm` }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    const changeIndent =
      (delta: number) =>
      () =>
      ({ tr, state, dispatch }: any) => {
        const { from, to } = state.selection;
        let changed = false;
        state.doc.nodesBetween(from, to, (node: any, pos: number) => {
          if (!TYPES.includes(node.type.name)) return;
          const next = Math.min(MAX_INDENT, Math.max(0, (node.attrs.indent ?? 0) + delta));
          if (next === (node.attrs.indent ?? 0)) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next || null });
          changed = true;
        });
        if (changed && dispatch) dispatch(tr);
        return changed;
      };

    return {
      setBlockLineHeight:
        (lineHeight) =>
        ({ commands }) =>
          TYPES.map((t) => commands.updateAttributes(t, { lineHeight })).some(Boolean),
      indent: changeIndent(1),
      outdent: changeIndent(-1),
    };
  },

  addKeyboardShortcuts() {
    // Dans une liste, Tab change le niveau de la liste (géré par TipTap) ;
    // ailleurs, il augmente le retrait du paragraphe.
    const inList = () =>
      this.editor.isActive("listItem") || this.editor.isActive("taskItem");
    return {
      Tab: () => (inList() ? false : this.editor.commands.indent() || true),
      "Shift-Tab": () => (inList() ? false : this.editor.commands.outdent() || true),
    };
  },
});
