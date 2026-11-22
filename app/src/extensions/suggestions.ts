// Mode suggestion, comme dans Google Docs : quand il est actif, rien n'est
// vraiment effacé ni écrit directement. Le texte tapé est marqué « ajouté »
// (vert, souligné) et le texte effacé reste visible, barré en rouge. Chaque
// suggestion s'accepte ou se refuse (bulle près du texte, ou Outils).
//
// Fonctionnement : après chaque modification, un plugin regarde ce qui a été
// remplacé. Le texte retiré est remis à sa place avec la marque « deletion »,
// le texte ajouté reçoit la marque « insertion ». Effacer son propre ajout
// l'efface pour de bon.
//
// Limite : seules les modifications du texte sont suivies (pas la mise en
// forme, ni les paragraphes coupés ou fusionnés).

import { Extension, Mark, mergeAttributes } from "@tiptap/core";
import type { Mark as PMMark, MarkType, Node as PMNode, Slice } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { ReplaceStep } from "@tiptap/pm/transform";
import { isHistoryTransaction } from "@tiptap/pm/history";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    suggestions: {
      acceptChange: (from: number, to: number) => ReturnType;
      rejectChange: (from: number, to: number) => ReturnType;
      acceptAllChanges: (level?: number) => ReturnType;
      rejectAllChanges: (level?: number) => ReturnType;
    };
  }
}

const changeAttributes = () => ({
  author: {
    default: "",
    parseHTML: (el: HTMLElement) => el.getAttribute("data-author") ?? "",
    renderHTML: (attrs: Record<string, string>) => ({ "data-author": attrs.author }),
  },
  date: {
    default: "",
    parseHTML: (el: HTMLElement) => el.getAttribute("data-date") ?? "",
    renderHTML: (attrs: Record<string, string>) => ({ "data-date": attrs.date }),
  },
  // Niveau de révision (1 à 5, comme Scrivener) : une couleur par niveau.
  level: {
    default: null,
    parseHTML: (el: HTMLElement) => Number(el.getAttribute("data-level")) || null,
    renderHTML: (attrs: Record<string, unknown>) => (attrs.level ? { "data-level": String(attrs.level) } : {}),
  },
});

export const Insertion = Mark.create({
  name: "insertion",
  inclusive: false,
  excludes: "deletion",
  addAttributes: changeAttributes,
  parseHTML: () => [{ tag: "ins" }],
  renderHTML: ({ HTMLAttributes }) => ["ins", mergeAttributes(HTMLAttributes, { class: "suggest-ins" }), 0],
});

export const Deletion = Mark.create({
  name: "deletion",
  inclusive: false,
  excludes: "insertion",
  addAttributes: changeAttributes,
  parseHTML: () => [{ tag: "del" }],
  renderHTML: ({ HTMLAttributes }) => ["del", mergeAttributes(HTMLAttributes, { class: "suggest-del" }), 0],
});

/** Une suggestion : un morceau de texte ajouté ou retiré. */
export interface Change {
  kind: "insertion" | "deletion";
  from: number;
  to: number;
  author: string;
  date: string;
  level: number;
}

const changeMark = (marks: readonly PMMark[]) =>
  marks.find((m) => m.type.name === "insertion" || m.type.name === "deletion");

/** Toutes les suggestions du document (morceaux voisins du même auteur réunis). */
export function listChanges(doc: PMNode): Change[] {
  const out: Change[] = [];
  doc.descendants((node, pos) => {
    if (!node.isInline) return true;
    const mark = changeMark(node.marks);
    if (!mark) return false;
    const last = out[out.length - 1];
    const kind = mark.type.name as Change["kind"];
    const level = Number(mark.attrs.level) || 1;
    if (last && last.to === pos && last.kind === kind && last.author === mark.attrs.author && last.level === level) {
      last.to = pos + node.nodeSize;
    } else {
      out.push({ kind, from: pos, to: pos + node.nodeSize, author: mark.attrs.author, date: mark.attrs.date, level });
    }
    return false;
  });
  return out;
}

/** La suggestion sous le curseur (ou juste avant lui). */
export function changeAt(state: EditorState): Change | null {
  const { from, to } = state.selection;
  return (
    listChanges(state.doc).find((c) => (from >= c.from && from <= c.to) || (to >= c.from && to <= c.to) || (from <= c.from && to >= c.to)) ??
    null
  );
}

/** Ne pas suivre cette transaction (accepter / refuser, chargement…). */
export const SKIP_META = "suggestions-skip";

export interface SuggestionOptions {
  isOn: () => boolean;
  author: () => string;
  /** Niveau de révision des nouvelles suggestions (1 à 5). */
  level: () => number;
}

const key = new PluginKey("suggestions");

function hasContent(slice: Slice) {
  let found = false;
  slice.content.descendants((node) => {
    if (found) return false;
    if (node.isText || (node.isInline && node.isAtom) || (node.isBlock && node.isAtom)) found = true;
    return !found;
  });
  return found;
}

