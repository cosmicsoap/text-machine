// En-têtes et pieds de page : le même texte en haut et en bas de chaque
// page, dans les marges (comme Google Docs). Il se modifie directement sur
// n'importe quelle page ; les autres suivent. Le numéro de page est sous le
// pied de page.

import type { PageSetup } from "./extensions/pagination";

type Part = "header" | "footer";

export class MarginsView {
  private layer: HTMLElement;
  private boxes: Record<Part, HTMLElement[]> = { header: [], footer: [] };

  constructor(
    paper: HTMLElement,
    private deps: {
      setup: () => PageSetup;
      isPageless: () => boolean;
      /** Le texte d'un en-tête ou d'un pied de page a été modifié. */
      onInput: (part: Part, text: string) => void;
      /** Échap : retour au texte. */
      onLeave: () => void;
    },
  ) {
    this.layer = document.createElement("div");
    this.layer.className = "margins-layer";
    paper.append(this.layer);
  }

  /** Dessine les en-têtes et pieds de page des `pages` pages. */
  render(pages: number) {
    const setup = this.deps.setup();
    this.boxes = { header: [], footer: [] };
    if (this.deps.isPageless()) {
      this.layer.replaceChildren();
      return;
    }
    const items: HTMLElement[] = [];
    for (let i = 0; i < pages; i++) {
      if (i === 0 && setup.differentFirstPage) continue;
      const top = `calc(${i} * (var(--page-h) + var(--page-gap)))`;
      const header = document.createElement("div");
      header.className = "page-header";
      header.style.top = top;
      header.append(this.editable("header", setup.header ?? "", "En-tête"));
      const footer = document.createElement("div");
      footer.className = "page-footer";
      footer.style.top = `calc(${top} + var(--page-h))`;
      footer.append(this.editable("footer", setup.footer ?? "", "Pied de page"));
      if (setup.pageNumbers) {
        const number = document.createElement("span");
        number.className = "page-number";
        number.textContent = String(i + 1);
        footer.append(number);
      }
      items.push(header, footer);
    }
    this.layer.replaceChildren(...items);
  }

  private editable(part: Part, text: string, placeholder: string) {
    const el = document.createElement("div");
    el.className = "hf-text";
    el.contentEditable = "plaintext-only";
    el.spellcheck = true;
    el.textContent = text;
    el.dataset.placeholder = placeholder;
    el.title = `${placeholder} : le même sur toutes les pages`;
    el.classList.toggle("empty", !text);
    el.addEventListener("input", () => {
      const value = el.innerText.replace(/\n+$/, "");
      el.classList.toggle("empty", !value);
      for (const other of this.boxes[part]) {
        if (other !== el) {
          other.textContent = value;
          other.classList.toggle("empty", !value);
        }
      }
      this.deps.onInput(part, value);
    });
    el.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.deps.onLeave();
      }
    });
    this.boxes[part].push(el);
    return el;
  }

  /** Met le curseur dans l'en-tête (ou le pied de page) de la page visible. */
  focus(part: Part, near: number) {
    const list = this.boxes[part];
    if (!list.length) return false;
    // La boîte la plus proche du milieu de l'écran.
    let best = list[0];
    let distance = Infinity;
    for (const el of list) {
      const d = Math.abs(el.getBoundingClientRect().top - near);
      if (d < distance) [best, distance] = [el, d];
    }
    best.focus();
    const range = document.createRange();
    range.selectNodeContents(best);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
    best.scrollIntoView({ block: "nearest" });
    return true;
  }
}
