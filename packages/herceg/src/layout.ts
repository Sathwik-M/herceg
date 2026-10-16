// herceg/layout: where a chart's panels go. Columns of relative widths, rows
// of relative heights, grids whose cells span tracks, and insets drawn over
// a panel's plot, nested as deep as needed; `panels` turns a layout into the
// chart's `panels` option. A panel may be given by its id, with its
// settings in `panels([...], layout)`, or with its settings where it goes.
//
// ```ts
// import { columns, panel, panels, rows } from "herceg/layout";
//
// createChart(element, {
//   panels: panels(
//     columns([2, 1], [
//       rows([2, 1], [panel({ id: "latency", title: "p99" }), panel({ id: "errors" })]),
//       panel({ id: "share", title: "By region" }),
//     ]),
//   ),
//   marks: [
//     line(data, { panel: "latency", x: "time", y: "p99", color: "region" }),
//     bar(data, { panel: "errors", x: "time", y: "errors", color: "region" }),
//     pie(data, { panel: "share", category: "region", value: "requests" }),
//   ],
// });
// ```

import type {
  GridLayoutOptions,
  InsetOptions,
  LayoutCellOptions,
  LayoutOptions,
  PanelLayoutOptions,
  PanelRef,
} from "./layout/options.ts";
import type { InsetSpec, TrackSpec } from "./spec/spec.ts";

export {
  type GridLayoutOptions,
  type InsetOptions,
  type LayoutCellOptions,
  type LayoutOptions,
  normalizeLayout,
  type PanelDefinition,
  type PanelLayoutOptions,
  type PanelRef,
} from "./layout/options.ts";
export { type Panels, panels } from "./model/panels.ts";

/** Tracks: `n` of weight 1, or a size each (weights, `{ weight, min }`, or `{ px }`). */
export type Tracks = number | readonly TrackSpec[];

/** A grid's settings besides its tracks and cells. */
export interface GridOptions {
  /** Names the grid for scale scopes (`{ layout: id, by: "row" }`). */
  id?: string;
  /** Pixels between tracks: 12 by default. */
  gap?: number | { row?: number; column?: number };
}

function tracks(given: Tracks, what: string): TrackSpec[] {
  if (typeof given === "number") {
    if (!(Number.isInteger(given) && given >= 1))
      throw new RangeError(
        `${what}: expected a whole number of at least 1 or a list of sizes; received ${given}`,
      );
    return Array.from({ length: given }, () => 1);
  }
  return [...given];
}

/** One row of cells side by side, `widths` (weights, `{ px }`) apart, holding `children` in order. */
export function columns(
  widths: Tracks,
  children: readonly LayoutOptions[],
  options: GridOptions = {},
): GridLayoutOptions {
  const sizes = tracks(widths, "columns");
  if (sizes.length !== children.length)
    throw new RangeError(
      `columns: expected a child per column, ${sizes.length}; received ${children.length}`,
    );
  return {
    type: "grid",
    ...options,
    rows: [1],
    columns: sizes,
    cells: children.map((content, column) => ({ row: 0, column, content })),
  };
}

/** One column of cells, `heights` (weights, `{ px }`) tall, holding `children` from the top. */
export function rows(
  heights: Tracks,
  children: readonly LayoutOptions[],
  options: GridOptions = {},
): GridLayoutOptions {
  const sizes = tracks(heights, "rows");
  if (sizes.length !== children.length)
    throw new RangeError(
      `rows: expected a child per row, ${sizes.length}; received ${children.length}`,
    );
  return {
    type: "grid",
    ...options,
    rows: sizes,
    columns: [1],
    cells: children.map((content, row) => ({ row, column: 0, content })),
  };
}

/**
 * A grid of `rows` and `columns` holding `cells`; without cells, the chart's
 * panels fill it row by row, in order (with as many rows as they need when
 * `rows` is left out).
 */
export function grid(
  options: GridOptions & { rows?: Tracks; columns?: Tracks },
  cells?: readonly LayoutCellOptions[],
): GridLayoutOptions {
  const { rows: r, columns: c, ...rest } = options;
  return {
    type: "grid",
    ...rest,
    ...(r !== undefined && { rows: tracks(r, "grid rows") }),
    ...(c !== undefined && { columns: tracks(c, "grid columns") }),
    ...(cells && { cells }),
  };
}

