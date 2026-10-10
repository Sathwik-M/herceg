import type { ChartMark, ChartOptions } from "herceg";

/** The map implementation's projection planning, behind the opaque public ChartMark type. */
interface MapLayer extends ChartMark {
  join(marks: readonly MapLayer[], config: ChartOptions): { plan(): { readonly key: string } };
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
  return `map:${layers[0]!.join(layers, config).plan().key}`;
}
