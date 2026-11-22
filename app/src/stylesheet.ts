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
  /** Graisse de 100 à 900 ; absente : 400, ou 700 si `bold`. */
  fontWeight?: number | null;
  underline?: boolean;
  strike?: boolean;
  /** Couleur de surlignage `#rrggbb`. */
  highlight?: string | null;
  /** Espacement des lettres, en points. */
  letterSpacing?: number | null;
  smallCaps?: boolean;
  verticalAlign?: "super" | "sub" | null;
  textTransform?: "uppercase" | "lowercase" | "capitalize" | null;
  textAlign?: "left" | "center" | "right" | "justify" | null;
  /** Retraits en centimètres (première ligne négative : retrait suspendu). */
  indentLeft?: number | null;
  indentRight?: number | null;
  firstLineIndent?: number | null;
}

/** Graisse effective d'un style. */
export const weightOf = (s: ParagraphStyle) => s.fontWeight ?? (s.bold ? 700 : 400);

/** Noms des graisses, comme les fondeurs les écrivent. */
export const WEIGHT_NAMES: Record<number, string> = {
  100: "Thin",
  200: "ExtraLight",
  300: "Light",
  400: "Regular",
  500: "Medium",
  600: "SemiBold",
  700: "Bold",
  800: "ExtraBold",
  900: "Black",
};

/** « Light », « SemiBold Italique »… */
export function faceName(weight: number, italic: boolean) {
  const w = WEIGHT_NAMES[Math.round(weight / 100) * 100] ?? String(weight);
  if (!italic) return w;
  return w === "Regular" ? "Italique" : `${w} Italique`;
}

export type StyleKey = "normal" | "title" | "heading1" | "heading2" | "heading3";

/** Un style créé par l'utilisateur (même forme que `CustomStyle` en Rust). */
export interface CustomStyle {
  id: string;
  name: string;
  /** Un style de caractère n'utilise que la mise en forme des caractères. */
  kind: "paragraph" | "character";
  style: ParagraphStyle;
}

export type StyleSheet = Record<StyleKey, ParagraphStyle> & { custom: CustomStyle[] };

/** Un style désigné par son nom interne (« heading1 ») ou « custom:<id> ». */
export type StyleRef = StyleKey | `custom:${string}`;

export const customRef = (id: string): StyleRef => `custom:${id}`;
export const customId = (ref: StyleRef) => (ref.startsWith("custom:") ? ref.slice(7) : null);

export function findCustom(sheet: StyleSheet, ref: StyleRef) {
  const id = customId(ref);
  return id ? sheet.custom.find((c) => c.id === id) : undefined;
}

export function getStyle(sheet: StyleSheet, ref: StyleRef): ParagraphStyle {
  const id = customId(ref);
  if (!id) return sheet[ref as StyleKey];
  return sheet.custom.find((c) => c.id === id)?.style ?? sheet.normal;
}

export function styleName(sheet: StyleSheet, ref: StyleRef) {
  return customId(ref) ? (findCustom(sheet, ref)?.name ?? "Style supprimé") : STYLE_NAMES[ref as StyleKey];
}

export function newStyleId() {
  return Math.random().toString(36).slice(2, 10);
}

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
  custom: [],
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
  out.custom = (styles?.custom ?? []).map((c) => ({
    ...c,
    kind: c.kind === "character" ? "character" : "paragraph",
    style: { ...DEFAULT_STYLES.normal, fontFamily: null, ...c.style },
  }));
  return out;
}

export const fontOf = (sheet: StyleSheet, ref: StyleRef) =>
  getStyle(sheet, ref).fontFamily || sheet.normal.fontFamily || "Georgia";

export const cssFont = (font: string) => (/^[\w-]+$/.test(font) ? font : `"${font.replace(/"/g, "")}"`);

function declarations(sheet: StyleSheet, ref: StyleRef) {
  const s = getStyle(sheet, ref);
  const character = findCustom(sheet, ref)?.kind === "character";
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ");
  const size = s.verticalAlign ? s.fontSize * 0.65 : s.fontSize;
  return [
    // Un style de caractère sans police garde celle du paragraphe.
    character && !s.fontFamily ? "" : `font-family: ${cssFont(fontOf(sheet, ref))}, Georgia, serif`,
    `font-size: ${+size.toFixed(2)}pt`,
    `font-weight: ${weightOf(s)}`,
    `font-style: ${s.italic ? "italic" : "normal"}`,
    // Le texte normal hérite sa couleur (une citation reste grise).
    ref === "normal" || character ? (s.color ? `color: ${s.color}` : "") : `color: ${s.color || "#000000"}`,
    deco ? `text-decoration: ${deco}` : "",
    s.highlight ? `background-color: ${s.highlight}` : "",
    s.letterSpacing ? `letter-spacing: ${s.letterSpacing}pt` : "",
    s.smallCaps ? "font-variant-caps: small-caps" : "",
    s.verticalAlign ? `vertical-align: ${s.verticalAlign}` : "",
    s.textTransform ? `text-transform: ${s.textTransform}` : "",
    character ? "" : `line-height: ${s.lineHeight}`,
    character ? "" : `margin: ${s.spaceBefore}pt ${s.indentRight ?? 0}cm ${s.spaceAfter}pt ${s.indentLeft ?? 0}cm`,
    !character && s.textAlign ? `text-align: ${s.textAlign}` : "",
    !character && s.firstLineIndent ? `text-indent: ${s.firstLineIndent}cm` : "",
    // Retrait suspendu : la première ligne déborde à gauche.
    !character && (s.firstLineIndent ?? 0) < 0 && !s.indentLeft ? `padding-left: ${-s.firstLineIndent!}cm` : "",
  ]
    .filter(Boolean)
    .join("; ");
}

const attrValue = (id: string) => id.replace(/["\\]/g, "");

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
    ...sheet.custom.map((c) =>
      c.kind === "paragraph"
        ? `${scope} p[data-custom-style="${attrValue(c.id)}"] { ${declarations(sheet, customRef(c.id))} }`
        : `${scope} span[data-char-style="${attrValue(c.id)}"] { ${declarations(sheet, customRef(c.id))} }`,
    ),
    // Le premier bloc de la page ne commence pas par un espace.
    `${scope} > :first-child { margin-top: 0; }`,
  ].join("\n");
}

/** Aperçu d'un style dans les listes de styles. */
export function previewCss(sheet: StyleSheet, ref: StyleRef) {
  const s = getStyle(sheet, ref);
  const deco = [s.underline && "underline", s.strike && "line-through"].filter(Boolean).join(" ") || "none";
  return `font-family: ${cssFont(fontOf(sheet, ref))}, Georgia, serif; font-size: ${Math.min(s.fontSize, 20)}pt; font-weight: ${weightOf(s)}; font-style: ${s.italic ? "italic" : "normal"}; color: ${s.color || "#000000"}; text-decoration: ${deco}; ${s.highlight ? `background-color: ${s.highlight};` : ""} ${s.smallCaps ? "font-variant-caps: small-caps;" : ""} ${s.textTransform ? `text-transform: ${s.textTransform};` : ""} ${s.letterSpacing ? `letter-spacing: ${s.letterSpacing}pt;` : ""}`;
}
