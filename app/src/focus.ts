// Plein écran, et mode sans distraction (comme le mode composition de
// Scrivener ou iA Writer) : plus de menus, de barre d'outils ni de
// panneaux, le texte seul au centre, en plein écran. Une petite barre
// apparaît quand la souris s'approche du haut de l'écran : paragraphe en
// cours mis en valeur, défilement « machine à écrire », fond, sortie.

import { getCurrentWindow } from "@tauri-apps/api/window";
import { shortcutLabel } from "./platform";

const inTauri = () => "__TAURI_INTERNALS__" in window;

const pref = {
  get(key: string, fallback: string) {
    try {
      return localStorage.getItem(`tm.focus.${key}`) ?? fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(`tm.focus.${key}`, value);
    } catch {
      /* pas grave */
    }
  },
};

// --- Plein écran -------------------------------------------------------------------

export async function isFullscreen(): Promise<boolean> {
  if (inTauri()) {
    try {
      return await getCurrentWindow().isFullscreen();
    } catch {
      return false;
    }
  }
  return !!document.fullscreenElement;
}

export async function setFullscreen(on: boolean) {
  if (inTauri()) {
    await getCurrentWindow().setFullscreen(on).catch(() => {});
  } else if (on && !document.fullscreenElement) {
    await document.documentElement.requestFullscreen?.().catch(() => {});
  } else if (!on && document.fullscreenElement) {
    await document.exitFullscreen().catch(() => {});
  }
  document.body.classList.toggle("fullscreen", await isFullscreen());
}

export async function toggleFullscreen() {
  await setFullscreen(!(await isFullscreen()));
}

// --- Sans distraction ----------------------------------------------------------------

export type FocusTheme = "light" | "sepia" | "dark";
const THEMES: [FocusTheme, string][] = [
  ["light", "Clair"],
  ["sepia", "Sépia"],
  ["dark", "Sombre"],
];

interface FocusOptions {
  /** La mise en page doit changer (sans pagination pendant le mode). */
  onChange: (on: boolean) => void;
  /** Le paragraphe en cours a changé d'apparence : redessiner. */
  redraw: () => void;
  /** Nombre de mots affiché dans la barre. */
  words: () => string;
  /** Position du curseur à l'écran (pour le défilement machine à écrire). */
  caretTop: () => number | null;
  scroller: HTMLElement;
}

export class FocusMode {
  on = false;
  paragraph = pref.get("paragraph", "0") === "1";
  typewriter = pref.get("typewriter", "0") === "1";
  theme = (pref.get("theme", "light") as FocusTheme) || "light";
  private wasFullscreen = false;
  private bar: HTMLElement;
  private hideTimer: number | undefined;

  constructor(private options: FocusOptions) {
    this.bar = this.renderBar();
    document.body.append(this.bar);
    document.addEventListener("mousemove", (e) => {
      if (!this.on) return;
      if (e.clientY < 56 || this.bar.contains(e.target as Node)) this.showBar();
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (!this.on) return;
        if (e.key === "Escape" && !document.querySelector("dialog[open], .popup")) {
          e.preventDefault();
          void this.toggle(false);
        } else if (!e.metaKey && !e.ctrlKey) {
          this.hideBar();
        }
      },
      true,
    );
  }

  async toggle(on = !this.on) {
    if (on === this.on) return;
    this.on = on;
    document.body.classList.toggle("focus-mode", on);
    this.applyClasses();
    if (on) {
      this.wasFullscreen = await isFullscreen();
      if (!this.wasFullscreen) await setFullscreen(true);
      this.showBar();
      window.setTimeout(() => this.hideBar(), 2500);
    } else {
      this.bar.classList.remove("shown");
      if (!this.wasFullscreen) await setFullscreen(false);
    }
    this.options.onChange(on);
    this.options.redraw();
  }

  /** Après chaque frappe ou déplacement du curseur. */
  update() {
    if (!this.on) return;
    this.bar.querySelector(".focus-words")!.textContent = this.options.words();
    if (this.typewriter) {
      const caret = this.options.caretTop();
      if (caret === null) return;
      const box = this.options.scroller.getBoundingClientRect();
      const target = box.top + box.height * 0.45;
      if (Math.abs(caret - target) > 4) this.options.scroller.scrollBy({ top: caret - target, behavior: "smooth" });
    }
  }

  private applyClasses() {
    const b = document.body.classList;
    b.toggle("focus-paragraph", this.on && this.paragraph);
    b.toggle("typewriter", this.on && this.typewriter);
    for (const [t] of THEMES) b.toggle(`focus-${t}`, this.on && this.theme === t);
    this.bar.querySelector<HTMLInputElement>('[name="paragraph"]')!.checked = this.paragraph;
    this.bar.querySelector<HTMLInputElement>('[name="typewriter"]')!.checked = this.typewriter;
    this.bar.querySelector<HTMLSelectElement>('[name="theme"]')!.value = this.theme;
  }

  setParagraph(on: boolean) {
    this.paragraph = on;
    pref.set("paragraph", on ? "1" : "0");
    this.applyClasses();
    this.options.redraw();
  }

  setTypewriter(on: boolean) {
    this.typewriter = on;
    pref.set("typewriter", on ? "1" : "0");
    this.applyClasses();
    this.update();
  }

  setTheme(theme: FocusTheme) {
    this.theme = theme;
    pref.set("theme", theme);
    this.applyClasses();
  }

  private showBar() {
    this.bar.classList.add("shown");
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (!this.bar.matches(":hover") && !this.bar.contains(document.activeElement)) this.hideBar();
    }, 2500);
  }

  private hideBar() {
    this.bar.classList.remove("shown");
  }

  private renderBar() {
    const bar = document.createElement("div");
    bar.className = "focus-bar";
    bar.innerHTML = `
      <label class="inline" title="Les autres paragraphes s'estompent"><input type="checkbox" name="paragraph" /> Paragraphe en cours</label>
      <label class="inline" title="La ligne en cours reste au milieu de l'écran"><input type="checkbox" name="typewriter" /> Machine à écrire</label>
      <label class="inline">Fond <select name="theme">${THEMES.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>
      <span class="focus-words"></span>
      <span class="spacer"></span>
      <button type="button" class="focus-exit" title="Quitter le mode sans distraction (Échap)">Quitter <kbd>Échap</kbd></button>`;
    bar.querySelector<HTMLInputElement>('[name="paragraph"]')!.addEventListener("change", (e) =>
      this.setParagraph((e.target as HTMLInputElement).checked),
    );
    bar.querySelector<HTMLInputElement>('[name="typewriter"]')!.addEventListener("change", (e) =>
      this.setTypewriter((e.target as HTMLInputElement).checked),
    );
    bar.querySelector<HTMLSelectElement>('[name="theme"]')!.addEventListener("change", (e) =>
      this.setTheme((e.target as HTMLSelectElement).value as FocusTheme),
    );
    bar.querySelector(".focus-exit")!.addEventListener("click", () => void this.toggle(false));
    bar.querySelector<HTMLElement>(".focus-exit")!.title = `Quitter le mode sans distraction (Échap ou ${shortcutLabel("⇧⌘D")})`;
    return bar;
  }
}
