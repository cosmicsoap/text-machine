// Table des matières (Insertion > Table des matières) : la liste des titres
// de l'onglet (« Titre 1 » à « Titre 3 »), avec leur numéro de page en mode
// page. Elle se met à jour toute seule ; un clic sur une ligne y amène.
//
// Dans le document, ce n'est qu'un bloc vide : son contenu est recalculé à
// l'affichage (et par Word, à partir du champ « TOC », à l'ouverture).

import { Node, mergeAttributes, type Editor } from "@tiptap/core";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    tableOfContents: { insertTableOfContents: () => ReturnType };
  }
}

export interface TocOptions {
  /** Numéro de page d'une position du document (null sans pagination). */
  pageOf: (editor: Editor, pos: number) => number | null;
}

/** Les vues ouvertes, pour les mettre à jour. */
const views = new Set<() => void>();

/** Recalcule toutes les tables des matières affichées. */
export function refreshTocs() {
  for (const render of views) render();
}

export const TableOfContents = Node.create<TocOptions>({
  name: "tableOfContents",
  group: "block",
  atom: true,
  selectable: true,
  draggable: false,

  addOptions() {
    return { pageOf: () => null };
  },

  parseHTML: () => [{ tag: "nav[data-toc]" }],

  renderHTML: ({ HTMLAttributes }) => ["nav", mergeAttributes(HTMLAttributes, { "data-toc": "", class: "toc" })],

  addCommands() {
    return {
      insertTableOfContents:
        () =>
        ({ commands }) =>
          commands.insertContent([{ type: this.name }, { type: "paragraph" }]),
    };
  },

  addNodeView() {
    const options = this.options;
    return ({ editor }) => {
      const dom = document.createElement("nav");
      dom.className = "toc";
      dom.dataset.toc = "";
      dom.contentEditable = "false";
      let signature = "";

      const render = () => {
        if (editor.isDestroyed) return;
        const entries: { level: number; text: string; pos: number; page: number | null }[] = [];
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name === "heading") {
            if (node.attrs.level >= 2 && node.textContent.trim()) {
              entries.push({
                level: node.attrs.level,
                text: node.textContent.trim(),
                pos,
                page: options.pageOf(editor, pos),
              });
            }
            return false;
          }
          return true;
        });
        const next = JSON.stringify(entries.map((e) => [e.level, e.text, e.page]));
        if (next === signature) return;
        signature = next;
        const title = document.createElement("div");
        title.className = "toc-title";
        title.textContent = "Table des matières";
        const list = document.createElement("ol");
        for (const entry of entries) {
          const li = document.createElement("li");
          li.className = `toc-entry level-${entry.level}`;
          const text = document.createElement("span");
          text.className = "toc-text";
          text.textContent = entry.text;
          li.append(text);
          if (entry.page !== null) {
            const page = document.createElement("span");
            page.className = "toc-page";
            page.textContent = String(entry.page);
            li.append(page);
          }
          li.addEventListener("mousedown", (e) => {
            e.preventDefault();
            // La position a pu changer depuis l'affichage : on cherche le titre.
            let target = -1;
            let index = entries.indexOf(entry);
            editor.state.doc.descendants((node, pos) => {
              if (target >= 0) return false;
              if (node.type.name === "heading") {
                if (node.attrs.level >= 2 && node.textContent.trim() && index-- === 0) target = pos;
                return false;
              }
              return true;
            });
            if (target < 0) return;
            editor.chain().focus().setTextSelection(target + 1).run();
            (editor.view.nodeDOM(target) as HTMLElement | null)?.scrollIntoView({ block: "start", behavior: "smooth" });
          });
          list.append(li);
        }
        if (!entries.length) {
          const empty = document.createElement("li");
          empty.className = "toc-empty";
          empty.textContent = "Ajoutez des titres (Titre 1, 2 ou 3) : ils apparaîtront ici.";
          list.append(empty);
        }
        dom.replaceChildren(title, list);
        // La hauteur a changé : les pages doivent être recalculées.
        queueMicrotask(() => {
          if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
        });
      };

      views.add(render);
      queueMicrotask(render);
      return {
        dom,
        ignoreMutation: () => true,
        stopEvent: (event) => event.type === "mousedown",
        destroy: () => views.delete(render),
      };
    };
  },
});
