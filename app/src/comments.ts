// Commentaires dans la marge, à la façon de Google Docs : une carte par
// discussion, à droite de la page, à la hauteur du texte commenté. On y
// répond, on modifie, on supprime, on résout (✓). Les discussions résolues
// sont cachées (Affichage > Commentaires résolus pour les revoir).
//
// Les discussions elles-mêmes sont dans le texte (extensions/comments.ts).

import type { Editor } from "@tiptap/core";
import {
  commentsKey,
  listThreads,
  newCommentId,
  setThread,
  threadAtCursor,
  type CommentThread,
  type ThreadAt,
} from "./extensions/comments";
import { ICONS } from "./icons";
import { popup, type MenuItem } from "./menus";
import { shortcutLabel } from "./platform";

const GAP = 10;
const DATE_FORMAT = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const COLORS = ["#1d6b63", "#0b57d0", "#8e44ad", "#c0392b", "#d35400", "#2e7d32", "#ad1457", "#5d4037"];

function avatar(name: string): HTMLElement {
  const el = document.createElement("span");
  el.className = "comment-avatar";
  const letter = name.trim().charAt(0).toUpperCase() || "?";
  el.textContent = letter;
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  el.style.background = COLORS[h % COLORS.length];
  return el;
}

const formatDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : DATE_FORMAT.format(d);
};

function button(className: string, title: string, icon?: string, text?: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = className;
  b.title = title;
  if (icon) b.innerHTML = ICONS[icon] ?? "";
  if (text) b.append(text);
  return b;
}

/** Une zone de saisie avec « Annuler » et un bouton principal ; ⌘↩ valide, Échap annule. */
function inputBox(placeholder: string, okLabel: string, value: string, onOk: (text: string) => void, onCancel: () => void, alwaysButtons = true) {
  const box = document.createElement("div");
  box.className = "comment-input";
  const area = document.createElement("textarea");
  area.rows = 1;
  area.placeholder = placeholder;
  area.value = value;
  const buttons = document.createElement("div");
  buttons.className = "comment-buttons";
  const cancel = button("comment-cancel", "Annuler (Échap)", undefined, "Annuler");
  const ok = button("comment-ok", `${okLabel} (${shortcutLabel("⌘↩")})`, undefined, okLabel);
  buttons.append(cancel, ok);
  const sync = () => {
    ok.disabled = area.value.trim() === "";
    area.style.height = "auto";
    area.style.height = `${area.scrollHeight}px`;
    buttons.hidden = !alwaysButtons && area.value === "" && document.activeElement !== area;
  };
  area.addEventListener("input", sync);
  area.addEventListener("focus", sync);
  area.addEventListener("blur", () => setTimeout(sync, 100));
  // La carte est redessinée après validation : la zone ne doit plus avoir le focus.
  const submit = () => {
    const text = area.value.trim();
    if (!text) return;
    area.blur();
    onOk(text);
  };
  area.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  });
  ok.addEventListener("click", submit);
  cancel.addEventListener("click", onCancel);
  box.append(area, buttons);
  requestAnimationFrame(sync);
  return { box, area };
}

interface Options {
  author: () => string;
  /** Appelé quand le nombre de discussions affichées change (place à droite de la page). */
  onLayoutChange?: () => void;
}

export class CommentsView {
  readonly rail: HTMLElement;
  private addButton: HTMLButtonElement;
  private cards = new Map<string, { el: HTMLElement; key: string }>();
  private composer: HTMLElement | null = null;
  /** Discussion ou réponse en cours de modification (« id » ou « id:n »). */
  private editing: string | null = null;
  private replying = new Map<string, string>();
  private frame = 0;
  showResolved = false;

