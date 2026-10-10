import { table } from "../../src/data/table.ts";
import { dendrogram } from "../../src/marks/dendrogram.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import type { ChartConfig } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";

/** Heatmap categories in the linkage's first-child-before-second order. */
export function clustermap(): ChartConfig {
  const columns = ["c", "d", "a", "b"];
  const rows = ["r3", "r1", "r2"];
  const matrix = table({
    column: rows.flatMap(() => columns),
    row: rows.flatMap((row) => columns.map(() => row)),
    value: rows.flatMap((_, r) => columns.map((_, c) => r * 4 + c)),
  });
  const columnTree = table({ first: [0, 2, 5], second: [1, 3, 4], height: [1, 2, 4] });
  const rowTree = table({ first: [0, 2], second: [1, 3], height: [1, 3] });
  return {
    marks: [
      heatmap(matrix, { x: "column", y: "row", value: "value", panel: "matrix" }),
      dendrogram(columnTree, {
        first: "first",
        second: "second",
        height: "height",
        leaves: ["a", "b", "c", "d"],
        side: "bottom",
        panel: "top",
        stroke: "#ff0000",
      }),
      dendrogram(rowTree, {
        first: "first",
        second: "second",
        height: "height",
        leaves: ["r1", "r2", "r3"],
        side: "right",
        panel: "left",
        stroke: "#ff0000",
      }),
    ],
    panels: panels(
      [
        { id: "corner", x: { axis: false }, y: { axis: false } },
        { id: "top", y: { axis: false } },
        { id: "left", x: { axis: false } },
        { id: "matrix" },
      ],
      { columns: 2, rowHeights: [1, 4], columnWidths: [1, 4] },
    ),
    resolve: { x: "columns", y: "rows" },
  };
}
