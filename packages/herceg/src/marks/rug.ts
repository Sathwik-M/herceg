import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { segmentDrawing } from "../draw/segments.ts";
import type { Breaks } from "../lod/m4.ts";
import type { SegmentGeometry } from "../scene/scene.ts";
import type { Frozen, RugSpec } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  buildSeries,
  CATEGORY,
  type ChartMark,
  type Frame,
  frozen,
  type Hit,
  type MARK,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
  type SummaryContext,
} from "./mark.ts";
import { lowerPosition, rowOf, type Series, TableCache, xExtent } from "./series.ts";
import { unionExtent } from "./trace.ts";

interface RugStyle<S extends Schema> {
  series?: CategoryField<S>;
  /** Length into the plot, in CSS pixels. Default 8. */
  length?: number;
  stroke?: string;
  /** Width in CSS pixels. Default 1. */
  strokeWidth?: number;
  label?: string;
  /**
   * Marks naming the same group share series by name: series of the same
   * name share a color, one legend entry, and visibility.
   */
  legendGroup?: string;
  axis?: "left" | "right";
  facet?: "repeat";
  panel?: string;
  id?: string;
}

/** Exactly one number or time field, with sides appropriate to its axis. */
export type RugOptions<S extends Schema> = RugStyle<S> &
  (
    | { x: NumericField<S>; y?: never; side?: "bottom" | "top" }
    | { y: NumericField<S>; x?: never; side?: "left" | "right"; axis?: "left" }
  );