  constructor(
    private editor: Editor,
    private paper: HTMLElement,
    private desk: HTMLElement,
    private options: Options,
  ) {
    this.rail = document.createElement("div");
    this.rail.className = "comment-rail";
    this.rail.setAttribute("aria-label", "Commentaires");
    this.addButton = button("comment-add", `Ajouter un commentaire (${shortcutLabel("⌥⌘M")})`, "commentAdd");
    this.addButton.hidden = true;
    this.addButton.addEventListener("mousedown", (e) => e.preventDefault());
    this.addButton.addEventListener("click", () => this.start());
    this.rail.append(this.addButton);
    paper.append(this.rail);

    editor.on("transaction", ({ transaction }) => {
      if ((transaction.selectionSet || transaction.docChanged) && editor.isFocused) {
        const id = threadAtCursor(editor.state);
        if (id !== this.active) queueMicrotask(() => this.setActive(id));
      }
      this.schedule();
    });
    editor.on("focus", () => {
      const id = threadAtCursor(editor.state);
      if (id !== this.active) queueMicrotask(() => this.setActive(id));
      this.schedule();
    });
    editor.on("blur", () => setTimeout(() => this.schedule(), 0));
    new ResizeObserver(() => this.schedule()).observe(paper);
    // Panneau de gauche ouvert ou fermé, fenêtre redimensionnée : la page
    // et les commentaires doivent encore tenir.
    let deskWidth = 0;
    new ResizeObserver(() => {
      if (desk.clientWidth === deskWidth) return;
      deskWidth = desk.clientWidth;
      if (desk.classList.contains("with-comments")) this.options.onLayoutChange?.();
    }).observe(desk);
    window.addEventListener("resize", () => this.schedule());
  }

  private get state() {
    return commentsKey.getState(this.editor.state) ?? { active: null, pending: null };
  }

  get active() {
    return this.state.active;
  }

  private setMeta(meta: { active?: string | null; pending?: { from: number; to: number } | null }) {
    const tr = this.editor.state.tr.setMeta(commentsKey, meta).setMeta("addToHistory", false);
    this.editor.view.dispatch(tr);
  }

  setActive(id: string | null) {
    if (id === this.active) return;
    this.setMeta({ active: id });
  }

  /** Nombre de discussions ouvertes dans l'onglet. */
  get openCount() {
    return listThreads(this.editor.state.doc).filter((t) => !t.thread.resolved).length;
  }

  get resolvedCount() {
    return listThreads(this.editor.state.doc).filter((t) => t.thread.resolved).length;
  }

  setShowResolved(on: boolean) {
    this.showResolved = on;
    this.schedule();
  }

