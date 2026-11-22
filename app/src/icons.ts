// Icônes de la barre d'outils, dessinées pour Text Machine (24 × 24, en
// traits arrondis de la couleur du texte).

const svg = (body: string) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const lines = (rows: [number, number][]) =>
  rows.map(([x1, x2], i) => `<path d="M${x1} ${5 + i * 4.6}H${x2}"/>`).join("");

export const ICONS: Record<string, string> = {
  undo: svg('<path d="M9 7 4.5 11.5 9 16"/><path d="M5 11.5h9.5a4.5 4.5 0 0 1 0 9H12"/>'),
  redo: svg('<path d="m15 7 4.5 4.5L15 16"/><path d="M19 11.5H9.5a4.5 4.5 0 0 0 0 9H12"/>'),
  print: svg('<path d="M7 9V4h10v5"/><rect x="3.5" y="9" width="17" height="8" rx="2"/><path d="M7 14h10v6H7z"/>'),
  spellcheck: svg('<path d="m4 15 3.5-10L11 15"/><path d="M5.2 11.6h4.6"/><path d="m12 15 3 3.5 6-8"/>'),
  paintFormat: svg('<rect x="4" y="3.5" width="13" height="5" rx="1.2"/><path d="M17 6h2.5v5H11v3"/><path d="M11 14v6.5"/>'),
  bold: svg('<path d="M7 4.5h6a3.75 3.75 0 0 1 0 7.5H7z"/><path d="M7 12h7a4 4 0 0 1 0 8H7z"/>'),
  italic: svg('<path d="M10 4.5h8M6 19.5h8M14.5 4.5l-5 15"/>'),
  underline: svg('<path d="M7 4v7a5 5 0 0 0 10 0V4"/><path d="M5 20.5h14"/>'),
  strike: svg('<path d="M4 12h16"/><path d="M16.5 7.5C15.8 5.4 14 4.5 12 4.5c-2.6 0-4.5 1.4-4.5 3.4 0 1.4.8 2.4 2.5 3.1"/><path d="M8 16.5c.7 2.1 2.4 3 4.4 3 2.6 0 4.6-1.4 4.6-3.6 0-.8-.3-1.5-.8-2"/>'),
  textColor: svg('<path d="m6.5 16 5.5-12 5.5 12"/><path d="M8.3 12h7.4"/>'),
  highlight: svg('<path d="m14 4.5 5.5 5.5-7.5 7.5H6.5V12z"/><path d="m9.5 9 5.5 5.5"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m4 18 5-5 3.5 3.5L15 14l5 5"/>'),
  table: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><path d="M3.5 9.5h17M3.5 14.5h17M9.5 4.5v15M15 4.5v15"/>'),
  alignLeft: svg(lines([[4, 20], [4, 14], [4, 20], [4, 14]])),
  alignCenter: svg(lines([[4, 20], [7, 17], [4, 20], [7, 17]])),
  alignRight: svg(lines([[4, 20], [10, 20], [4, 20], [10, 20]])),
  alignJustify: svg(lines([[4, 20], [4, 20], [4, 20], [4, 20]])),
  lineHeight: svg('<path d="M11 6h9M11 12h9M11 18h9"/><path d="m4 7.5 2.5-3 2.5 3M4 16.5l2.5 3 2.5-3M6.5 4.5v15"/>'),
  checklist: svg('<path d="m3.5 6.5 1.8 1.8L8.5 5M3.5 15.5l1.8 1.8L8.5 14"/><path d="M12 7h8.5M12 16h8.5"/>'),
  bulletList: svg('<circle cx="5" cy="6.5" r="1" fill="currentColor"/><circle cx="5" cy="12" r="1" fill="currentColor"/><circle cx="5" cy="17.5" r="1" fill="currentColor"/><path d="M9.5 6.5h11M9.5 12h11M9.5 17.5h11"/>'),
  orderedList: svg('<path d="M4 5h1.5v4M4 9h3"/><path d="M4 14.5c0-.9.7-1.5 1.5-1.5s1.5.6 1.5 1.4c0 1.3-3 2.1-3 3.6h3"/><path d="M10.5 7h10M10.5 16.5h10"/>'),
  outdent: svg('<path d="M11 6.5h9.5M11 12h9.5M11 17.5h9.5M4 5h4"/><path d="m7 9.5-3 2.5 3 2.5"/>'),
  indent: svg('<path d="M11 6.5h9.5M11 12h9.5M11 17.5h9.5M4 5h4"/><path d="m4 9.5 3 2.5-3 2.5"/>'),
  clearFormat: svg('<path d="M7 5h11M12.5 5 9 19"/><path d="m14.5 14 5 5M19.5 14l-5 5"/>'),
  quote: svg('<path d="M5 17c0-4 1-7 4.5-9M5 17h3.5v-4H5M13 17c0-4 1-7 4.5-9M13 17h3.5v-4H13"/>'),
  pageBreak: svg('<path d="M6 3.5v5h12v-5M6 20.5v-5h12v5"/><path d="M3.5 12h2M8.5 12h2M13.5 12h2M18.5 12h2"/>'),
  search: svg('<circle cx="10.5" cy="10.5" r="6"/><path d="m15 15 5 5"/>'),
  minus: svg('<path d="M6 12h12"/>'),
  plus: svg('<path d="M12 6v12M6 12h12"/>'),
  more: svg('<circle cx="12" cy="5.5" r="1.1" fill="currentColor"/><circle cx="12" cy="12" r="1.1" fill="currentColor"/><circle cx="12" cy="18.5" r="1.1" fill="currentColor"/>'),
  tab: svg('<path d="M6.5 3.5h7l4 4v13h-11z"/><path d="M13.5 3.5v4h4"/><path d="M9 12h6M9 15.5h6"/>'),
  caret: svg('<path d="m9 6 6 6-6 6"/>'),
  panel: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2"/><path d="M9.5 4.5v15"/>'),
  back: svg('<path d="M19 12H5M11 6l-6 6 6 6"/>'),
  close: svg('<path d="m6 6 12 12M18 6 6 18"/>'),
  comment: svg('<path d="M4.5 5.5h15v10.5H10l-4 3.5v-3.5H4.5z"/>'),
  commentAdd: svg('<path d="M4.5 5.5h15v10.5H10l-4 3.5v-3.5H4.5z"/><path d="M12 8.2v5.1M9.45 10.75h5.1"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  fullscreen: svg('<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>'),
  focus: svg('<rect x="4" y="4" width="16" height="16" rx="2.5"/><path d="M8.5 9h7M8.5 12h7M8.5 15h4.5"/>'),
  // Logo de Text Machine (volontairement différent de celui de Google Docs).
  doc: '<svg class="doc-icon" viewBox="0 0 32 40" aria-hidden="true"><rect x="1" y="1" width="30" height="38" rx="5" fill="#1d6b63"/><path d="M8 11h16M16 11v18" stroke="#fff" stroke-width="3.4" stroke-linecap="round"/><path d="M11 33h10" stroke="#8fd5c8" stroke-width="2.4" stroke-linecap="round"/></svg>',
  cloud: svg('<path d="M7.5 18.5a4.5 4.5 0 0 1-.6-9 6 6 0 0 1 11.4 1.6 3.8 3.8 0 0 1-.8 7.4z"/><path d="m9.5 13.5 2 2 3.5-3.5"/>'),
};
