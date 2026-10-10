// Linkage checks shared by the mark and inline portable specs. Binary and
// derived columns are checked after loading, when their rows can be read.

export function checkLeaves(leaves: readonly string[]): void {
  if (!Array.isArray(leaves) || leaves.length === 0)
    throw new TypeError("dendrogram leaves: expected a list of at least one label");
  const seen = new Set<string>();
  for (let i = 0; i < leaves.length; i++) {
    const label = leaves[i];
    if (typeof label !== "string")
      throw new TypeError(
        `dendrogram leaves[${i}]: expected a string; received ${JSON.stringify(label)}`,
      );
    if (seen.has(label))
      throw new TypeError(
        `dendrogram leaves[${i}]: ${JSON.stringify(label)} repeats; give each leaf its own label`,
      );
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
      `dendrogram leaves: expected ${n} labels for ${rows} merge rows; received ${leaves.length}`,
    );
  const used = new Uint8Array(n + rows);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < 3; column++) {
      const value = read(column, row);
      if (value === undefined) continue;
      const at = `dendrogram row ${row}, field "${fields[column]}"`;
      if (column === 2) {
        if (!Number.isFinite(value) || value < 0)
          throw new RangeError(`${at}: expected a finite, nonnegative height; received ${value}`);
      } else {
        if (!Number.isInteger(value) || value < 0 || value >= n + row)
          throw new RangeError(
            `${at}: expected a whole number naming a leaf or an earlier merge, 0 to ${n + row - 1}; received ${value}`,
          );
        if (used[value])
          throw new RangeError(
            `${at}: cluster ${value} is merged more than once; merge each cluster once`,
          );
        used[value] = 1;
      }
    }
  }
}