  /** Nouveau commentaire sur le texte sélectionné (ou le mot sous le curseur). */
  start() {
    const { state } = this.editor;
    let { from, to } = state.selection;
    if (from === to) {
      // Pas de sélection : le mot sous le curseur, comme Google Docs.
      const $pos = state.selection.$from;
      const text = $pos.parent.textContent;
      const offset = $pos.parentOffset;
      let a = offset;
      let b = offset;
      while (a > 0 && /[\p{L}\p{N}'’-]/u.test(text[a - 1])) a--;
      while (b < text.length && /[\p{L}\p{N}'’-]/u.test(text[b])) b++;
      if (a === b) return;
      from = $pos.start() + a;
      to = $pos.start() + b;
    }
    this.setMeta({ pending: { from, to }, active: null });
    cancelAnimationFrame(this.frame);
    this.layout(true);
  }

  private cancelComposer() {
    this.setMeta({ pending: null });
    this.editor.commands.focus();
  }

  private submitComposer(text: string) {
    const pending = this.state.pending;
    if (!pending) return;
    const id = newCommentId();
    const thread: CommentThread = {
      id,
      author: this.options.author(),
      date: new Date().toISOString(),
      text,
      replies: [],
      resolved: false,
    };
    const type = this.editor.schema.marks.comment;
    const tr = this.editor.state.tr
      .addMark(pending.from, pending.to, type.create(thread))
      .setMeta(commentsKey, { pending: null, active: id })
      .setMeta("suggestions-skip", true);
    this.editor.view.dispatch(tr);
  }

  private update(id: string, change: (t: CommentThread) => CommentThread | null) {
    const t = listThreads(this.editor.state.doc).find((x) => x.thread.id === id);
    if (!t) return;
    const next = change(structuredClone(t.thread));
    const tr = setThread(this.editor.state.tr, id, next);
    if (!next || next.resolved) tr.setMeta(commentsKey, { active: null });
    this.editor.view.dispatch(tr);
  }

  resolve(id: string, resolved = true) {
    this.update(id, (t) => ({ ...t, resolved }));
  }

  /** Recalcule la marge au prochain affichage. */
  schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.layout(false));
  }

  private threadsShown(): ThreadAt[] {
    return listThreads(this.editor.state.doc).filter((t) => this.showResolved || !t.thread.resolved);
  }

  private layout(focusComposer: boolean) {
    const threads = this.threadsShown();
    const { pending, active } = this.state;
    // La zone de saisie d'un nouveau commentaire : tout de suite, pour que
    // la frappe y arrive.
    if (pending && !this.composer) {
      this.composer = this.renderComposer();
      this.rail.append(this.composer);
      focusComposer = true;
    } else if (!pending && this.composer) {
      this.composer.remove();
      this.composer = null;
    }
    if (focusComposer) this.composer?.querySelector("textarea")?.focus();

    const had = this.desk.classList.contains("with-comments");
    const has = threads.length > 0 || !!pending;
    this.desk.classList.toggle("with-comments", has);
    if (had !== has) {
      this.options.onLayoutChange?.();
      // La page s'est déplacée : on attend sa nouvelle place.
      this.schedule();
      return;
    }

    // Cartes : créées ou mises à jour, retirées si la discussion n'existe plus.
    const seen = new Set<string>();
    for (const t of threads) {
      seen.add(t.thread.id);
      const isActive = t.thread.id === active;
      const key = JSON.stringify(t.thread) + isActive + this.editing;
      const card = this.cards.get(t.thread.id);
      const typing = card?.el.contains(document.activeElement) && this.editing === null;
      if (card && (card.key === key || typing)) {
        card.el.classList.toggle("active", isActive);
        continue;
      }
      const el = this.renderCard(t.thread, isActive);
      if (card) card.el.replaceWith(el);
      else this.rail.append(el);
      this.cards.set(t.thread.id, { el, key });
    }
    for (const [id, card] of this.cards) {
      if (!seen.has(id)) {
        card.el.remove();
        this.cards.delete(id);
        this.replying.delete(id);
      }
    }

    // Positions : chaque carte à la hauteur de son texte, sans se chevaucher ;
    // la carte choisie est exactement en face de son texte.
    const paperRect = this.paper.getBoundingClientRect();
    const scale = this.paper.offsetWidth ? paperRect.width / this.paper.offsetWidth : 1;
    this.fit(scale);
    const top = (pos: number) => {
      try {
        return (this.editor.view.coordsAtPos(Math.min(pos, this.editor.state.doc.content.size)).top - paperRect.top) / scale;
      } catch {
        return 0;
      }
    };
    const items: { el: HTMLElement; anchor: number; focus: boolean }[] = threads.map((t) => ({
      el: this.cards.get(t.thread.id)!.el,
      anchor: top(t.from),
      focus: t.thread.id === active,
    }));
    if (pending && this.composer) items.push({ el: this.composer, anchor: top(pending.from), focus: true });
    items.sort((a, b) => a.anchor - b.anchor);
    const heights = items.map((i) => i.el.offsetHeight);
    const tops = items.map((i) => i.anchor);
    const f = items.findIndex((i) => i.focus);
    const start = f >= 0 ? f : 0;
    for (let i = start + 1; i < items.length; i++) tops[i] = Math.max(tops[i], tops[i - 1] + heights[i - 1] + GAP);
    for (let i = start - 1; i >= 0; i--) tops[i] = Math.min(tops[i], tops[i + 1] - heights[i] - GAP);
    // Pas au-dessus de la page.
    const shift = tops.length ? Math.max(0, -tops[0]) : 0;
    items.forEach((item, i) => (item.el.style.top = `${tops[i] + shift}px`));

    // Bouton « + commentaire » en face d'une sélection.
    const sel = this.editor.state.selection;
    const showAdd = this.editor.isFocused && !sel.empty && !pending && !document.body.classList.contains("focus-mode");
    this.addButton.hidden = !showAdd;
    if (showAdd) this.addButton.style.top = `${top(sel.from)}px`;
  }

  /**
   * Marge des commentaires : toujours 280 px à 20 px de la page, comme dans
   * Google Docs. Si la fenêtre est trop étroite, le bureau défile de côté
   * plutôt que de rapetisser la page ou les commentaires.
   */
  private fit(scale: number) {
    const width = 280;
    const gap = 20;
    this.rail.style.width = `${width}px`;
    this.rail.style.left = `calc(100% + ${gap}px)`;
    // Le bouton « + » reste dans la marge droite de la page.
    this.addButton.style.left = `${-gap - 46}px`;
    const space = `${Math.max(0, Math.floor((width + gap) * scale) - 1)}px`;
    if (this.desk.style.getPropertyValue("--rail-space") !== space) this.desk.style.setProperty("--rail-space", space);
  }

  private header(name: string, date: string, extra: HTMLElement[]) {
    const head = document.createElement("div");
    head.className = "comment-head";
    const who = document.createElement("div");
    who.className = "comment-who";
    const n = document.createElement("span");
    n.className = "comment-author";
    n.textContent = name || "Anonyme";
    const d = document.createElement("span");
    d.className = "comment-date";
    d.textContent = formatDate(date);
    who.append(n, d);
    head.append(avatar(name), who, ...extra);
    return head;
  }

  private body(text: string) {
    const el = document.createElement("div");
    el.className = "comment-text";
    el.textContent = text;
    return el;
  }

  private renderComposer() {
    const card = document.createElement("div");
    card.className = "comment-card active composer";
    const { box } = inputBox(
      "Commentaire",
      "Commenter",
      "",
      (text) => this.submitComposer(text),
      () => this.cancelComposer(),
    );
    card.append(this.header(this.options.author(), "", []), box);
    card.addEventListener("mousedown", (e) => e.stopPropagation());
    return card;
  }

  private renderCard(t: CommentThread, active: boolean) {
    const card = document.createElement("div");
    card.className = "comment-card";
    card.classList.toggle("active", active);
    card.classList.toggle("resolved", t.resolved);
    card.dataset.id = t.id;

    const resolve = t.resolved
      ? button("comment-icon reopen", "Rouvrir la discussion", undefined, "Rouvrir")
      : button("comment-icon", "Marquer comme résolu et masquer", "check");
    resolve.addEventListener("click", (e) => {
      e.stopPropagation();
      this.resolve(t.id, !t.resolved);
    });
    const more = button("comment-icon", "Plus d'options", "more");
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      popup(more, this.menu(t.id, null), { align: "right" });
    });
    card.append(this.header(t.author, t.date, [resolve, more]));

    if (this.editing === t.id) card.append(this.editBox(t.id, null, t.text));
    else card.append(this.body(t.text));

    t.replies.forEach((r, i) => {
      const reply = document.createElement("div");
      reply.className = "comment-reply";
      const rmore = button("comment-icon", "Plus d'options", "more");
      rmore.addEventListener("click", (e) => {
        e.stopPropagation();
        popup(rmore, this.menu(t.id, i), { align: "right" });
      });
      reply.append(this.header(r.author, r.date, [rmore]));
      if (this.editing === `${t.id}:${i}`) reply.append(this.editBox(t.id, i, r.text));
      else reply.append(this.body(r.text));
      card.append(reply);
    });

    if (!t.resolved && this.editing === null) {
      const { box, area } = inputBox(
        "Répondre",
        "Répondre",
        this.replying.get(t.id) ?? "",
        (text) => {
          this.replying.delete(t.id);
          this.update(t.id, (x) => ({
            ...x,
            replies: [...x.replies, { author: this.options.author(), date: new Date().toISOString(), text }],
          }));
        },
        () => {
          this.replying.delete(t.id);
          area.value = "";
          area.blur();
          this.setActive(null);
        },
        false,
      );
      area.addEventListener("input", () => this.replying.set(t.id, area.value));
      box.classList.add("reply-box");
      card.append(box);
    }

    // Un clic sur la carte la met en avant (et son texte dans la page).
    card.addEventListener("mousedown", (e) => {
      e.stopPropagation();
      if (this.active !== t.id) this.setActive(t.id);
    });
    return card;
  }

  private editBox(id: string, reply: number | null, value: string) {
    const { box } = inputBox(
      "Commentaire",
      "Enregistrer",
      value,
      (text) => {
        this.editing = null;
        this.update(id, (t) => {
          if (reply === null) t.text = text;
          else t.replies[reply].text = text;
          return t;
        });
      },
      () => {
        this.editing = null;
        this.schedule();
      },
    );
    requestAnimationFrame(() => box.querySelector("textarea")?.focus());
    return box;
  }

  private menu(id: string, reply: number | null): MenuItem[] {
    return [
      {
        label: "Modifier",
        action: () => {
          this.editing = reply === null ? id : `${id}:${reply}`;
          this.setActive(id);
          this.schedule();
        },
      },
      {
        label: reply === null ? "Supprimer la discussion" : "Supprimer la réponse",
        action: () =>
          this.update(id, (t) => {
            if (reply === null) return null;
            t.replies.splice(reply, 1);
            return t;
          }),
      },
    ];
  }
}
