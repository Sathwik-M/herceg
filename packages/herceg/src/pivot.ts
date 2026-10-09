// Row pivots, imported as `herceg/pivot`: a row view's rows as a crosstab,
// with a long table of its combinations that charts read. Kept out of the
// main entry so charts and grids that do not pivot load none of it.

export {
  PIVOT_LIMITS,
  type PivotColumn,
  PivotLimitError,
  type PivotLimits,
  type PivotOptions,
  type PivotSnapshot,
  type PivotValue,
  pivotRows,
  RowPivot,
} from "./data/pivot.ts";
