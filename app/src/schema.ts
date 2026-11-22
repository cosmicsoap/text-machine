// Les extensions qui définissent ce qu'un document peut contenir et comment
// il s'affiche. Partagées par l'éditeur et par la vue de comparaison des
// versions (compare.ts), qui doit montrer les mêmes éléments.

import type { AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TextStyleKit } from "@tiptap/extension-text-style";
import TextAlign from "@tiptap/extension-text-align";
import Highlight from "@tiptap/extension-highlight";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import { TaskList, TaskItem } from "@tiptap/extension-list";
import { TableKit } from "@tiptap/extension-table";
import Image from "@tiptap/extension-image";
import { PageBreak } from "./extensions/pagination";
import { ParagraphFormat } from "./extensions/paragraph-format";
import { CharStyle, CustomParagraphStyle, FontWeight } from "./extensions/custom-styles";
import { Footnote } from "./extensions/footnote";
import { TableOfContents, type TocOptions } from "./extensions/toc";
import { Deletion, Insertion } from "./extensions/suggestions";
import { DiffHighlight } from "./extensions/diff-highlight";
import { CommentMark } from "./extensions/comments";

export function documentExtensions(options: { pageOf?: TocOptions["pageOf"] } = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4] },
      // Un clic sur un lien ne doit pas quitter l'éditeur.
      link: { openOnClick: false, autolink: true, defaultProtocol: "https" },
    }),
    // Police, taille, couleur du texte (lineHeight se règle par paragraphe).
    TextStyleKit.configure({ lineHeight: false }),
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ["heading", "paragraph"] }),
    Subscript,
    Superscript,
    TaskList,
    TaskItem.configure({ nested: true }),
    ParagraphFormat,
    CustomParagraphStyle,
    CharStyle,
    FontWeight,
    PageBreak,
    TableKit.configure({ table: { resizable: true } }),
    Image.configure({
      allowBase64: true,
      resize: { enabled: true, alwaysPreserveAspectRatio: true, minWidth: 40, minHeight: 40 },
    }),
    Footnote,
    TableOfContents.configure({ pageOf: options.pageOf ?? (() => null) }),
    Insertion,
    Deletion,
    DiffHighlight,
    CommentMark,
  ];
}
