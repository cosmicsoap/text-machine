// Mode sans distraction : le paragraphe en cours reste net, les autres
// s'estompent (comme le « mode focus » d'iA Writer).

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

export interface FocusParagraphOptions {
  isOn: () => boolean;
}

export const focusParagraphKey = new PluginKey("focusParagraph");

export const FocusParagraph = Extension.create<FocusParagraphOptions>({
  name: "focusParagraph",
  addOptions: () => ({ isOn: () => false }),
  addProseMirrorPlugins() {
    const isOn = this.options.isOn;
    return [
      new Plugin({
        key: focusParagraphKey,
        props: {
          decorations(state) {
            if (!isOn()) return DecorationSet.empty;
            const { $from } = state.selection;
            if ($from.depth < 1) return DecorationSet.empty;
            // Le bloc de texte en cours (dans une liste ou un tableau aussi).
            let depth = $from.depth;
            while (depth > 1 && !$from.node(depth).isTextblock) depth--;
            const start = $from.before(depth);
            const node = $from.node(depth);
            return DecorationSet.create(state.doc, [
              Decoration.node(start, start + node.nodeSize, { class: "is-current" }),
            ]);
          },
        },
      }),
    ];
  },
});
