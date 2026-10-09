// The order rows sort in, shared by derived tables' sort and row views.
//
// Keys compare in priority order; missing values (NaN, missing categories)
// come last whatever the direction; infinities are ordered values;
// categories order by label, lexically. Rows equal on every key keep their
// order, so sorts are stable and ties settle the same way after updates.

import type { Fields } from "./expression.ts";

export interface SortKey<F extends string = string> {
  field: F;
  /** "ascending" by default. */
  order?: "ascending" | "descending";
}

/**
 * Compares rows `a` and `b` of `fields` by `keys`, then by position: a
 * comparator for sorting row positions. Read the fields once per sort: the
 * comparator holds their current arrays.
 */
export function rowComparator(
  fields: Fields,
  keys: readonly SortKey[],
): (a: number, b: number) => number {
  const compares = keys.map((key) => keyComparator(fields, key));
  if (compares.length === 1) {
    const [compare] = compares as [(a: number, b: number) => number];
    return (a, b) => compare(a, b) || a - b;
  }
  return (a, b) => {
    for (const compare of compares) {
      const order = compare(a, b);
      if (order !== 0) return order;
    }
    return a - b;
  };
}

function keyComparator(fields: Fields, key: SortKey): (a: number, b: number) => number {
  const sign = key.order === "descending" ? -1 : 1;
  if (fields.kind(key.field) === "category") {
    const { codes, dictionary } = fields.categories(key.field);
    const rank = labelRanks(dictionary);
    return (a, b) => {
      const x = codes[a]!;
      const y = codes[b]!;
      if (x < 0 || y < 0) return x < 0 ? (y < 0 ? 0 : 1) : -1;
      return (rank[x]! - rank[y]!) * sign;
    };
  }
  const values = fields.numbers(key.field);
  return (a, b) => {
    const x = values[a]!;
    const y = values[b]!;
    if (x < y) return -sign;
    if (x > y) return sign;
    if (x === y) return 0;
    // Unordered: one of them, or both, is missing (NaN).
    return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : -1;
  };
}

/** Each dictionary code's place among the labels in lexical order (equal labels share it). */
function labelRanks(dictionary: readonly string[]): Int32Array {
  const codes = Array.from(dictionary.keys()).sort((a, b) => {
    const [x, y] = [dictionary[a]!, dictionary[b]!];
    return x < y ? -1 : x > y ? 1 : 0;
  });
  const rank = new Int32Array(dictionary.length);
  for (let i = 0, place = 0; i < codes.length; i++) {
    if (i > 0 && dictionary[codes[i]!] !== dictionary[codes[i - 1]!]) place = i;
    rank[codes[i]!] = place;
  }
  return rank;
}
