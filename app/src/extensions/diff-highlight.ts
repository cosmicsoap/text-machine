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

/** Texte ajouté, montré dans la version d'origine (il n'y est pas). */
export interface DiffWidget {
  pos: number;
  text: string;
  level: number;
}

/** Remplace les surlignages : `kind` donne la couleur (ajout ou retrait). */
export function setDiffHighlights(view: EditorView, ranges: DiffRange[], kind: "ins" | "del", widgets: DiffWidget[] = []) {
  const doc = view.state.doc;
  const max = doc.content.size;
  const shown = widgets
    .filter((w) => w.pos >= 0 && w.pos <= max)
    .map((w, i) =>
      Decoration.widget(
        w.pos,
        () => {
          const span = document.createElement("span");
          span.className = "diff-ins diff-widget";
          if (w.level > 1) span.dataset.level = String(w.level);
          // Un retour à la ligne ajouté passe vraiment à la ligne.
          w.text.split("\n").forEach((part, k) => {
            if (k > 0) {
              // Pas de <br> : ProseMirror les traite à part dans le texte.
              const br = document.createElement("span");
              br.className = "diff-break";
              span.append(br);
            }
            if (part) span.append(part);
          });
          return span;
        },
        { side: -1, key: `w${i}-${w.pos}-${w.level}-${w.text}`, marks: [] },
      ),
    );
  const decorations = ranges
    .filter((r) => r.to > r.from && r.from >= 0 && r.to <= max)
    .map((r) =>
      r.block
        ? Decoration.node(r.from, r.to, { class: `diff-${kind} diff-block` })
        : Decoration.inline(r.from, r.to, { class: `diff-${kind}` }),
    )
    .concat(shown);
  view.dispatch(
    view.state.tr.setMeta(key, DecorationSet.create(doc, decorations)).setMeta("addToHistory", false),
  );
}
