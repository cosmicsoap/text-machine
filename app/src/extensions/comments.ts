// Commentaires dans la marge, comme dans Google Docs : le texte commenté
// porte une marque `comment` qui contient toute la discussion (commentaire,
// réponses, résolu ou non). Un texte coupé en plusieurs morceaux (mise en
// forme, paragraphes) a la même discussion sur chaque morceau (même `id`).
//
// Garder la discussion dans le texte la fait suivre partout : onglets,
// annuler / rétablir, versions, export Word (de vrais commentaires Word).
// L'affichage dans la marge est dans comments.ts.

import { Extension, Mark } from "@tiptap/core";
import type { Mark as PMMark, Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { SKIP_META } from "./suggestions";

export interface CommentReply {
  author: string;
  date: string;
  text: string;
}

export interface CommentThread {
  id: string;
  author: string;
  date: string;
  text: string;
  replies: CommentReply[];
  resolved: boolean;
}

/** Une discussion et la plage du texte commenté (du début du premier morceau à la fin du dernier). */
export interface ThreadAt {
  thread: CommentThread;
  from: number;
  to: number;
}

export const newCommentId = () => `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const plain = (attrs: Record<string, unknown>): CommentThread => ({
  id: String(attrs.id ?? ""),
  author: String(attrs.author ?? ""),
  date: String(attrs.date ?? ""),
  text: String(attrs.text ?? ""),
  replies: Array.isArray(attrs.replies) ? (attrs.replies as CommentReply[]) : [],
  resolved: !!attrs.resolved,
});

/** Les discussions du document, dans l'ordre du texte. */
export function listThreads(doc: PMNode): ThreadAt[] {
  const byId = new Map<string, ThreadAt>();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type.name !== "comment" || !mark.attrs.id) continue;
      const found = byId.get(mark.attrs.id);
      const end = pos + node.nodeSize;
      if (found) found.to = Math.max(found.to, end);
      else byId.set(mark.attrs.id, { thread: plain(mark.attrs), from: pos, to: end });
    }
    return true;
  });
  return [...byId.values()].sort((a, b) => a.from - b.from);
}

/** La discussion sous le curseur (la plus courte s'il y en a plusieurs). */
export function threadAtCursor(state: EditorState): string | null {
  const { $from, empty, from, to } = state.selection;
  const marks = empty ? $from.marks() : rangeMarks(state.doc, from, to);
  let best: { id: string; size: number } | null = null;
  const threads = listThreads(state.doc);
  for (const mark of marks) {
    if (mark.type.name !== "comment" || mark.attrs.resolved) continue;
    const t = threads.find((x) => x.thread.id === mark.attrs.id);
    const size = t ? t.to - t.from : Infinity;
    if (!best || size < best.size) best = { id: mark.attrs.id, size };
  }
  return best?.id ?? null;
}

function rangeMarks(doc: PMNode, from: number, to: number): readonly PMMark[] {
  let marks: readonly PMMark[] = [];
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && marks.length === 0) marks = node.marks;
    return marks.length === 0;
  });
  return marks;
}

/** Remplace la discussion `id` partout où elle est (ou la retire si `next` est null). */
export function setThread(tr: Transaction, id: string, next: CommentThread | null): Transaction {
  const type = tr.doc.type.schema.marks.comment;
  const ranges: { from: number; to: number; mark: PMMark }[] = [];
  tr.doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type === type && m.attrs.id === id);
    if (mark) ranges.push({ from: pos, to: pos + node.nodeSize, mark });
    return true;
  });
  for (const r of ranges) {
    tr.removeMark(r.from, r.to, r.mark);
    if (next) tr.addMark(r.from, r.to, type.create(next));
  }
  // Les suggestions ne transforment pas un commentaire en modification.
  return tr.setMeta(SKIP_META, true);
}


interface CommentsState {
  /** Discussion mise en avant. */
  active: string | null;
  /** Texte d'un commentaire en cours d'écriture. */
  pending: { from: number; to: number } | null;
}

export const commentsKey = new PluginKey<CommentsState>("comments");

export const CommentMark = Mark.create({
  name: "comment",
  // Taper au bord du texte commenté n'agrandit pas le commentaire.
  inclusive: false,
  // Plusieurs commentaires peuvent se chevaucher.
  excludes: "",
  spanning: true,

  addAttributes() {
    // La discussion n'est pas écrite dans le HTML (seulement dans le document).
    const hidden = (fallback: unknown) => ({
      default: fallback,
      parseHTML: () => fallback,
      renderHTML: () => ({}),
    });
    return {
      id: {
        default: "",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-comment") ?? "",
        renderHTML: (attrs: Record<string, unknown>) => ({ "data-comment": attrs.id }),
      },
      author: hidden(""),
      date: hidden(""),
      text: hidden(""),
      replies: hidden([]),
      resolved: {
        default: false,
        parseHTML: () => false,
        renderHTML: (attrs: Record<string, unknown>) => (attrs.resolved ? { "data-resolved": "" } : {}),
      },
    };
  },

  // Copier-coller du texte ne copie pas les commentaires (comme Google Docs).
  parseHTML: () => [],

  renderHTML: ({ HTMLAttributes }) => ["span", { ...HTMLAttributes, class: "comment-mark" }, 0],
});

/** Surligne plus fort la discussion choisie, et le texte d'un commentaire en cours d'écriture. */
export const CommentFocus = Extension.create({
  name: "commentFocus",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: commentsKey,
        state: {
          init: (): CommentsState => ({ active: null, pending: null }),
          apply(tr, value): CommentsState {
            const meta = tr.getMeta(commentsKey) as Partial<CommentsState> | undefined;
            let next = meta ? { ...value, ...meta } : value;
            if (next.pending && tr.docChanged) {
              const from = tr.mapping.map(next.pending.from, 1);
              const to = tr.mapping.map(next.pending.to, -1);
              next = { ...next, pending: from < to ? { from, to } : null };
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            const { active, pending } = commentsKey.getState(state)!;
            const decos: Decoration[] = [];
            if (pending) decos.push(Decoration.inline(pending.from, pending.to, { class: "comment-pending" }));
            if (active) {
              for (const t of listThreads(state.doc)) {
                if (t.thread.id !== active) continue;
                state.doc.nodesBetween(t.from, t.to, (node, pos) => {
                  if (node.isText && node.marks.some((m) => m.type.name === "comment" && m.attrs.id === active)) {
                    decos.push(Decoration.inline(pos, pos + node.nodeSize, { class: "comment-active" }));
                  }
                  return true;
                });
              }
            }
            return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