/** Applique `accept` / `reject` aux marques d'une plage. */
function resolve(tr: Transaction, from: number, to: number, accept: boolean) {
  const { insertion, deletion } = tr.doc.type.schema.marks;
  const remove: [number, number][] = [];
  const unmark: [number, number, MarkType][] = [];
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isInline) return true;
    const start = Math.max(pos, from);
    const end = Math.min(pos + node.nodeSize, to);
    for (const m of node.marks) {
      if (m.type === insertion) (accept ? unmark.push([start, end, insertion]) : remove.push([start, end]));
      if (m.type === deletion) (accept ? remove.push([start, end]) : unmark.push([start, end, deletion]));
    }
    return false;
  });
  for (const [a, b, type] of unmark) tr.removeMark(a, b, type);
  for (const [a, b] of remove.sort((x, y) => y[0] - x[0])) tr.delete(a, b);
  return tr.setMeta(SKIP_META, true);
}

/** Toutes les suggestions, ou seulement celles d'un niveau de révision. */
function resolveLevel(tr: Transaction, accept: boolean, level?: number) {
  if (!level) return resolve(tr, 0, tr.doc.content.size, accept);
  // De la fin vers le début : les positions restent justes.
  for (const c of listChanges(tr.doc).filter((c) => c.level === level).reverse()) resolve(tr, c.from, c.to, accept);
  return tr;
}

export const Suggestions = Extension.create<SuggestionOptions>({
  name: "suggestions",

  addOptions() {
    return { isOn: () => false, author: () => "", level: () => 1 };
  },

  addCommands() {
    return {
      acceptChange:
        (from, to) =>
        ({ tr, dispatch }) => {
          if (dispatch) resolve(tr, from, to, true);
          return true;
        },
      rejectChange:
        (from, to) =>
        ({ tr, dispatch }) => {
          if (dispatch) resolve(tr, from, to, false);
          return true;
        },
      acceptAllChanges:
        (level) =>
        ({ tr, dispatch }) => {
          if (dispatch) resolveLevel(tr, true, level);
          return true;
        },
      rejectAllChanges:
        (level) =>
        ({ tr, dispatch }) => {
          if (dispatch) resolveLevel(tr, false, level);
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    const options = this.options;
    return [
      new Plugin({
        key,
        appendTransaction(trs, oldState, newState) {
          if (!options.isOn()) return null;
          const { insertion, deletion } = newState.schema.marks;
          if (!insertion || !deletion) return null;
          const level = options.level();
          const attrs = {
            author: options.author(),
            date: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
            level: level > 1 ? level : null,
          };

          const inserted: [number, number][] = [];
          const deleted: { pos: number; slice: Slice; cursor: "start" | "end" | "keep" }[] = [];
          trs.forEach((tr, t) => {
            if (!tr.docChanged || tr.getMeta(SKIP_META) || isHistoryTransaction(tr) || tr.getMeta(key)) return;
            const before = t === 0 ? oldState : null;
            tr.steps.forEach((step, i) => {
              if (!(step instanceof ReplaceStep)) return;
              const { from, to, slice } = step as unknown as { from: number; to: number; slice: Slice };
              // Positions dans le document final.
              const rest = tr.mapping.slice(i + 1);
              const later = trs.slice(t + 1);
              const toEnd = (pos: number, assoc: number) =>
                later.reduce((p, l) => l.mapping.map(p, assoc), rest.map(pos, assoc));
              if (slice.size > 0) inserted.push([toEnd(from, 1), toEnd(from + slice.size, -1)]);
              if (to > from) {
                const removed = tr.docs[i].slice(from, to);
                if (!hasContent(removed)) return;
                // Curseur : avant le texte barré (retour arrière, sélection
                // effacée), après lui (touche Suppr), ou après le texte tapé.
                const sel = before?.selection;
                const cursor =
                  slice.size > 0 ? "keep" : sel && sel.empty && sel.from === from ? "end" : "start";
                deleted.push({ pos: toEnd(from, -1), slice: removed, cursor });
              }
            });
          });
          if (!inserted.length && !deleted.length) return null;

          const tr = newState.tr.setMeta(key, true);
          for (const [a, b] of inserted) {
            if (b <= a) continue;
            tr.removeMark(a, b, deletion);
            tr.addMark(a, b, insertion.create(attrs));
          }
          let cursor: number | null = null;
          for (const d of deleted.sort((x, y) => y.pos - x.pos)) {
            const pos = tr.mapping.map(d.pos, -1);
            const size = tr.doc.content.size;
            tr.replace(pos, pos, d.slice);
            const end = pos + (tr.doc.content.size - size);
            // Ce qui était un ajout (pas encore accepté) est vraiment effacé.
            const drop: [number, number][] = [];
            const mark: [number, number][] = [];
            tr.doc.nodesBetween(pos, end, (node, p) => {
              if (!node.isInline) return true;
              const range: [number, number] = [Math.max(p, pos), Math.min(p + node.nodeSize, end)];
              if (insertion.isInSet(node.marks)) drop.push(range);
              else if (!deletion.isInSet(node.marks)) mark.push(range);
              return false;
            });
            for (const [a, b] of mark) tr.addMark(a, b, deletion.create(attrs));
            let kept = end;
            for (const [a, b] of drop.sort((x, y) => y[0] - x[0])) {
              tr.delete(a, b);
              kept -= b - a;
            }
            if (d.cursor === "start") cursor = pos;
            else if (d.cursor === "end") cursor = kept;
          }
          if (cursor !== null && newState.selection.empty) {
            tr.setSelection(TextSelection.create(tr.doc, Math.min(cursor, tr.doc.content.size)));
          }
          return tr.steps.length ? tr : null;
        },
      }),
    ];
  },
});
