// Replacement columns for the notebook widget's shared tables.
import { encodedCategory, geometry, type Table } from "herceg";

/** Keep category labels and time kinds when resetting an existing table. */
export function resetColumns(table: Table, rows: Table): Parameters<Table["reset"]>[0] {
  const columns: Record<string, unknown> = Object.create(null);
  for (const field of table.fields()) {
    if (table.kind(field) === "geometry") {
      const { codes, set } = rows.geometries(field);
      columns[field] = geometry(set, codes);
      continue;
    }
    if (table.kind(field) !== "category") {
      columns[field] = rows.numbers(field);
      continue;
    }
    const { codes, dictionary } = rows.categories(field);
    columns[field] = encodedCategory(codes, dictionary);
  }
  return columns as Parameters<Table["reset"]>[0];
}
