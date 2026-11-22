// Comparaison côte à côte (Fichier > Versions) : à gauche une version
// enregistrée (ou un autre fichier), en lecture seule ; à droite le texte en
// cours. Les différences sont surlignées pendant la frappe : en rouge barré
// à gauche ce qui a été retiré, en vert à droite ce qui a été ajouté.

import { Editor, createDocument, type AnyExtension, type JSONContent } from "@tiptap/core";
import { DecorationSet } from "@tiptap/pm/view";
import type { EditorState } from "@tiptap/pm/state";
import { compareDocs } from "./diff";
import { setDiffHighlights } from "./extensions/diff-highlight";
import type { TabData, TabTree } from "./tabs";

const EMPTY: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

/** Ce qui est comparé au texte en cours. */
export interface CompareSource {
  label: string;
  tabs: TabData[];
  /** Identifiant de la version (absent pour un autre fichier). */
  versionId?: string;
}

function findTab(tabs: TabData[], id: string, title: string): TabData | null {
  const flat: TabData[] = [];
  const walk = (list: TabData[]) => list.forEach((t) => (flat.push(t), walk(t.children ?? [])));
  walk(tabs);
  return flat.find((t) => t.id === id) ?? flat.find((t) => t.title === title) ?? (flat.length === 1 ? flat[0] : null);
}

/** Enlève les surlignages d'un état d'éditeur (onglets non affichés). */
function cleared(state: EditorState): EditorState {
  const plugin = state.plugins.find((p) => (p as unknown as { key: string }).key.startsWith("diff-highlight"));
  if (!plugin) return state;
  return state.apply(state.tr.setMeta(plugin, DecorationSet.empty).setMeta("addToHistory", false));
}

export class CompareView {
  source: CompareSource | null = null;
  private viewer: Editor | null = null;
  private timer: number | undefined;
  private syncing = false;

  constructor(
    private deps: {
      editor: Editor;
      tabs: TabTree;
      pane: HTMLElement;
      paper: HTMLElement;
      mainPaper: HTMLElement;
      desk: HTMLElement;
      host: HTMLElement;
      extensions: () => AnyExtension[];
      /** Après l'ouverture ou la fermeture (pour la barre de titre, les menus…). */
      onChange: () => void;
      showCount: (changes: number, missing: boolean) => void;
    },
  ) {
    const scroller = deps.pane.querySelector<HTMLElement>(".compare-desk")!;
    // Défilement : les deux côtés suivent à peu près la même proportion.
    const sync = (from: HTMLElement, to: HTMLElement) => () => {
      if (this.syncing || !this.source) return;
      this.syncing = true;
      const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
      to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
      requestAnimationFrame(() => (this.syncing = false));
    };
    deps.desk.addEventListener("scroll", sync(deps.desk, scroller));
    scroller.addEventListener("scroll", sync(scroller, deps.desk));
  }

  get isOpen() {
    return this.source !== null;
  }

  open(source: CompareSource) {
    this.source = source;
    if (!this.viewer) {
      this.viewer = new Editor({
        element: this.deps.host,
        extensions: this.deps.extensions(),
        editable: false,
        content: EMPTY,
        editorProps: { attributes: { spellcheck: "false", lang: "fr" } },
      });
    }
    this.deps.pane.hidden = false;
    document.body.classList.add("comparing");
    this.showTab();
    this.deps.onChange();
  }

  close() {
    if (!this.source) return;
    this.source = null;
    this.deps.pane.hidden = true;
    document.body.classList.remove("comparing");
    window.clearTimeout(this.timer);
    setDiffHighlights(this.deps.editor.view, [], "ins");
    for (const { node } of this.deps.tabs.flat()) {
      if (node.state && node.id !== this.deps.tabs.activeId) node.state = cleared(node.state);
    }
    this.deps.onChange();
  }

  /** Un autre onglet est affiché : on montre le même dans la version. */
  showTab() {
    if (!this.source || !this.viewer) return;
    const active = this.deps.tabs.active();
    const tab = findTab(this.source.tabs, active.id, active.title);
    let doc;
    try {
      doc = createDocument(tab?.document ?? EMPTY, this.viewer.schema);
    } catch {
      doc = createDocument(EMPTY, this.viewer.schema);
    }
    this.viewer.commands.setContent(doc.toJSON(), { emitUpdate: false });
    this.missing = !tab;
    this.copyPage();
    this.refresh();
  }

  private missing = false;

  /** Même largeur de page, mêmes marges et même zoom que le texte en cours. */
  copyPage() {
    const from = this.deps.mainPaper.style;
    const to = this.deps.paper.style;
    for (const name of ["--page-w", "--page-h", "--m-top", "--m-bottom", "--m-left", "--m-right"]) {
      to.setProperty(name, from.getPropertyValue(name));
    }
    to.setProperty("zoom", from.getPropertyValue("zoom") || "1");
  }

  /** À chaque modification : on recompare (un peu après la frappe). */
  schedule() {
    if (!this.source) return;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.refresh(), 250);
  }

  refresh() {
    if (!this.source || !this.viewer) return;
    window.clearTimeout(this.timer);
    const { removed, added, changes } = compareDocs(this.viewer.state.doc, this.deps.editor.state.doc);
    setDiffHighlights(this.viewer.view, removed, "del");
    setDiffHighlights(this.deps.editor.view, added, "ins");
    this.deps.showCount(changes, this.missing);
  }
}
