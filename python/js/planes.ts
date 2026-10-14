import type { ChartMark, ChartOptions, Table } from "herceg";

/** The map implementation's projection planning, behind the opaque public ChartMark type. */
interface MapLayer extends ChartMark {
  readonly table: Table;
  join(
    marks: readonly MapLayer[],
    config: ChartOptions,
  ): { plan(fit?: readonly (Uint32Array | undefined)[]): { readonly key: string } };
}

/** A map's coordinate system, including projection parameters inferred from its current data. */
export function mapPlaneKey(config: ChartOptions): string | undefined {
  const marks = config.marks;
  if (
    !marks.length ||
    !marks.every(({ spec }) => spec.type === "geoshape" || spec.type === "geopoint")
  )
    return undefined;
  const layers = marks as MapLayer[];
  return `map:${layers[0]!.join(layers, config).plan(facetFit(config, layers)).key}`;
}

/**
 * The rows facet panels fit their map to, as they draw it: a splitting
 * layer's rows with every facet field's value (those in some panel), a
 * repeated layer's all of them.
 */
function facetFit(
  { facet }: ChartOptions,
  layers: readonly MapLayer[],
): (Uint32Array | undefined)[] | undefined {
  if (!facet) return undefined;
  const fields = [facet.field, facet.row, facet.column].filter((field) => field !== undefined);
  return layers.map(({ spec, table }) => {
    if (spec.facet === "repeat") return undefined;
    const codes = fields.map((field) => table.categories(field as never).codes);
    const rows: number[] = [];
    for (let row = 0; row < table.length; row++)
      if (codes.every((column) => column[row]! >= 0)) rows.push(row);
    return Uint32Array.from(rows);
  });
}

/**
 * The coordinate system of each map's or network's view, by state: the
 * chart's one (""), without subplots, or each subplot's. A map's is
 * `mapPlaneKey`'s; a network's is "graph", since the item epoch (its
 * marks and panels) names its layout.
 */
export function planeKeys(config: ChartOptions): Map<string, string> {
  const keys = new Map<string, string>();
  const states = config.panels
    ? config.panels.list.map(
        ({ id }) => [id, config.marks.filter(({ spec }) => spec.panel === id)] as const,
      )
    : [["", config.marks] as const];
  for (const [state, marks] of states) {
    const key =
      marks.length > 0 && marks.every(({ spec }) => spec.type === "graph")
        ? "graph"
        : mapPlaneKey({ ...config, marks, panels: undefined });
    if (key) keys.set(state, key);
  }
  return keys;
}
