// Onglets du document, comme dans Google Docs : chaque onglet a son propre
// contenu (et son propre historique annuler / rétablir), et peut avoir des
// sous-onglets, sur trois niveaux au plus.
//
// Un seul éditeur sert pour tous les onglets : changer d'onglet remplace son
// état (le document, la sélection, l'historique) par celui de l'onglet.

import { createDocument, type Editor, type JSONContent } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";

/** Ce qui est enregistré (même forme que `Tab` dans tm-model). */
export interface TabData {
  id?: string;
  title: string;
  document: JSONContent;
  children?: TabData[];
}

export interface TabNode {
  id: string;
  title: string;
  children: TabNode[];
  /** État de l'éditeur une fois l'onglet ouvert (avec son historique). */
  state: EditorState | null;
  /** Contenu, tant que l'onglet n'a jamais été ouvert. */
  json: JSONContent;
  /** Sous-onglets affichés dans le panneau. */
  expanded: boolean;
}

export const MAX_TAB_LEVEL = 3;
const EMPTY_DOC: JSONContent = { type: "doc", content: [{ type: "paragraph" }] };

const newId = () => Math.random().toString(36).slice(2, 10);

export class TabTree {
  roots: TabNode[] = [];
  activeId = "";

  constructor(
    private editor: Editor,
    /** Appelé quand l'onglet affiché change. */
    private onSwitch: () => void,
    /** Appelé quand les onglets changent (titre, ordre, ajout…). */
    private onChange: () => void,
  ) {}

  private node(data: TabData): TabNode {
    return {
      id: data.id || newId(),
      title: data.title || "Sans titre",
      children: (data.children ?? []).map((c) => this.node(c)),
      state: null,
      json: data.document ?? EMPTY_DOC,
      expanded: true,
    };
  }

  private createState(json: JSONContent) {
    let doc;
    try {
      doc = createDocument(json, this.editor.schema);
    } catch {
      doc = createDocument(EMPTY_DOC, this.editor.schema);
    }
    return EditorState.create({ doc, plugins: this.editor.state.plugins });
  }

  /** Remplace tous les onglets (ouverture d'un fichier). */
  load(tabs: TabData[]) {
    this.roots = (tabs.length ? tabs : [{ title: "Onglet 1", document: EMPTY_DOC }]).map((t) =>
      this.node(t),
    );
    this.activeId = "";
    this.show(this.roots[0]);
  }

  /** Les onglets tels qu'ils seront enregistrés. */
  toData(): TabData[] {
    const walk = (nodes: TabNode[]): TabData[] =>
      nodes.map((n) => ({
        id: n.id,
        title: n.title,
        document: this.documentOf(n),
        children: walk(n.children),
      }));
    return walk(this.roots);
  }

  documentOf(node: TabNode): JSONContent {
    if (node.id === this.activeId) return this.editor.state.doc.toJSON();
    return node.state ? node.state.doc.toJSON() : node.json;
  }