/** Packed ticks, one per observation, at the plot edge. */
export class RugMark implements Mark<Frozen<RugSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<RugSpec>;
  readonly table: Table;
  readonly tooltip: "x" | "y";
  readonly #field: string;
  readonly #split: SeriesSplitter;
  readonly #ordered = new TableCache<ReturnType<SeriesSplitter["sources"]>>();
  /** Repeated parts count a value when any panel's scale can show it. */
  readonly #positive = new WeakMap<Series, boolean>();

  constructor(input: RugSpec, table: Table) {
    this.spec = frozen(input);
    this.table = table;
    const spec = this.spec;
    if ((spec.x !== undefined) === (spec.y !== undefined))
      throw new TypeError("rug: needs exactly one of x and y");
    this.tooltip = spec.x !== undefined ? "x" : "y";
    this.#field = (spec.x ?? spec.y)!;
    const sides = this.tooltip === "x" ? ["bottom", "top"] : ["left", "right"];
    if (spec.side !== undefined && !sides.includes(spec.side))
      throw new TypeError(
        `rug side: expected "${sides.join('" or "')}"; received ${JSON.stringify(spec.side)}`,
      );
    if (this.tooltip === "y" && spec.axis === "right")
      throw new TypeError('rug axis: a y rug has no right axis; drop axis: "right"');
    if (spec.length !== undefined && !(Number.isFinite(spec.length) && spec.length > 0))
      throw new TypeError(`rug length: expected a positive number; received ${spec.length}`);
    if (
      spec.strokeWidth !== undefined &&
      !(Number.isFinite(spec.strokeWidth) && spec.strokeWidth >= 0)
    )
      throw new TypeError(
        `rug strokeWidth: expected 0 or more pixels; received ${spec.strokeWidth}`,
      );
    requireField(table, this.#field, NUMERIC, `rug ${this.tooltip}`);
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "rug series");
    this.#split = new SeriesSplitter(table, this.#field, [this.#field], spec.series, spec.label);
  }

  channelKind(axis: "x" | "y") {
    return axis === this.tooltip ? this.table.kind(this.#field) : undefined;
  }

  series(key: MarkKey, palette: Palette): Series[] {
    const { table, spec } = this;
    const values = table.numbers(this.#field as never);
    const sources = this.#ordered.get(table, () =>
      this.#split.sources().map((source) => {
        // Sort row positions, never the source column. Ties keep separate rows.
        const length = source.rows?.length ?? values.length;
        let count = 0;
        for (let k = 0; k < length; k++)
          if (Number.isFinite(values[source.rows?.[k] ?? k]!)) count++;
        if (count === length && source.sorted) return source;
        const rows = new Uint32Array(count);
        let at = 0;
        for (let k = 0; k < length; k++) {
          const row = source.rows?.[k] ?? k;
          if (Number.isFinite(values[row]!)) rows[at++] = row;
        }
        rows.sort((a, b) => values[a]! - values[b]!);
        return { ...source, rows, sorted: true, stream: undefined };
      }),
    );
    // Both columns alias the observations for the existing series machinery;
    // only `tooltip` is a data coordinate. `place` supplies the pixel anchor.
    return buildSeries(table, sources, values, key, palette, spec.stroke);
  }

  xExtent(series: readonly Series[], log: boolean, _breaks?: Breaks) {
    return this.tooltip === "x" ? unionExtent(series.map((s) => xExtent(s, log))) : undefined;
  }

  yExtent(series: readonly Series[], _x0: number, _x1: number, log: boolean) {
    return this.tooltip === "y" ? unionExtent(series.map((s) => xExtent(s, log))) : undefined;
  }

  /** A tick's midpoint, with no requirement on the unused data axis. */
  place(s: Series, row: number, frame: Frame): readonly [number, number] | undefined {
    const value = s.values[row]!;
    const scale = frame[this.tooltip];
    if (!Number.isFinite(value) || (scale.type === "log" && value <= 0)) return undefined;
    if (scale.breaks?.hides(value)) return undefined;
    const at = scale.map(value);
    if (!Number.isFinite(at)) return undefined;
    const [edge, end] = this.#edge(frame);
    return this.tooltip === "x" ? [at, (edge + end) / 2] : [(edge + end) / 2, at];
  }

  #edge({ plot }: Frame): readonly [number, number] {
    const length = Math.min(this.spec.length ?? 8, this.tooltip === "x" ? plot.height : plot.width);
    if (this.tooltip === "x") {
      const top = this.spec.side === "top";
      const edge = top ? plot.y : plot.y + plot.height;
      return [edge, edge + (top ? length : -length)];
    }
    const right = this.spec.side === "right";
    const edge = right ? plot.x + plot.width : plot.x;
    return [edge, edge + (right ? -length : length)];
  }

  geometry(series: readonly Series[], frame: Frame): SegmentGeometry[] {
    const out: SegmentGeometry[] = [];
    const horizontal = this.tooltip === "y";
    const scale = frame[this.tooltip];
    const [edge, end] = this.#edge(frame);
    const start = horizontal ? frame.plot.y : frame.plot.x;
    const stop = start + (horizontal ? frame.plot.height : frame.plot.width);
    for (const s of series) {
      this.#positive.set(s, (this.#positive.get(s) ?? true) && scale.type === "log");
      if (frame.hidden.has(s.key)) continue;
      const coords = frame.floats(s.key, "rug", s.length * 4);
      let count = 0;
      for (let k = 0; k < s.length; k++) {
        const value = s.values[rowOf(s, k)]!;
        if (scale.breaks?.hides(value)) continue;
        const at = scale.map(value);
        if (!Number.isFinite(at) || at < start || at > stop) continue;
        const offset = count++ * 4;
        coords[offset] = horizontal ? edge : at;
        coords[offset + 1] = horizontal ? at : edge;
        coords[offset + 2] = horizontal ? end : at;
        coords[offset + 3] = horizontal ? at : end;
      }
      out.push({
        kind: "segments",
        key: s.key,
        draw: segmentDrawing,
        coords,
        count,
        stroke: s.color,
        strokeWidth: this.spec.strokeWidth ?? 1,
      });
    }
    return out;
  }

  /** Binary search in value order; distance is to the actual clipped tick. */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const scale = frame[this.tooltip];
    const pointer = this.tooltip === "x" ? px : py;
    const lo = Math.min(...scale.domain);
    const hi = Math.max(...scale.domain);
    const [edge, end] = this.#edge(frame);
    const across = this.tooltip === "x" ? py : px;
    const distanceAcross = Math.max(Math.min(edge, end) - across, across - Math.max(edge, end), 0);
    let best: Hit | undefined;
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      const first = lowerPosition(s, lo);
      let low = first;
      let last = s.length;
      while (low < last) {
        const mid = (low + last) >>> 1;
        if (s.values[rowOf(s, mid)]! <= hi) low = mid + 1;
        else last = mid;
      }
      const after = Math.min(last, Math.max(first, lowerPosition(s, scale.invert(pointer))));
      const consider = (k: number): boolean => {
        const row = rowOf(s, k);
        const placed = this.place(s, row, frame);
        if (!placed) return true;
        const at = scale.map(s.values[row]!);
        const distance = Math.hypot(at - pointer, distanceAcross);
        if (distance >= (best?.distance ?? Infinity)) return false;
        const { plot } = frame;
        const lo = this.tooltip === "x" ? plot.x : plot.y;
        const hi = lo + (this.tooltip === "x" ? plot.width : plot.height);
        if (at >= lo && at <= hi) best = { series: s, position: k, distance };
        return true;
      };
      const breaks = scale.breaks;
      const back = (k: number) => (breaks ? breaks.shownBefore(s.x, k, s.rows) : k);
      const ahead = (k: number) => (breaks ? breaks.shownFrom(s.x, k, last, s.rows) : k);
      for (let k = back(after - 1); k >= first && consider(k); k = back(k - 1));
      for (let k = ahead(after); k < last && consider(k); k = ahead(k + 1));
    }
    return best;
  }

  readSeries(series: readonly Series[], frame: Frame): Series[] {
    const scale = frame[this.tooltip];
    return series.map((s) => {
      if (frame.hidden.has(s.key)) return s;
      const first = scale.type === "log" ? lowerPosition(s, Number.MIN_VALUE) : 0;
      if (first === 0 && !scale.breaks) return s;
      // Compact row positions only; columns stay views of the source table.
      const buffer = frame.bytes(s.key, "rug-reading", (s.length - first) * 4);
      const rows = new Uint32Array(buffer.buffer, buffer.byteOffset, s.length - first);
      let count = 0;
      for (let k = first; k < s.length; ) {
        k = scale.breaks?.shownFrom(s.x, k, s.length, s.rows) ?? k;
        if (k >= s.length) break;
        const row = rowOf(s, k++);
        if (Number.isFinite(scale.map(s.values[row]!))) rows[count++] = row;
      }
      return { ...s, rows: rows.subarray(0, count), length: count, stream: undefined };
    });
  }

  pointText(s: Series, row: number, format: AxisFormat): string {
    return format[this.tooltip](s.values[row]!);
  }

  summarize(parts: readonly Series[], name: string, context: SummaryContext): string {
    const fallbackLog = this.tooltip === "y" && context.log;
    let count = 0;
    let low = Infinity;
    let high = -Infinity;
    // Split parts have disjoint rows; repeated parts are the same series.
    for (const s of new Set(parts)) {
      const log = this.#positive.get(s) ?? fallbackLog;
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        const value = s.values[row]!;
        if (!Number.isFinite(value) || (log && value <= 0)) continue;
        count++;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    if (count === 0) return `${name}: no data`;
    const format = context.format[this.tooltip];
    return `${name}: ${count} ${count === 1 ? "value" : "values"}, from ${format(low)} to ${format(high)}`;
  }
}

/** Short ticks for each observation of one number or time field. */
export function rug<S extends Schema>(
  table: Table<S>,
  options: RugOptions<S>,
): ChartMark<Frozen<RugSpec>> {
  const spec = {
    type: "rug",
    ...definedFields(options as Partial<Record<keyof RugSpec, unknown>>, [
      "x",
      "y",
      "series",
      "length",
      "side",
      "stroke",
      "strokeWidth",
      "label",
      "legendGroup",
      "axis",
      "facet",
      "panel",
      "id",
    ]),
  } as RugSpec;
  if (table.name !== undefined) spec.data = table.name;
  return new RugMark(spec, table as unknown as Table);
}
