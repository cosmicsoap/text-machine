// Notes de bas de page, comme dans Google Docs (Insertion > Note de bas de
// page, ⌥⌘F, raccourci géré par main.ts) : un numéro en exposant dans le texte. Le texte de la note est
// un attribut de ce numéro ; il est affiché et modifié en bas de la page
// (voir notes.ts), ou à la fin du document sans pagination.
//
// Les numéros suivent l'ordre du texte : ils sont recalculés à l'affichage.

import { Node, mergeAttributes } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    footnote: { insertFootnote: (content?: string) => ReturnType };
  }
}

export const newNoteId = () => `n${Math.random().toString(36).slice(2, 9)}`;

/** Les notes d'un document, dans l'ordre : position du numéro et texte. */
export function collectNotes(doc: PMNode): { pos: number; content: string }[] {
  const notes: { pos: number; content: string }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "footnote") notes.push({ pos, content: node.attrs.content ?? "" });
    return true;
  });
  return notes;
}

export const Footnote = Node.create({
  name: "footnote",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      id: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-id") ?? "",
        renderHTML: (attrs) => ({ "data-id": attrs.id }),
      },
      content: {
        default: "",
        parseHTML: (el) => el.getAttribute("data-note") ?? "",
        renderHTML: (attrs) => ({ "data-note": attrs.content }),
      },
    };
  },

  parseHTML: () => [{ tag: "sup[data-footnote]" }],

  renderHTML: ({ HTMLAttributes }) => [
    "sup",
    mergeAttributes(HTMLAttributes, { "data-footnote": "", class: "footnote-ref" }),
  ],

  addCommands() {
    return {
      insertFootnote:
        (content = "") =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { id: newNoteId(), content } }),
    };
  },

});
