// Styles créés par l'utilisateur : un attribut `customStyle` sur les
// paragraphes (style de paragraphe) et une marque `charStyle` sur le texte
// (style de caractère). L'apparence vient de la feuille de styles
// (stylesheet.ts), qui produit les règles CSS correspondantes.

import { Extension, Mark, mergeAttributes } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    customStyles: {
      setCustomParagraphStyle: (id: string | null) => ReturnType;
      setCharStyle: (id: string) => ReturnType;
      unsetCharStyle: () => ReturnType;
    };
    fontWeight: {
      /** Graisse du texte (« 300 », « 600 »…) ; null la retire. */
      setFontWeight: (weight: string | null) => ReturnType;
    };
  }
}

export const CustomParagraphStyle = Extension.create({
  name: "customParagraphStyle",

  addGlobalAttributes() {
    return [
      {
        types: ["paragraph"],
        attributes: {
          customStyle: {
            default: null,
            parseHTML: (el) => el.getAttribute("data-custom-style"),
            renderHTML: (attrs) =>
              attrs.customStyle ? { "data-custom-style": attrs.customStyle } : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setCustomParagraphStyle:
        (id) =>
        ({ chain }) =>
          chain().setParagraph().updateAttributes("paragraph", { customStyle: id }).run(),
    };
  },
});

export const CharStyle = Mark.create({
  name: "charStyle",
  // Un autre style de caractère remplace celui-ci (pas d'empilement).
  excludes: "charStyle",

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-char-style"),
        renderHTML: (attrs) => ({ "data-char-style": attrs.id }),
      },
    };
  },

  parseHTML: () => [{ tag: "span[data-char-style]" }],
  renderHTML: ({ HTMLAttributes }) => ["span", mergeAttributes(HTMLAttributes), 0],

  addCommands() {
    return {
      setCharStyle:
        (id) =>
        ({ commands }) =>
          commands.setMark(this.name, { id }),
      unsetCharStyle:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

/** Graisse du texte (Light, Medium, SemiBold…), portée par `textStyle`. */
export const FontWeight = Extension.create({
  name: "fontWeight",

  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontWeight: {
            default: null,
            parseHTML: (el) => {
              const w = el.style.fontWeight;
              return /^\d+$/.test(w) ? w : null;
            },
            renderHTML: (attrs) => (attrs.fontWeight ? { style: `font-weight: ${attrs.fontWeight}` } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setFontWeight:
        (weight) =>
        ({ chain }) =>
          chain().setMark("textStyle", { fontWeight: weight }).removeEmptyTextStyle().run(),
    };
  },
});
