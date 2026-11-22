// Barre de menus (Fichier, Édition, Affichage…) et menus déroulants, à la
// façon de Google Docs. Les menus sont recréés à chaque ouverture : les
// coches et les listes (fichiers récents…) sont toujours à jour.

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => unknown;
  /** Coche devant le libellé. */
  checked?: boolean;
  disabled?: boolean;
  submenu?: MenuItem[];
  separator?: true;
}

export const SEP: MenuItem = { separator: true };

let openMenu: { el: HTMLElement; root?: HTMLElement; onClose?: () => void } | null = null;

export function closeMenus() {
  if (!openMenu) return;
  openMenu.el.remove();
  openMenu.root?.classList.remove("open");
  const done = openMenu.onClose;
  openMenu = null;
  done?.();
}

function render(items: MenuItem[]): HTMLElement {
  const menu = document.createElement("div");
  menu.className = "menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    if (item.separator) {
      menu.append(document.createElement("hr"));
      continue;
    }
    const row = document.createElement("button");
    row.type = "button";
    row.className = "menu-item";
    row.setAttribute("role", "menuitem");
    row.disabled = !!item.disabled;
    const check = document.createElement("span");
    check.className = "check";
    check.textContent = item.checked ? "✓" : "";
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = item.label ?? "";
    const right = document.createElement("span");
    right.className = "shortcut";
    right.textContent = item.submenu ? "›" : (item.shortcut ?? "");
    row.append(check, label, right);
    if (item.submenu) {
      const wrap = document.createElement("div");
      wrap.className = "has-sub";
      const sub = render(item.submenu);
      sub.classList.add("submenu");
      wrap.append(row, sub);
      // La sous-liste s'ouvre vers la gauche si elle sortirait de la fenêtre.
      wrap.addEventListener("mouseenter", () => {
        sub.classList.remove("left");
        const r = sub.getBoundingClientRect();
        if (r.right > window.innerWidth - 4) sub.classList.add("left");
      });
      menu.append(wrap);
    } else {
      row.addEventListener("click", () => {
        closeMenus();
        item.action?.();
      });
      menu.append(row);
    }
  }
  // Les clics dans un menu ne retirent pas le curseur du texte.
  menu.addEventListener("mousedown", (e) => e.preventDefault());
  return menu;
}

/** Ouvre un menu sous (ou à côté de) un élément. */
export function popup(
  anchor: HTMLElement,
  items: MenuItem[],
  options: { root?: HTMLElement; align?: "left" | "right"; onClose?: () => void } = {},
) {
  closeMenus();
  const el = render(items);
  el.classList.add("popup");
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  let left = options.align === "right" ? r.right - width : r.left;
  left = Math.max(4, Math.min(left, window.innerWidth - width - 4));
  el.style.left = `${left}px`;
  el.style.top = `${r.bottom + 2}px`;
  // Trop bas pour tenir sous l'élément : le menu remonte.
  const overflow = r.bottom + 2 + el.offsetHeight - (window.innerHeight - 4);
  if (overflow > 0) el.style.top = `${Math.max(4, r.bottom + 2 - overflow)}px`;
  openMenu = { el, root: options.root, onClose: options.onClose };
  options.root?.classList.add("open");
}

export function isMenuOpen() {
  return !!openMenu;
}

/** Barre de menus : un clic ouvre, le survol passe d'un menu à l'autre. */
export function setupMenubar(bar: HTMLElement, menus: { label: string; items: () => MenuItem[] }[]) {
  for (const menu of menus) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "menubar-item";
    button.textContent = menu.label;
    const open = () => popup(button, menu.items(), { root: button });
    button.addEventListener("mousedown", (e) => {
      e.preventDefault();
      if (openMenu?.root === button) closeMenus();
      else open();
    });
    button.addEventListener("mouseenter", () => {
      if (openMenu?.root && openMenu.root !== button && bar.contains(openMenu.root)) open();
    });
    bar.append(button);
  }
}

document.addEventListener("mousedown", (event) => {
  if (!openMenu) return;
  const target = event.target as HTMLElement;
  if (openMenu.el.contains(target) || openMenu.root?.contains(target)) return;
  closeMenus();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openMenu) {
    event.stopPropagation();
    closeMenus();
  }
});

window.addEventListener("blur", closeMenus);
window.addEventListener("resize", closeMenus);
