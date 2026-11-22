// Surlignage des différences entre deux versions (voir compare.ts) :
// décorations posées de l'extérieur, qui ne font pas partie du document.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

const key = new PluginKey<DecorationSet>("diff-highlight");

export interface DiffRange {
  from: number;
  to: number;
  /** Bloc entier (image, ligne, saut de page…) plutôt que du texte. */
  block?: boolean;
}

export const DiffHighlight = Extension.create({
  name: "diffHighlight",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const next = tr.getMeta(key);
            if (next) return next;
            return set.map(tr.mapping, tr.doc);
          },
        },
        props: { decorations: (state) => key.getState(state) },
      }),
    ];
  },
});

/** Remplace les surlignages : `kind` donne la couleur (ajout ou retrait). */
export function setDiffHighlights(view: EditorView, ranges: DiffRange[], kind: "ins" | "del") {
  const doc = view.state.doc;
  const max = doc.content.size;
  const decorations = ranges
    .filter((r) => r.to > r.from && r.from >= 0 && r.to <= max)
    .map((r) =>
      r.block
        ? Decoration.node(r.from, r.to, { class: `diff-${kind} diff-block` })
        : Decoration.inline(r.from, r.to, { class: `diff-${kind}` }),
    );
  view.dispatch(
    view.state.tr.setMeta(key, DecorationSet.create(doc, decorations)).setMeta("addToHistory", false),
  );
}
