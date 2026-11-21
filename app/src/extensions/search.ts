// Rechercher / remplacer : surligne toutes les occurrences, permet d'aller
// de l'une à l'autre et de les remplacer.

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";

export interface Match {
  from: number;
  to: number;
}

interface SearchState {
  query: string;
  caseSensitive: boolean;
  matches: Match[];
  current: number;
  decorations: DecorationSet;
}

export const searchKey = new PluginKey<SearchState>("search");

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    search: {
      setSearch: (query: string, caseSensitive?: boolean) => ReturnType;
      nextMatch: () => ReturnType;
      previousMatch: () => ReturnType;
      replaceCurrent: (replacement: string) => ReturnType;
      replaceAll: (replacement: string) => ReturnType;
    };
  }
}

/** Toutes les occurrences, sans traverser les limites de paragraphe. */
function findMatches(doc: PMNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];
  const needle = caseSensitive ? query : query.toLocaleLowerCase("fr");
  const matches: Match[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    // Texte du bloc, avec pour chaque caractère sa position dans le document.
    let text = "";
    const positions: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < child.text!.length; i++) positions.push(pos + 1 + offset + i);
        text += child.text;
      } else {
        positions.push(pos + 1 + offset);
        text += "￼";
      }
    });
    const haystack = caseSensitive ? text : text.toLocaleLowerCase("fr");
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      matches.push({ from: positions[index], to: positions[index + needle.length - 1] + 1 });
      index = haystack.indexOf(needle, index + needle.length);
    }
    return false;
  });
  return matches;
}

function build(doc: PMNode, query: string, caseSensitive: boolean, current: number): SearchState {
  const matches = findMatches(doc, query, caseSensitive);
  const index = matches.length ? Math.min(Math.max(current, 0), matches.length - 1) : -1;
  const decorations = DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, { class: i === index ? "search-match current" : "search-match" }),
    ),
  );
  return { query, caseSensitive, matches, current: index, decorations };
}

export function getSearchState(state: EditorState) {
  return searchKey.getState(state)!;
}

export const Search = Extension.create({
  name: "search",

  addCommands() {
    const go =
      (delta: number) =>
      () =>
      ({ state, tr, dispatch, view }: any) => {
        const s = getSearchState(state);
        if (!s.matches.length) return false;
        const current = (s.current + delta + s.matches.length) % s.matches.length;
        const m = s.matches[current];
        if (dispatch) {
          tr.setMeta(searchKey, { current });
          tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
          dispatch(tr);
          requestAnimationFrame(() => view.dom.querySelector(".search-match.current")?.scrollIntoView({ block: "center" }));
        }
        return true;
      };

    return {
      setSearch:
        (query, caseSensitive = false) =>
        ({ tr, dispatch }) => {
          if (dispatch) dispatch(tr.setMeta(searchKey, { query, caseSensitive, current: 0 }));
          return true;
        },
      nextMatch: go(1),
      previousMatch: go(-1),
      replaceCurrent:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = getSearchState(state);
          const m = s.matches[s.current];
          if (!m) return false;
          if (dispatch) {
            if (replacement) tr.insertText(replacement, m.from, m.to);
            else tr.delete(m.from, m.to);
            tr.setMeta(searchKey, { current: s.current });
            dispatch(tr);
          }
          return true;
        },
      replaceAll:
        (replacement) =>
        ({ state, tr, dispatch }) => {
          const s = getSearchState(state);
          if (!s.matches.length) return false;
          if (dispatch) {
            // De la fin vers le début, pour ne pas décaler les positions.
            for (const m of [...s.matches].reverse()) {
              if (replacement) tr.insertText(replacement, m.from, m.to);
              else tr.delete(m.from, m.to);
            }
            dispatch(tr);
          }
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin<SearchState>({
        key: searchKey,
        state: {
          init: (_config, state) => build(state.doc, "", false, 0),
          apply(tr, value) {
            const meta = tr.getMeta(searchKey);
            if (!meta && !tr.docChanged) return value;
            const next = { ...value, ...meta };
            return build(tr.doc, next.query, next.caseSensitive, next.current);
          },
        },
        props: {
          decorations: (state) => getSearchState(state).decorations,
        },
      }),
    ];
  },
});