  /** Tous les onglets dans l'ordre du panneau, avec leur niveau (0 = onglet). */
  flat(): { node: TabNode; depth: number }[] {
    const out: { node: TabNode; depth: number }[] = [];
    const walk = (nodes: TabNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ node: n, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(this.roots, 0);
    return out;
  }

  count() {
    return this.flat().length;
  }

  find(id: string) {
    return this.flat().find((e) => e.node.id === id);
  }

  /** La liste qui contient l'onglet, et sa place dans cette liste. */
  private siblings(id: string): { list: TabNode[]; index: number; parent: TabNode | null } | null {
    const search = (list: TabNode[], parent: TabNode | null): ReturnType<TabTree["siblings"]> => {
      const index = list.findIndex((n) => n.id === id);
      if (index >= 0) return { list, index, parent };
      for (const n of list) {
        const found = search(n.children, n);
        if (found) return found;
      }
      return null;
    };
    return search(this.roots, null);
  }

  active(): TabNode {
    return this.find(this.activeId)?.node ?? this.roots[0];
  }

  /** Affiche un onglet dans l'éditeur. */
  private show(node: TabNode) {
    const current = this.find(this.activeId)?.node;
    if (current && current !== node) current.state = this.editor.state;
    if (!node.state) node.state = this.createState(node.json);
    this.activeId = node.id;
    this.editor.view.updateState(node.state);
    this.onSwitch();
  }

  activate(id: string) {
    if (id === this.activeId) return;
    const found = this.find(id);
    if (found) this.show(found.node);
  }

  /** Nouvel onglet après `afterId` (ou à la fin), ou sous-onglet de `parentId`. */
  add(options: { parentId?: string; afterId?: string } = {}) {
    const node = this.node({ title: this.freshTitle(), document: EMPTY_DOC });
    if (options.parentId) {
      const parent = this.find(options.parentId);
      if (!parent || parent.depth >= MAX_TAB_LEVEL - 1) return null;
      parent.node.children.push(node);
      parent.node.expanded = true;
    } else if (options.afterId) {
      const place = this.siblings(options.afterId);
      if (!place) return null;
      place.list.splice(place.index + 1, 0, node);
    } else {
      this.roots.push(node);
    }
    this.show(node);
    this.onChange();
    return node;
  }

  private freshTitle() {
    const titles = new Set(this.flat().map((e) => e.node.title));
    let n = this.count() + 1;
    while (titles.has(`Onglet ${n}`)) n++;
    return `Onglet ${n}`;
  }

  rename(id: string, title: string) {
    const found = this.find(id);
    const clean = title.trim();
    if (!found || !clean || clean === found.node.title) return;
    found.node.title = clean;
    this.onChange();
  }

  /** Supprime un onglet et ses sous-onglets (jamais le dernier). */
  remove(id: string) {
    const place = this.siblings(id);
    if (!place || this.roots.length === 1 && place.list === this.roots && this.roots[0].id === id) return false;
    const wasActive = this.find(this.activeId);
    const removed = place.list[place.index];
    const containsActive = !!wasActive && (removed.id === this.activeId || this.flatOf(removed).includes(this.activeId));
    place.list.splice(place.index, 1);
    if (containsActive) {
      // L'onglet qui prend sa place : le précédent, sinon le parent, sinon le premier.
      const next = place.list[place.index - 1] ?? place.list[place.index] ?? place.parent ?? this.roots[0];
      this.activeId = "";
      this.show(next);
    }
    this.onChange();
    return true;
  }

  private flatOf(node: TabNode): string[] {
    return node.children.flatMap((c) => [c.id, ...this.flatOf(c)]);
  }

  /** Monte (-1) ou descend (+1) un onglet parmi ses voisins. */
  move(id: string, delta: -1 | 1) {
    const place = this.siblings(id);
    if (!place) return;
    const target = place.index + delta;
    if (target < 0 || target >= place.list.length) return;
    const [node] = place.list.splice(place.index, 1);
    place.list.splice(target, 0, node);
    this.onChange();
  }

  /**
   * Peut-on poser l'onglet `id` avant, après ou dans `targetId` (glisser-
   * déposer) ? Pas dans lui-même ni ses sous-onglets, et pas au-delà de trois
   * niveaux.
   */
  canMoveTo(id: string, targetId: string, where: "before" | "after" | "inside") {
    const moving = this.find(id);
    const target = this.find(targetId);
    if (!moving || !target || id === targetId) return false;
    if (this.flatOf(moving.node).includes(targetId)) return false;
    const depth = where === "inside" ? target.depth + 1 : target.depth;
    return depth + this.height(moving.node) <= MAX_TAB_LEVEL - 1;
  }

  /** Déplace un onglet (avec ses sous-onglets) avant, après ou dans un autre. */
  moveTo(id: string, targetId: string, where: "before" | "after" | "inside") {
    if (!this.canMoveTo(id, targetId, where)) return false;
    const from = this.siblings(id)!;
    const [node] = from.list.splice(from.index, 1);
    if (where === "inside") {
      const target = this.find(targetId)!.node;
      target.children.push(node);
      target.expanded = true;
    } else {
      const to = this.siblings(targetId)!;
      to.list.splice(where === "before" ? to.index : to.index + 1, 0, node);
    }
    this.onChange();
    return true;
  }

  canIndent(id: string) {
    const place = this.siblings(id);
    const found = this.find(id);
    if (!place || !found || place.index === 0) return false;
    return found.depth + 1 + this.height(found.node) <= MAX_TAB_LEVEL - 1;
  }

  /** Hauteur du sous-arbre (0 sans sous-onglet). */
  private height(node: TabNode): number {
    return node.children.length ? 1 + Math.max(...node.children.map((c) => this.height(c))) : 0;
  }

  /** Devient un sous-onglet de l'onglet du dessus. */
  indent(id: string) {
    if (!this.canIndent(id)) return;
    const place = this.siblings(id)!;
    const [node] = place.list.splice(place.index, 1);
    const parent = place.list[place.index - 1];
    parent.children.push(node);
    parent.expanded = true;
    this.onChange();
  }

  /** Remonte d'un niveau (juste après son parent). */
  outdent(id: string) {
    const place = this.siblings(id);
    if (!place?.parent) return;
    const parentPlace = this.siblings(place.parent.id)!;
    const [node] = place.list.splice(place.index, 1);
    parentPlace.list.splice(parentPlace.index + 1, 0, node);
    this.onChange();
  }

  duplicate(id: string) {
    const place = this.siblings(id);
    if (!place) return;
    const copy = (n: TabNode): TabData => ({
      title: n.title,
      document: this.documentOf(n),
      children: n.children.map(copy),
    });
    const data = copy(place.list[place.index]);
    data.title = `Copie de ${data.title}`;
    const node = this.node(data);
    place.list.splice(place.index + 1, 0, node);
    this.show(node);
    this.onChange();
  }
}
