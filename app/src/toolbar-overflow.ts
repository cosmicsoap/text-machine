// Barre d'outils sur une seule ligne, comme dans Google Docs : quand la
// fenêtre est trop étroite, les derniers boutons passent dans un panneau
// ouvert par « ⋮ ». Le panneau reste dans #toolbar, si bien que les clics
// et l'état des boutons (gras actif, etc.) fonctionnent sans changement.

import { ICONS } from "./icons";

export function setupToolbarOverflow(toolbar: HTMLElement) {
  const spacer = toolbar.querySelector<HTMLElement>(":scope > .spacer");
  // Les éléments qui peuvent passer dans le panneau, dans l'ordre d'origine.
  const items = [...toolbar.children].filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement && el !== spacer && !el.matches("select.edit-mode, input[type=file]"),
  );

  const more = document.createElement("button");
  more.type = "button";
  more.className = "toolbar-more";
  more.title = "Plus d'options";
  more.innerHTML = ICONS.more;
  more.hidden = true;

  const panel = document.createElement("div");
  panel.className = "toolbar-more-panel";
  panel.hidden = true;

  toolbar.insertBefore(more, spacer);
  toolbar.append(panel);

  const place = () => {
    const r = more.getBoundingClientRect();
    panel.style.top = `${r.bottom + 6}px`;
    const width = panel.offsetWidth;
    panel.style.left = `${Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8))}px`;
  };

  const close = () => {
    panel.hidden = true;
    more.classList.remove("active");
  };

  more.addEventListener("click", () => {
    if (!panel.hidden) return close();
    panel.hidden = false;
    more.classList.add("active");
    place();
  });

  // Clic ailleurs (sauf dans un menu ouvert depuis le panneau) : on ferme.
  document.addEventListener("mousedown", (event) => {
    const target = event.target as HTMLElement;
    if (panel.hidden || panel.contains(target) || more.contains(target)) return;
    if (target.closest(".popup, .font-picker, dialog")) return;
    close();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) close();
  });

  const visible = (el: HTMLElement) => !el.hidden && el.offsetWidth > 0;
  const fits = () => toolbar.scrollWidth <= toolbar.clientWidth + 1;

  function layout() {
    const wasOpen = !panel.hidden;
    panel.hidden = true;
    // Tout remettre dans la barre, puis sortir les derniers éléments un à un.
    for (const el of items) toolbar.insertBefore(el, more);
    more.hidden = true;
    if (!fits()) {
      more.hidden = false;
      const inBar = [...items];
      while (inBar.length > 1 && !fits()) panel.prepend(inBar.pop()!);
      // Pas de séparateur en bout de barre.
      while (inBar.length && (inBar[inBar.length - 1].classList.contains("sep") || !visible(inBar[inBar.length - 1]))) {
        panel.prepend(inBar.pop()!);
      }
    }
    if (more.hidden) close();
    else if (wasOpen) {
      panel.hidden = false;
      place();
    }
  }

  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(layout);
  };
  new ResizeObserver(schedule).observe(toolbar);
  // Les outils de tableau apparaissent ou disparaissent avec le curseur.
  const observer = new MutationObserver(schedule);
  for (const el of items) observer.observe(el, { attributes: true, attributeFilter: ["hidden"] });
  // Les polices chargées changent la largeur des textes.
  void document.fonts?.ready.then(schedule);
  layout();
  return { layout: schedule, close };
}
