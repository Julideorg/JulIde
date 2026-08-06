import type { FileNode } from "../../types";

export interface FlatFile {
  name: string;
  path: string;
  relativePath: string;
}

/** Depth-first list of every file in the tree, with workspace-relative paths. */
export function flattenTree(node: FileNode, prefix = ""): FlatFile[] {
  if (!node.is_dir) {
    return [{ name: node.name, path: node.path, relativePath: prefix + node.name }];
  }
  return (node.children ?? []).flatMap((child) => flattenTree(child, prefix + node.name + "/"));
}

/**
 * Subsequence match, scored. Returns -1 when `query` is not a subsequence of
 * `target`.
 *
 * Consecutive characters and matches at word boundaries score higher, so
 * "grst" ranks `git/GitReposiTory.jl` above an incidental scattering of the
 * same letters.
 */
export function fuzzyMatch(query: string, target: string): number {
  const lower = target.toLowerCase();
  const q = query.toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatchIdx = -1;

  for (let i = 0; i < lower.length && qi < q.length; i++) {
    if (lower[i] !== q[qi]) continue;
    score += 1;
    // Consecutive must outweigh word-boundary. The weighting this inherited
    // had it the other way round (2 vs 3), which ranked `s_o_l_v_e.jl` above
    // `solver.jl` for the query "solve" — every underscore counted as a
    // boundary bonus, so a scattered match beat the literal substring.
    if (lastMatchIdx === i - 1) score += 4;
    if (i === 0 || "/_-.".includes(target[i - 1])) score += 3;
    lastMatchIdx = i;
    qi++;
  }

  return qi === q.length ? score : -1;
}

/** Rank `items` against `query`, best first. An empty query preserves order. */
export function rank<T>(query: string, items: T[], key: (item: T) => string, limit = 50): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((item) => ({ item, score: fuzzyMatch(query, key(item)) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.item);
}
