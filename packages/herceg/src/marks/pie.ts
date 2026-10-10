import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { ArcPath, arcDrawing, inSector, traceSector } from "../draw/arc.ts";
import { segmentDrawing } from "../draw/segments.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber, numberFormatter } from "../format/format.ts";
import { ELBOW, placePieLabels, RUN } from "../layout/pie-labels.ts";
import { fitText } from "../layout/text.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import type {
  ArcGeometry,
  Geometry,
  PieSlice,
  SegmentGeometry,
  TextGeometry,
} from "../scene/scene.ts";
import type { Frozen, PieSpec } from "../spec/spec.ts";
import {
  type LayoutFrame,
  type LayoutItem,
  type LayoutMark,
  type LayoutResult,
  RowsCache,
} from "./layout-mark.ts";
import { CATEGORY, type ChartMark, frozen, type MARK, requireField } from "./mark.ts";

export interface PieOptions<S extends Schema> {
  /** Category field: a slice per value. */
  category: CategoryField<S>;
  /** Number field summed per category; without it, slices count rows. */
  value?: NumberField<S>;
  /** The hole's radius as a fraction of the pie's: 0 (the default) for a pie, about 0.6 for a donut. */
  innerRadius?: number;
  /** "value" (the default) orders slices largest first, clockwise from the top; "input" keeps the categories' order. */
  sort?: "value" | "input";
  /** Labels beside the slices, joined to them by lines; true by default. */
  labels?: boolean;
  id?: string;
  /** With the chart's `panels`, the id of the panel the pie has to itself. */
  panel?: string;
}

/** Slices start at the top and go clockwise. */
const START = -Math.PI / 2;
const TAU = 2 * Math.PI;
/** Space between neighboring slices, in pixels. */
const GAP = 2;

