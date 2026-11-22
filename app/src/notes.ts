// Affichage et saisie des notes de bas de page (voir extensions/footnote.ts).
//
// - En mode page : chaque note est en bas de la page où elle est appelée
//   (la pagination lui réserve la place), sous un petit trait.
// - Sans pagination : toutes les notes à la fin du document.
//
// Le texte d'une note se modifie directement à sa place ; il est rangé dans
// l'attribut `content` de son numéro.

import type { Editor } from "@tiptap/core";
import { collectNotes } from "./extensions/footnote";

export class NotesView {
  private layer: HTMLElement;
  private end: HTMLElement;
  private measure: HTMLElement;
  private cache = new Map<string, number>();
  private notePages: number[] = [];
  private rows: HTMLElement[] = [];
  private structure = "";

  constructor(
    private editor: Editor,
    private paper: HTMLElement,
    private isPageless: () => boolean,
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "notes-layer";
    this.end = document.createElement("div");
    this.end.className = "notes-end";
    this.measure = document.createElement("div");
    this.measure.className = "notes-measure page-notes";
    this.measure.setAttribute("aria-hidden", "true");
    paper.append(this.layer, this.end, this.measure);
  }

  /** Hauteur d'une note telle qu'elle sera affichée (pour la pagination). */
  height(content: string, index: number): number {
    const width = this.paper.style.getPropertyValue("--page-w");
    const key = `${width}|${index + 1}|${content}`;
    const known = this.cache.get(key);
    if (known !== undefined) return known;
    this.measure.replaceChildren(this.noteElement(index, content, false));
    const h = this.measure.getBoundingClientRect().height / this.scale();
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, h);
    return h;
  }

  /** Après un changement de styles ou de format : on remesure. */
  invalidate() {
    this.cache.clear();
  }

  /** Rapport entre la taille à l'écran et la taille de la page (zoom). */
  private scale() {
    const page = parseFloat(this.paper.style.getPropertyValue("--page-w"));
    const shown = this.paper.getBoundingClientRect().width;
    return page > 0 && shown > 0 ? shown / page : 1;
  }

  private noteElement(index: number, content: string, editable: boolean) {
    const row = document.createElement("div");
    row.className = "note";
    const num = document.createElement("span");
    num.className = "note-num";
    num.textContent = String(index + 1);
    const text = document.createElement("span");
    text.className = "note-text";
    text.textContent = content;
    if (editable) {
      text.contentEditable = "plaintext-only";
      text.spellcheck = true;
      text.dataset.placeholder = "Texte de la note";
      text.addEventListener("input", () => this.write(index, text.innerText.replace(/\n$/, "")));
      text.addEventListener("keydown", (e) => {
        // Échap ou ↩ en fin de note : retour au texte, juste après le numéro.
        if (e.key === "Escape") {
          e.preventDefault();
          this.backToText(index);
        }
      });
      num.title = "Aller à l'appel de note";
      num.addEventListener("mousedown", (e) => {
        e.preventDefault();
        this.backToText(index);
      });
    }
    row.append(num, text);
    return row;
  }

  private write(index: number, content: string) {
    const note = collectNotes(this.editor.state.doc)[index];
    if (!note) return;
    this.editor.view.dispatch(this.editor.state.tr.setNodeAttribute(note.pos, "content", content));
  }

  private backToText(index: number) {
    const note = collectNotes(this.editor.state.doc)[index];
    if (!note) return;
    this.editor.chain().focus().setTextSelection(note.pos + 1).scrollIntoView().run();
  }

  /** Met le curseur dans le texte de la note `index` (après l'avoir créée). */
  focus(index: number, now = false) {
    const wait = (run: () => void) =>
      now ? run() : requestAnimationFrame(() => requestAnimationFrame(run));
    wait(() => {
      {
        const text = this.paper.querySelector<HTMLElement>(`.note-text[data-index="${index}"]`);
        if (!text) return;
        text.focus();
        const range = document.createRange();
        range.selectNodeContents(text);
        range.collapse(false);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        text.scrollIntoView({ block: "nearest" });
      }
    });
  }

  /** Appelé après chaque calcul des pages. */
  setPages(notePages: number[]) {
    this.notePages = notePages;
    this.render();
  }

  render() {
    const notes = collectNotes(this.editor.state.doc);
    const pageless = this.isPageless();
    const structure = JSON.stringify([pageless, notes.length, pageless ? [] : this.notePages.slice(0, notes.length)]);
    const active = document.activeElement as HTMLElement | null;
    const editing = active?.classList.contains("note-text") ? Number(active.dataset.index) : -1;

    if (structure === this.structure) {
      // Même place pour chaque note : on ne change que les textes (sans
      // toucher à la note en cours de saisie, le curseur sauterait).
      this.rows.forEach((row, i) => {
        const text = row.lastElementChild as HTMLElement;
        if (i !== editing && text.textContent !== notes[i].content) text.textContent = notes[i].content;
      });
      return;
    }
    this.structure = structure;

    this.rows = notes.map((note, i) => {
      const row = this.noteElement(i, note.content, true);
      (row.lastElementChild as HTMLElement).dataset.index = String(i);
      return row;
    });
    if (pageless) {
      this.layer.replaceChildren();
      this.end.hidden = !this.rows.length;
      this.end.replaceChildren(...this.rows);
    } else {
      const byPage = new Map<number, HTMLElement>();
      this.rows.forEach((row, i) => {
        const page = this.notePages[i] ?? 0;
        let box = byPage.get(page);
        if (!box) {
          box = document.createElement("div");
          box.className = "page-notes";
          box.style.top = `calc(${page} * (var(--page-h) + var(--page-gap)) + var(--page-h) - var(--m-bottom))`;
          byPage.set(page, box);
        }
        box.append(row);
      });
      this.end.hidden = true;
      this.end.replaceChildren();
      this.layer.replaceChildren(...byPage.values());
    }
    // La note en cours de saisie a changé de page : on y remet le curseur.
    if (editing >= 0 && this.rows[editing]) this.focus(editing, true);
  }
}
