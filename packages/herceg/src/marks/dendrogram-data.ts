// Linkage checks shared by the mark and inline portable specs. Binary and
// derived columns are checked after loading, when their rows can be read.

export function checkLeaves(leaves: readonly string[]): void {
  if (!Array.isArray(leaves) || leaves.length === 0)
    throw new TypeError("Dendrogram leaves must be a list of at least one category label");
  const seen = new Set<string>();
  for (let i = 0; i < leaves.length; i++) {
    const label = leaves[i];
    if (typeof label !== "string")
      throw new TypeError(`Dendrogram leaves[${i}] must be a category label (string)`);
    if (seen.has(label))
      throw new TypeError(`Dendrogram leaves[${i}] repeats label ${JSON.stringify(label)}`);
    seen.add(label);
  }
}

export function checkLinkage(
  rows: number,
  leaves: readonly string[],
  fields: readonly [string, string, string],
  read: (column: number, row: number) => number | undefined,
): void {
  checkLeaves(leaves);
  const n = rows + 1;
  if (leaves.length !== n)
    throw new RangeError(
      `Dendrogram leaves needs ${n} labels for ${rows} merge rows, got ${leaves.length}`,
    );
  const used = new Uint8Array(n + rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < 3; column++) {
      const value = read(column, row);
      if (value === undefined) continue;
      const at = `Dendrogram row ${row}, field "${fields[column]}"`;
      if (column === 2) {
        if (!Number.isFinite(value) || value < 0)
          throw new RangeError(`${at}: height must be finite and nonnegative, got ${value}`);
      } else {
        if (!Number.isInteger(value) || value < 0 || value >= n + row)
          throw new RangeError(
            `${at}: cluster id must be a whole number naming a leaf or an earlier merge (0 to ${n + row - 1}), got ${value}`,
          );
        if (used[value]) throw new RangeError(`${at}: cluster ${value} is merged more than once`);
        used[value] = 1;
      }
    }
  }
}
