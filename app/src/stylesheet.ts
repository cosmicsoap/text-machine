// Feuille de styles du document : « Texte normal », « Titre », « Titre 1 »…
// Chaque style se modifie (police, taille, gras, couleur, espacements) et
// tous les paragraphes de ce style changent d'un coup, comme dans Google
// Docs. Le même modèle existe côté Rust (`StyleSheet` dans tm-model) : il
// est enregistré dans le document et exporté dans les styles Word.

export interface ParagraphStyle {
  /** Police ; absente : celle du texte normal. */
  fontFamily?: string | null;
  /** En points. */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** `#rrggbb` ; absente : noir. */
  color?: string | null;
  /** Interligne, en multiple de la taille du texte. */
  lineHeight: number;
  /** Espace avant et après le paragraphe, en points. */
  spaceBefore: number;
  spaceAfter: number;
}

export type StyleKey = "normal" | "title" | "heading1" | "heading2" | "heading3";
export type StyleSheet = Record<StyleKey, ParagraphStyle>;

export const STYLE_KEYS: StyleKey[] = ["normal", "title", "heading1", "heading2", "heading3"];

export const STYLE_NAMES: Record<StyleKey, string> = {
  normal: "Texte normal",
  title: "Titre",
  heading1: "Titre 1",
  heading2: "Titre 2",
  heading3: "Titre 3",
};

/** Niveau de titre de l'éditeur (1 à 4) de chaque style ; 0 = paragraphe. */
export const STYLE_LEVEL: Record<StyleKey, number> = {
  normal: 0,
  title: 1,
  heading1: 2,
  heading2: 3,
  heading3: 4,
};

export const styleOfLevel = (level: number): StyleKey =>
  STYLE_KEYS.find((k) => STYLE_LEVEL[k] === level) ?? "normal";

const heading = (fontSize: number, spaceBefore: number, spaceAfter: number): ParagraphStyle => ({
  fontSize,
  bold: false,
  italic: false,
  lineHeight: 1.25,
  spaceBefore,
  spaceAfter,
});

/** Les mêmes valeurs que `StyleSheet::default()` en Rust. */
export const DEFAULT_STYLES: StyleSheet = {
  normal: {
    fontFamily: "Georgia",
    fontSize: 12,
    bold: false,
    italic: false,
    lineHeight: 1.5,
    spaceBefore: 0,
    spaceAfter: 6,
  },
  title: heading(26, 0, 6),
  heading1: heading(20, 20, 6),
  heading2: heading(16, 18, 4),
  heading3: { ...heading(14, 14, 4), color: "#434343" },
};

/** Complète une feuille de styles incomplète (anciens fichiers). */
export function normalizeStyles(styles?: Partial<StyleSheet> | null): StyleSheet {
  const out = structuredClone(DEFAULT_STYLES);
  for (const key of STYLE_KEYS) {
    if (styles?.[key]) out[key] = { ...out[key], ...styles[key] };
  }
  return out;
}

export const fontOf = (sheet: StyleSheet, key: StyleKey) =>
  sheet[key].fontFamily || sheet.normal.fontFamily || "Georgia";

const cssFont = (font: string) => (/^[\w-]+$/.test(font) ? font : `"${font.replace(/"/g, "")}"`);

function declarations(sheet: StyleSheet, key: StyleKey) {
  const s = sheet[key];
  return [
    `font-family: ${cssFont(fontOf(sheet, key))}, Georgia, serif`,
    `font-size: ${s.fontSize}pt`,
    `font-weight: ${s.bold ? "bold" : "normal"}`,
    `font-style: ${s.italic ? "italic" : "normal"}`,
    // Le texte normal hérite sa couleur (une citation reste grise).
    key === "normal" ? (s.color ? `color: ${s.color}` : "") : `color: ${s.color || "#000000"}`,
    `line-height: ${s.lineHeight}`,
    `margin: ${s.spaceBefore}pt 0 ${s.spaceAfter}pt`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** Règles CSS qui appliquent la feuille de styles à l'éditeur. */
export function stylesToCss(sheet: StyleSheet, scope = "#editor .tiptap") {
  const n = sheet.normal;
  return [
    `${scope} { font-family: ${cssFont(fontOf(sheet, "normal"))}, Georgia, serif; font-size: ${n.fontSize}pt; line-height: ${n.lineHeight}; color: ${n.color || "#000000"}; }`,
    `${scope} p { ${declarations(sheet, "normal")} }`,
    `${scope} h1 { ${declarations(sheet, "title")} }`,
    `${scope} h2 { ${declarations(sheet, "heading1")} }`,
    `${scope} h3 { ${declarations(sheet, "heading2")} }`,
    `${scope} h4 { ${declarations(sheet, "heading3")} }`,
    // Le premier bloc de la page ne commence pas par un espace.
    `${scope} > :first-child { margin-top: 0; }`,
  ].join("\n");
}

/** Aperçu d'un style dans la liste de la fenêtre « Styles ». */
export function previewCss(sheet: StyleSheet, key: StyleKey) {
  const s = sheet[key];
  return `font-family: ${cssFont(fontOf(sheet, key))}, Georgia, serif; font-size: ${Math.min(s.fontSize, 20)}pt; font-weight: ${s.bold ? "bold" : "normal"}; font-style: ${s.italic ? "italic" : "normal"}; color: ${s.color || "#000000"};`;
}
