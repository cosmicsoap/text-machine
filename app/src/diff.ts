// Différences entre deux documents, mot à mot (algorithme de Myers).
// Sert à la comparaison côte à côte d'une version et du texte en cours.

import type { Node as PMNode } from "@tiptap/pm/model";
import type { DiffRange } from "./extensions/diff-highlight";

interface Token extends DiffRange {
  text: string;
}

const WORD = /\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}]/gu;

/** Les mots, espaces et signes du document, avec leur position. */
export function tokenize(doc: PMNode): Token[] {
  const out: Token[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) {
      // Une position par caractère, et une pour chaque élément en ligne.
      let text = "";
      node.forEach((child) => {
        if (child.isText) text += child.text;
        else if (child.type.name === "hardBreak") text += " ";
        else text += child.type.name === "footnote" ? `￼` : "�";
      });
      for (const m of text.matchAll(WORD)) {
        const start = pos + 1 + m.index!;
        out.push({ text: m[0], from: start, to: start + m[0].length });
      }
      // Fin de paragraphe : sépare les mots de deux paragraphes.
      out.push({ text: `¶${node.type.name}`, from: pos + node.nodeSize - 1, to: pos + node.nodeSize - 1 });
      return false;
    }
    if (node.isAtom && node.isBlock) {
      const src = String(node.attrs.src ?? "");
      out.push({
        text: `■${node.type.name}:${src.length}:${src.slice(-48)}`,
        from: pos,
        to: pos + node.nodeSize,
        block: true,
      });
      return false;
    }
    return true;
  });
  return out;
}

/**
 * Ce qui a été retiré de `a` et ajouté dans `b` (indices des jetons).
 * Au-delà de `maxEdits` différences, le milieu est marqué en entier.
 */
function diffIndices(a: string[], b: string[], maxEdits = 1500) {
  const removed: number[] = [];
  const added: number[] = [];
  /** Pour chaque différence : l'indice du jeton de `b` où elle se trouve. */
  const anchors: number[] = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  const markAll = () => {
    for (let i = start; i < endA; i++) removed.push(i);
    for (let j = start; j < endB; j++) added.push(j);
    anchors.push(start);
    return { removed, added, anchors };
  };
  if (n === 0 || m === 0) return markAll();

  // Myers : V[k] = x le plus loin sur la diagonale k ; on garde chaque V.
  const max = Math.min(n + m, maxEdits);
  const offset = max + 1;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 3);
  let found = -1;
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[start + x] === b[start + y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return markAll();
  trace.push(v.slice());

  // Remonte le chemin.
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]) ? k + 1 : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
    }
    if (x === prevX) added.push(start + prevY);
    else removed.push(start + prevX);
    anchors.push(start + prevY);
    x = prevX;
    y = prevY;
  }
  return { removed, added, anchors };
}

/** Réunit les jetons voisins en plages. */
function ranges(tokens: Token[], indices: number[]): DiffRange[] {
  const out: DiffRange[] = [];
  for (const i of indices.sort((p, q) => p - q)) {
    const t = tokens[i];
    if (t.to <= t.from) continue;
    const last = out[out.length - 1];
    if (last && !last.block && !t.block && last.to === t.from) last.to = t.to;
    else out.push({ from: t.from, to: t.to, block: t.block });
  }
  return out;
}

/** Plages retirées (dans `before`) et ajoutées (dans `after`). */
export function compareDocs(before: PMNode, after: PMNode) {
  const a = tokenize(before);
  const b = tokenize(after);
  const { removed, added, anchors } = diffIndices(
    a.map((t) => t.text),
    b.map((t) => t.text),
  );
  // Endroits des différences dans le texte en cours (pour aller de l'une à
  // l'autre), une seule fois par paquet de jetons voisins.
  const end = after.content.size;
  const sorted = [...new Set(anchors)].sort((p, q) => p - q);
  const places: number[] = [];
  sorted.forEach((idx, k) => {
    if (k > 0 && idx - sorted[k - 1] <= 1) return;
    places.push(idx < b.length ? b[idx].from : end);
  });
  return {
    removed: ranges(a, removed),
    added: ranges(b, added),
    changes: places.length,
    places,
  };
}

export interface Stats {
  words: number;
  characters: number;
}

/**
 * Mots et signes (espaces compris), comme Outils > Nombre de mots. Le texte
 * barré d'une suggestion ne compte pas : il est en passe d'être retiré.
 */
export function docStats(doc: PMNode): Stats {
  let text = "";
  doc.descendants((node) => {
    if (node.isText) {
      if (!node.marks.some((m) => m.type.name === "deletion")) text += node.text;
      return false;
    }
    if (node.isBlock && text && !text.endsWith("\n")) text += "\n";
    return true;
  });
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const characters = [...text].filter((c) => c !== "\n").length;
  return { words, characters };
}