/** A cell of a `grid`: at a row and column (from 0), spanning `rowSpan` and `columnSpan` tracks. */
export function cell(
  place: { row: number; column: number; rowSpan?: number; columnSpan?: number },
  content: LayoutOptions,
): LayoutCellOptions {
  return { ...place, content };
}

/** A panel in a cell: one of the chart's by id, or its settings (its id may be left out), with insets over it. */
export function panel(ref: PanelRef, insets?: readonly InsetOptions[]): PanelLayoutOptions {
  return { type: "panel", panel: ref, ...(insets && { insets }) };
}

/** A panel drawn over another's plot, at a place and size (the top right, 35%, by default). */
export function inset(
  ref: PanelRef,
  options: Omit<InsetSpec, "panel" | "insets"> & { insets?: readonly InsetOptions[] } = {},
): InsetOptions {
  return { panel: ref, ...options };
}

/**
 * A grid drawn as rows of panel ids: an id repeated over a rectangle spans
 * it, and null leaves a cell empty. Panels named here take `panels`'
 * settings, by id.
 *
 * ```ts
 * mosaic([["latency", "share"], ["errors", "share"]], { rows: [2, 1], columns: [2, 1] })
 * ```
 */
export function mosaic(
  layout: readonly (readonly (string | null)[])[],
  options: GridOptions & {
    rows?: Tracks;
    columns?: Tracks;
    panels?: Readonly<Record<string, Omit<Exclude<PanelRef, string>, "id">>>;
  } = {},
): GridLayoutOptions {
  const { panels: settings, rows: r, columns: c, ...rest } = options;
  const width = layout[0]?.length ?? 0;
  if (layout.length === 0 || width === 0)
    throw new RangeError("mosaic: expected rows of panel ids; received none");
  for (const [i, row] of layout.entries())
    if (row.length !== width)
      throw new RangeError(
        `mosaic[${i}]: expected ${width} cells, as the first row has; received ${row.length}`,
      );
  const cells: LayoutCellOptions[] = [];
  const seen = new Set<string>();
  layout.forEach((row, r0) => {
    row.forEach((id, c0) => {
      if (id === null || seen.has(id)) return;
      seen.add(id);
      // The rectangle from the id's first cell, as far right and down as it goes.
      let c1 = c0;
      while (c1 + 1 < width && row[c1 + 1] === id) c1++;
      let r1 = r0;
      while (r1 + 1 < layout.length && layout[r1 + 1]![c0] === id) r1++;
      for (let r = 0; r < layout.length; r++)
        for (let k = 0; k < width; k++) {
          const inside = r >= r0 && r <= r1 && k >= c0 && k <= c1;
          if ((layout[r]![k] === id) !== inside)
            throw new RangeError(
              `mosaic: panel "${id}" occupies a region that is not a rectangle; give each panel a rectangle of cells`,
            );
        }
      const given = settings?.[id];
      cells.push({
        row: r0,
        column: c0,
        ...(r1 > r0 && { rowSpan: r1 - r0 + 1 }),
        ...(c1 > c0 && { columnSpan: c1 - c0 + 1 }),
        content: panel(given ? { ...given, id } : id),
      });
    });
  });
  for (const id of Object.keys(settings ?? {}))
    if (!seen.has(id))
      throw new RangeError(
        `mosaic panels: "${id}" is in no cell of the mosaic; place it or drop its settings`,
      );
  const sized = (given: Tracks | undefined, count: number, what: string) => {
    const out =
      given === undefined
        ? Array.from({ length: count }, () => 1)
        : tracks(given, `mosaic ${what}`);
    if (out.length !== count)
      throw new RangeError(
        `mosaic ${what}: expected ${count}, one per ${what.slice(0, -1)}; received ${out.length}`,
      );
    return out;
  };
  return {
    type: "grid",
    ...rest,
    rows: sized(r, layout.length, "rows"),
    columns: sized(c, width, "columns"),
    cells,
  };
}