export class PieMark implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly spec: Frozen<PieSpec>;
  readonly table: Table;
  readonly measure: string;
  /** Totals per category code, of all rows and of each facet panel's. */
  readonly #totals = new RowsCache<Float64Array>();

  constructor(input: PieSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.category, CATEGORY, "pie category");
    if (spec.value !== undefined) requireField(table, spec.value, ["number"], "pie value");
    const inner = spec.innerRadius ?? 0;
    if (!(inner >= 0 && inner < 1)) {
      throw new RangeError(`pie innerRadius: expected at least 0 and below 1; received ${inner}`);
    }
    this.table = table;
    this.measure = spec.value ?? "Count";
  }

  /**
   * The sum of the value (or the row count) per category code over `rows`
   * (all rows by default); negative, missing, and infinite values count as 0.
   */
  #sums(rows: Uint32Array | undefined): Float64Array {
    const table = this.table;
    return this.#totals.get(table, rows, () => {
      const { codes, dictionary } = table.categories(this.spec.category);
      const values = this.spec.value === undefined ? undefined : table.numbers(this.spec.value);
      const sums = new Float64Array(dictionary.length);
      const count = rows ? rows.length : table.length;
      for (let k = 0; k < count; k++) {
        const row = rows ? rows[k]! : k;
        const code = codes[row]!;
        if (code < 0) continue;
        const value = values ? values[row]! : 1;
        if (value > 0 && value < Number.POSITIVE_INFINITY) sums[code]! += value;
      }
      return sums;
    });
  }

  /** Every category with rows among `rows` (all rows by default), in slice order. */
  #slices(id: string | number, rows?: Uint32Array): PieSlice[] {
    const sums = this.#sums(rows);
    const { dictionary } = this.table.categories(this.spec.category);
    const slices: PieSlice[] = [];
    for (let code = 0; code < dictionary.length; code++) {
      // A category whose sum overflows a double has no slice.
      if (!(sums[code]! > 0 && sums[code]! < Number.POSITIVE_INFINITY)) continue;
      const label = dictionary[code]!;
      slices.push({ key: JSON.stringify([id, label]), label, value: sums[code]! });
    }
    if ((this.spec.sort ?? "value") === "value") slices.sort((a, b) => b.value - a.value);
    return slices;
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.#slices(id).map(({ key, label }) => ({ key, label, color: color(key) }));
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, measure, hidden, locale } = frame;
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const slices = this.#slices(frame.id, frame.rows).filter(({ key }) => !hidden.has(key));
    // Each slice's share, through fractions of the largest, so a total of
    // huge values does not overflow.
    const largest = Math.max(0, ...slices.map(({ value }) => value));
    const relative = slices.reduce((sum, { value }) => sum + value / largest, 0);
    const share = (value: number) => value / largest / relative;

    // Room beside the pie for labels, unless that leaves too small a pie.
    let labeled = (this.spec.labels ?? true) && slices.length > 0;
    const textRoom = Math.min(
      Math.max(0, ...slices.map(({ label }) => measure(label, font))),
      bounds.width * 0.25,
    );
    const gutter = textRoom + ELBOW + RUN + 3;
    // Leader lines bend above and below the pie too.
    let r = Math.min(bounds.width / 2 - gutter, bounds.height / 2 - ELBOW - 2);
    if (labeled && r < 24) {
      labeled = false;
      r = Math.min(bounds.width, bounds.height) / 2 - 2;
    } else if (!labeled) {
      r = Math.min(bounds.width, bounds.height) / 2 - 2;
    }
    r = Math.max(0, r);
    const r0 = r * (this.spec.innerRadius ?? 0);
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;

    // Each slice's end, as a fraction of the turn.
    const ends = new Float64Array(slices.length);
    let sum = 0;
    slices.forEach(({ value }, i) => {
      sum += share(value);
      ends[i] = sum;
    });
    if (slices.length > 0) ends[slices.length - 1] = 1;
    const angle = (fraction: number) => START + fraction * TAU;
    const gap = slices.length > 1 ? GAP : 0;
    const draw = (
      items: readonly PieSlice[],
      at: Float64Array,
      radius: number,
      labels: boolean,
    ) => {
      const sectors = this.#sectors(items, at, cx, cy, radius, frame);
      if (!labels) return [sectors];
      return [sectors, ...this.#labels(items, at, cx, cy, radius, frame, font, lineHeight)];
    };
    const geometry = draw(slices, ends, r, labeled);
    // Charts that animate changed values draw frames between two scenes as this one draws.
    if (frame.keyed)
      (geometry[0] as ArcGeometry).slices = { items: slices, ends, cx, cy, r, labeled, draw };

    const percent = numberFormatter({ style: "percent", maximumFractionDigits: 1 }, locale);
    const middle = (r0 + r) / 2 || r * 0.6;
    const items: LayoutItem[] = [];
    const itemOf = (i: number): LayoutItem => {
      const cached = items[i];
      if (cached) return cached;
      const slice = slices[i]!;
      const a0 = angle(i > 0 ? ends[i - 1]! : 0);
      const a1 = angle(ends[i]!);
      const outline = new ArcPath();
      traceSector(outline, cx, cy, r0, r, a0, a1, gap);
      const mid = (a0 + a1) / 2;
      items[i] = {
        key: slice.key,
        label: slice.label,
        color: frame.color(slice.key),
        value: slice.value,
        text: `${formatNumber(slice.value, locale)} (${percent(share(slice.value))})`,
        px: cx + middle * Math.cos(mid),
        py: cy + middle * Math.sin(mid),
        outline: outline.d,
      };
      return items[i];
    };
    return {
      geometry,
      itemAt(px, py) {
        const distance = Math.hypot(px - cx, py - cy);
        if (!(distance <= r && distance >= r0) || slices.length === 0) return undefined;
        // The fraction of the turn from the top, clockwise.
        let fraction = (Math.atan2(py - cy, px - cx) - START) / TAU;
        fraction -= Math.floor(fraction);
        let lo = 0;
        let hi = slices.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (ends[mid]! > fraction) hi = mid;
          else lo = mid + 1;
        }
        // As drawn: not in the gaps between slices, nor in slices too thin to show.
        const a0 = angle(lo > 0 ? ends[lo - 1]! : 0);
        const a1 = angle(ends[lo]!);
        return inSector(px, py, cx, cy, r0, r, a0, a1, gap) ? itemOf(lo) : undefined;
      },
      count: slices.length,
      item: itemOf,
      indexOf: (key) => slices.findIndex((slice) => slice.key === key),
      summary: () => this.#summary(slices, largest * relative, share, locale, percent),
    };
  }

  /** The sectors of slices ending at `ends` (fractions of the turn) around (cx, cy), out to `r`. */
  #sectors(
    slices: readonly PieSlice[],
    ends: Float64Array,
    cx: number,
    cy: number,
    r: number,
    frame: LayoutFrame,
  ): ArcGeometry {
    const r0 = r * (this.spec.innerRadius ?? 0);
    const angle = (fraction: number) => START + fraction * TAU;
    const arcs = new Float32Array(slices.length * 6);
    // Slices sharing a color are drawn together; palettes repeat colors.
    const indexOf = new Map<string, number>();
    const colorIndex = Uint32Array.from(slices, ({ key }) => {
      const color = frame.color(key);
      if (!indexOf.has(color)) indexOf.set(color, indexOf.size);
      return indexOf.get(color)!;
    });
    slices.forEach((_, i) => {
      arcs.set([cx, cy, r0, r, angle(i > 0 ? ends[i - 1]! : 0), angle(ends[i]!)], i * 6);
    });
    return {
      kind: "arc",
      draw: arcDrawing,
      key: "pie",
      arcs,
      count: slices.length,
      colors: [...indexOf.keys()],
      colorIndex,
      fillOpacity: 1,
      gap: slices.length > 1 ? GAP : 0,
    };
  }

  /** Labels beside the slices, with lines from each slice's edge. */
  #labels(
    slices: readonly PieSlice[],
    ends: Float64Array,
    cx: number,
    cy: number,
    r: number,
    frame: LayoutFrame,
    font: string,
    lineHeight: number,
  ): Geometry[] {
    const { bounds, theme, measure } = frame;
    const placed = placePieLabels(
      slices.map(({ value }, i) => ({
        angle: START + ((i > 0 ? ends[i - 1]! : 0) + ends[i]!) * Math.PI,
        priority: value,
      })),
      cx,
      cy,
      r,
      lineHeight,
      bounds.y,
      bounds.y + bounds.height,
    );
    // Each leader is four segments between its five points.
    const lines = new Float32Array(placed.length * 16);
    const sides = { start: [] as number[], end: [] as number[] };
    placed.forEach(({ line }, i) => {
      for (let k = 0; k < 4; k++) lines.set(line.slice(k * 2, k * 2 + 4), i * 16 + k * 4);
      sides[placed[i]!.anchor].push(i);
    });
    const geometry: Geometry[] = [
      {
        kind: "segments",
        draw: segmentDrawing,
        key: "pie-leaders",
        stroke: theme.muted,
        strokeWidth: 1,
        coords: lines,
        count: placed.length * 4,
      } as SegmentGeometry,
    ];
    for (const anchor of ["start", "end"] as const) {
      const which = sides[anchor];
      if (which.length === 0) continue;
      const coords = new Float32Array(which.length * 2);
      const labels = which.map((i, k) => {
        const { x, y, index } = placed[i]!;
        coords[k * 2] = x;
        coords[k * 2 + 1] = y;
        const room = anchor === "start" ? bounds.x + bounds.width - x : x - bounds.x;
        return fitText(slices[index]!.label, room, measure, font);
      });
      geometry.push({
        kind: "text",
        draw: textDrawing,
        key: `pie-labels-${anchor}`,
        fill: theme.text,
        anchor,
        halo: false,
        coords,
        labels,
        count: which.length,
      } as TextGeometry);
    }
    return geometry;
  }

  #summary(
    slices: readonly PieSlice[],
    total: number,
    share: (value: number) => number,
    locale: string | undefined,
    percent: (value: number) => string,
  ): string {
    const what = this.spec.value
      ? `${this.spec.value} by ${this.spec.category}`
      : this.spec.category;
    if (slices.length === 0) return `Pie of ${what}, with nothing to show.`;
    const largest = [...slices]
      .sort((a, b) => b.value - a.value)
      .slice(0, 3)
      .map(({ label, value }) => `${label} ${percent(share(value))}`);
    return `Pie of ${what}: ${slices.length} ${slices.length === 1 ? "slice" : "slices"} totaling ${formatNumber(total, locale)}. Largest: ${largest.join(", ")}.`;
  }
}

/**
 * A pie or donut chart: a slice per category of `category`, sized by the
 * sum of `value` over its rows, or their count. With the chart's `facet`, a
 * pie per panel, each of its panel's rows; with its `panels`, a pie in the
 * panel it names.
 *
 * ```ts
 * pie(sales, { category: "region", value: "revenue", innerRadius: 0.6 })
 * ```
 */
export function pie<S extends Schema>(
  table: Table<S>,
  options: PieOptions<S>,
): ChartMark<Frozen<PieSpec>> {
  const spec: PieSpec = { type: "pie", category: options.category };
  if (options.value !== undefined) spec.value = options.value;
  if (options.innerRadius !== undefined) spec.innerRadius = options.innerRadius;
  if (options.sort !== undefined) spec.sort = options.sort;
  if (options.labels !== undefined) spec.labels = options.labels;
  if (options.id !== undefined) spec.id = options.id;
  if (options.panel !== undefined) spec.panel = options.panel;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new PieMark(spec, table as unknown as Table);
}
