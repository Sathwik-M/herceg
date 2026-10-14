import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { lineDrawing } from "../draw/line.ts";
import { SvgPath } from "../draw/markup.ts";
import { pointDrawing } from "../draw/point.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { symbolPath } from "../draw/symbols.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber, numberTickLabels } from "../format/format.ts";
import { fitTickLabels, placeSpokeLabels, type SpokeLabel } from "../layout/radar-labels.ts";
import { Polyline } from "../lod/polyline.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import { linearTicks, niceDomain } from "../scale/ticks.ts";
import type {
  Geometry,
  LineGeometry,
  PathShape,
  PointGeometry,
  ShapesGeometry,
  TextGeometry,
} from "../scene/scene.ts";
import type { Frozen, RadarSpec } from "../spec/spec.ts";
import {
  type LayoutFrame,
  type LayoutItem,
  type LayoutMark,
  type LayoutResult,
  RowsCache,
} from "./layout-mark.ts";
import { CATEGORY, type ChartMark, frozen, type MARK, requireField } from "./mark.ts";

export type RadarOptions<S extends Schema> = (
  | {
      /** Category field: a spoke per value, in the field's dictionary order. */
      category: CategoryField<S>;
      /** Number field: the value on each row's spoke. */
      value: NumberField<S>;
      fields?: never;
    }
  | {
      /** Distinct number fields, a spoke each, clockwise from the top in this order. */
      fields: readonly NumberField<S>[];
      category?: never;
      value?: never;
    }
) & {
  /** Set false to leave text without its readability outline. */
  halo?: boolean;
  /** Category field: a polygon per value. With `fields`, the polygon takes its last row. */
  series?: CategoryField<S>;
  /** Values at the center and at the rim; from 0 (or the smallest value) to a round number above the largest by default. */
  domain?: readonly [number, number];
  /** Opacity of the polygons' fill, from 0 to 1; 0.15 by default. */
  fillOpacity?: number;
  /** A dot at each value; true by default. */
  points?: boolean;
  /** Name of the polygon of a radar without `series`, and of its values in tooltips. */
  label?: string;
  id?: string;
  /** With the chart's `panels`, the id of the panel the radar has to itself. */
  panel?: string;
};

/** Spokes start at the top and go clockwise. */
const START = -Math.PI / 2;
const TAU = 2 * Math.PI;
/** More spokes are unreadable, and could each hold a value of every series. */
const MAX_SPOKES = 100;
const POINT_RADIUS = 3;
/** How far from a value the pointer finds it, in pixels. */
const REACH = 24;

/**
 * What a radar's table holds: per series, its value on each spoke that has
 * one, in spoke order. Only values rows give are kept, however few of the
 * series and spoke pairs they fill.
 */
interface Values {
  spokes: string[];
  series: string[];
  /** Series s's values are entries `starts[s]` to `starts[s + 1]`. */
  starts: Int32Array;
  /** Each entry's spoke (there are at most MAX_SPOKES) and its finite value. */
  spoke: Uint8Array;
  value: Float64Array;
  /** Each entry's row: the last of its series to give its spoke a value. */
  row: Uint32Array;
}

/** Where a radar is drawn. */
interface Placement {
  cx: number;
  cy: number;
  radius: number;
  /** Each spoke's angle, in radians clockwise from +x. */
  angles: Float64Array;
  /** How far from the center a value lies: clamped to the rim, and to the center. */
  distance(value: number): number;
}

/** The shown values: each one's entry and series, and where it is drawn (x, y). */
interface Drawn {
  entries: number[];
  owners: number[];
  at: Float64Array;
  /** Each shown series' run of `entries`. */
  polygons: { series: number; from: number; to: number }[];
}

export class RadarMark implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly spec: Frozen<RadarSpec>;
  readonly table: Table;
  readonly measure: string;
  /** The series and spokes the table names, every facet panel's, and the table version. */
  #named: { version: number; series: Used | undefined; spokes: Used | undefined } | undefined;
  /** The values of all rows and of each facet panel's. */
  readonly #read = new RowsCache<Values>();

  constructor(input: RadarSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    const long = spec.category !== undefined || spec.value !== undefined;
    if (long === (spec.fields !== undefined) || (long && !(spec.category && spec.value)))
      throw new Error(
        "radar: needs category and value (a spoke per category) or fields (a spoke per field), not both",
      );
    if (long) {
      requireField(table, spec.category!, CATEGORY, "radar category");
      requireField(table, spec.value!, ["number"], "radar value");
    } else {
      const fields = spec.fields!;
      for (const field of fields) requireField(table, field, ["number"], "radar fields");
      const repeated = fields.find((field, i) => fields.indexOf(field) !== i);
      if (repeated !== undefined)
        throw new Error(`radar fields: "${repeated}" repeats; list each field once`);
      checkSpokes(fields.length, "fields");
    }
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "radar series");
    const [lo, hi] = spec.domain ?? [0, 1];
    if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo < hi))
      throw new RangeError(
        `radar domain: expected two finite numbers, ascending; received [${lo}, ${hi}]`,
      );
    const opacity = spec.fillOpacity ?? 0.15;
    if (!(opacity >= 0 && opacity <= 1))
      throw new RangeError(`radar fillOpacity: expected a number from 0 to 1; received ${opacity}`);
    this.table = table;
    this.measure = spec.label ?? spec.value ?? "Value";
    // The spokes of a long table are its data: with rows, too few or too many is a mistake now.
    if (long && table.length > 0) checkSpokes(this.#values().spokes.length, "category");
  }

  /** The series and spoke categories the table's rows hold, found when it changes. */
  #names(): { series: Used | undefined; spokes: Used | undefined } {
    const { table, spec } = this;
    if (this.#named?.version !== table.version) {
      const series = spec.series === undefined ? undefined : used(table, spec.series);
      const spokes = spec.fields ? undefined : used(table, spec.category!);
      this.#named = { version: table.version, series, spokes };
    }
    return this.#named;
  }

  /**
   * The values per series and spoke of `rows` (all rows by default), rebuilt
   * when the table changes. A later row replaces an earlier one's value for
   * the same series and spoke, since radar values are measurements, not
   * counts: with `fields`, each series is its last row, and without
   * `series` every row is one series. The series and spokes are the
   * table's, so that facet panels share them.
   */
  #values(rows?: Uint32Array): Values {
    return this.#read.get(this.table, rows, () => this.#gather(rows));
  }

  /** The values of `rows` (all rows without them); see `#values`. */
  #gather(rows: Uint32Array | undefined): Values {
    const { table, spec } = this;
    const { series, spokes: category } = this.#names();
    const names = series ? series.names : table.length > 0 ? [this.measure] : [];
    const spokes = category ? category.names : [...spec.fields!];
    const starts = new Int32Array(names.length + 1);
    const spoke: number[] = [];
    const value: number[] = [];
    const row: number[] = [];
    // Too many spokes are not drawn, so not read: that would cost time per series and spoke.
    if (spokes.length <= MAX_SPOKES) {
      const { offsets, order } = rowsBySeries(rows, table.length, names.length, (row) => {
        if (!series) return 0;
        const code = series.codes[row]!;
        return code < 0 ? -1 : series.place[code]!;
      });
      const numbers = category ? table.numbers(spec.value!) : undefined;
      const columns = category ? [] : spokes.map((field) => table.numbers(field));
      // One series at a time, its latest value per spoke.
      const latest = new Float64Array(spokes.length);
      const latestRow = new Uint32Array(spokes.length);
      for (let s = 0; s < names.length; s++) {
        latest.fill(Number.NaN);
        for (let i = offsets[s]!; i < offsets[s + 1]!; i++) {
          const at = order[i]!;
          if (category) {
            const code = category.codes[at]!;
            if (code < 0) continue;
            const k = category.place[code]!;
            latest[k] = numbers![at]!;
            latestRow[k] = at;
          } else {
            for (let k = 0; k < columns.length; k++) latest[k] = columns[k]![at]!;
            latestRow.fill(at);
          }
        }
        for (let k = 0; k < spokes.length; k++) {
          if (!Number.isFinite(latest[k]!)) continue;
          spoke.push(k);
          value.push(latest[k]!);
          row.push(latestRow[k]!);
        }
        starts[s + 1] = spoke.length;
      }
    }
    return {
      spokes,
      series: names,
      starts,
      spoke: Uint8Array.from(spoke),
      value: Float64Array.from(value),
      row: Uint32Array.from(row),
    };
  }

  #key(id: string | number, series: string): string {
    return JSON.stringify([id, series]);
  }

  legend(id: string | number, color: (key: string) => string): LegendEntry[] {
    return this.#values().series.map((label) => {
      const key = this.#key(id, label);
      return { key, label, color: color(key) };
    });
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, measure, hidden, locale } = frame;
    const data = this.#values(frame.rows);
    const { spokes, series, spoke, value } = data;
    const count = spokes.length;
    const keys = series.map((name) => this.#key(frame.id, name));
    const shown = series.flatMap((_, s) => (hidden.has(keys[s]!) ? [] : [s]));
    if (count < 3 || count > MAX_SPOKES) return this.#empty(shown.length, count);
    const colors = keys.map((key) => frame.color(key));
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const angles = Float64Array.from({ length: count }, (_, k) => START + (k * TAU) / count);
    const labeled = placeSpokeLabels(spokes, angles, bounds, measure, font, lineHeight);
    const radius = labeled.radius;
    // Rings about 25 pixels apart.
    const tickCount = Math.max(2, Math.min(6, Math.round(radius / 25)));
    const [lo, hi] = this.#domain(data, shown, tickCount);
    // Halves keep the span finite for values at the extremes of a double.
    const span = hi / 2 - lo / 2;
    const place: Placement = {
      cx: bounds.x + bounds.width / 2,
      cy: bounds.y + bounds.height / 2,
      radius,
      angles,
      distance: (v) => Math.min(1, Math.max(0, (v / 2 - lo / 2) / span)) * radius,
    };
    const drawn = this.#place(data, shown, place);

    const ticks = linearTicks(lo, hi, tickCount);
    const rings = ticks.filter((tick) => tick > lo && tick < hi);
    const geometry: Geometry[] = [this.#grid(rings, hi, place, frame)];
    geometry.push(...this.#polygons(drawn, data, colors, frame));
    // The rim's value continues the rings' steps unless a given domain ends between them.
    const stepped = rings.length > 0 && ticks[ticks.length - 1] === hi;
    geometry.push(this.#ticks(rings, hi, stepped, place, labeled.labels, frame, font, lineHeight));
    for (const anchor of ["start", "middle", "end"] as const) {
      const placed = labeled.labels.filter((label) => label.anchor === anchor);
      if (placed.length === 0) continue;
      geometry.push({
        kind: "text",
        draw: textDrawing,
        key: `radar-spokes-${anchor}`,
        fill: theme.text,
        anchor,
        halo: false,
        coords: Float32Array.from(placed.flatMap(({ x, y }) => [x, y])),
        labels: placed.map(({ text }) => text),
        count: placed.length,
      } as TextGeometry);
    }

    const { entries, owners, at } = drawn;
    const f = (v: number) => formatNumber(v, locale);
    const keyOf = (i: number) =>
      JSON.stringify([frame.id, series[owners[i]!], spokes[spoke[entries[i]!]!]]);
    const itemOf = (i: number): LayoutItem => {
      const v = value[entries[i]!]!;
      const range =
        v > hi
          ? `above the axis maximum of ${f(hi)}`
          : v < lo
            ? `below the axis minimum of ${f(lo)}`
            : `of ${f(lo)} to ${f(hi)}`;
      const px = at[i * 2]!;
      const py = at[i * 2 + 1]!;
      return {
        key: keyOf(i),
        label: series[owners[i]!]!,
        color: colors[owners[i]!]!,
        value: v,
        text: `${spokes[spoke[entries[i]!]!]}: ${f(v)} (${range})`,
        px,
        py,
        outline: symbolPath("circle", px, py, POINT_RADIUS + 3),
        row: data.row[entries[i]!]!,
      };
    };
    let places: Map<string, number> | undefined;
    return {
      geometry,
      itemAt(px, py) {
        // Later series are drawn above earlier ones, so they win ties.
        let best = -1;
        let nearest = REACH;
        for (let i = 0; i < entries.length; i++) {
          const distance = Math.hypot(at[i * 2]! - px, at[i * 2 + 1]! - py);
          if (distance <= nearest) {
            best = i;
            nearest = distance;
          }
        }
        return best < 0 ? undefined : itemOf(best);
      },
      count: entries.length,
      item: itemOf,
      indexOf(key) {
        places ??= new Map(entries.map((_, i) => [keyOf(i), i]));
        return places.get(key) ?? -1;
      },
      summary: () => this.#summary(data, drawn, lo, hi, locale),
    };
  }

  /** Where each value of the shown series is drawn. */
  #place(data: Values, shown: readonly number[], place: Placement): Drawn {
    const { starts, spoke, value } = data;
    const entries: number[] = [];
    const owners: number[] = [];
    const polygons: Drawn["polygons"] = [];
    for (const s of shown) {
      const from = entries.length;
      for (let e = starts[s]!; e < starts[s + 1]!; e++) {
        entries.push(e);
        owners.push(s);
      }
      polygons.push({ series: s, from, to: entries.length });
    }
    const at = new Float64Array(entries.length * 2);
    entries.forEach((e, i) => {
      const distance = place.distance(value[e]!);
      const angle = place.angles[spoke[e]!]!;
      at[i * 2] = place.cx + distance * Math.cos(angle);
      at[i * 2 + 1] = place.cy + distance * Math.sin(angle);
    });
    return { entries, owners, at, polygons };
  }

  /**
   * The values at the center and the rim: `domain`, or from 0 (or the
   * smallest shown value, when negative) to a round number above the
   * largest, so the center reads as nothing.
   */
  #domain(data: Values, shown: readonly number[], tickCount: number): readonly [number, number] {
    if (this.spec.domain) return this.spec.domain;
    const { starts, value } = data;
    let smallest = 0;
    let largest = Number.NEGATIVE_INFINITY;
    for (const s of shown) {
      for (let e = starts[s]!; e < starts[s + 1]!; e++) {
        smallest = Math.min(smallest, value[e]!);
        largest = Math.max(largest, value[e]!);
      }
    }
    if (!(largest > smallest)) largest = smallest + (Math.abs(smallest) || 1);
    const nice = niceDomain(smallest, largest, tickCount);
    // Rounding outward can pass the largest double; the values' own extent is finite.
    return Number.isFinite(nice[0]) && Number.isFinite(nice[1]) ? nice : [smallest, largest];
  }

  /** A ring through each spoke at each of `rings` and at the rim, and a line from the center along each spoke. */
  #grid(rings: readonly number[], hi: number, place: Placement, frame: LayoutFrame): LineGeometry {
    const { theme } = frame;
    const { cx, cy, radius, angles } = place;
    const path = new Polyline();
    for (const value of [...rings, hi]) {
      const distance = place.distance(value);
      path.break();
      for (const angle of angles)
        path.push(cx + distance * Math.cos(angle), cy + distance * Math.sin(angle));
      path.push(cx + distance * Math.cos(angles[0]!), cy + distance * Math.sin(angles[0]!));
    }
    for (const angle of angles) {
      path.break();
      path.push(cx, cy);
      path.push(cx + radius * Math.cos(angle), cy + radius * Math.sin(angle));
    }
    return {
      kind: "line",
      draw: lineDrawing,
      key: "radar-grid",
      stroke: theme.grid,
      strokeWidth: 1,
      dash: theme.gridDash.length > 0 ? theme.gridDash : undefined,
      path,
    };
  }

  /**
   * Each shown series' polygon: a translucent fill when it has a value on
   * every spoke, an outline through neighboring values, and dots. Fills go
   * below every outline, so overlapping polygons stay readable.
   */
  #polygons(drawn: Drawn, data: Values, colors: readonly string[], frame: LayoutFrame): Geometry[] {
    const { theme } = frame;
    const count = data.spokes.length;
    const opacity = this.spec.fillOpacity ?? 0.15;
    const fills: PathShape[] = [];
    const lines: LineGeometry[] = [];
    const dots: PointGeometry[] = [];
    // A series' positions by spoke; NaN where it has no value.
    const corners = new Float64Array(count * 2);
    for (const { series: s, from, to } of drawn.polygons) {
      corners.fill(Number.NaN);
      for (let i = from; i < to; i++) {
        const k = data.spoke[drawn.entries[i]!]!;
        corners[k * 2] = drawn.at[i * 2]!;
        corners[k * 2 + 1] = drawn.at[i * 2 + 1]!;
      }
      const x = (k: number) => corners[(k % count) * 2]!;
      const y = (k: number) => corners[(k % count) * 2 + 1]!;
      const has = (k: number) => !Number.isNaN(x(k));
      let gap = -1;
      for (let k = 0; k < count && gap < 0; k++) if (!has(k)) gap = k;
      if (gap < 0 && opacity > 0) {
        const outline = new SvgPath();
        outline.moveTo(x(0), y(0));
        for (let k = 1; k < count; k++) outline.lineTo(x(k), y(k));
        outline.closePath();
        fills.push({
          d: outline.d,
          fill: colors[s]!,
          stroke: undefined,
          strokeWidth: 0,
          opacity,
          dash: undefined,
        });
      }
      // Around the polygon from just past a missing value, if there is one,
      // so each run of neighboring values is one stretch of the outline.
      const path = new Polyline();
      const first = gap < 0 ? 0 : gap + 1;
      for (let step = 0; step <= count; step++) {
        const k = first + step;
        if (!has(k)) {
          path.break();
          continue;
        }
        // A whole polygon returns to its first value; a broken one stops before the gap.
        if (step === count && gap >= 0) break;
        path.push(x(k), y(k));
      }
      lines.push({
        kind: "line",
        draw: lineDrawing,
        key: `radar-line-${s}`,
        stroke: colors[s]!,
        strokeWidth: theme.lineWidth,
        dash: undefined,
        path,
      });
      if (this.spec.points ?? true)
        dots.push({
          kind: "point",
          draw: pointDrawing,
          key: `radar-points-${s}`,
          fill: colors[s]!,
          fillOpacity: 1,
          opaque: true,
          radius: POINT_RADIUS,
          symbol: "circle",
          coords: Float32Array.from(drawn.at.subarray(from * 2, to * 2)),
          count: to - from,
        });
    }
    if (fills.length === 0) return [...lines, ...dots];
    const filled: ShapesGeometry = {
      kind: "shapes",
      draw: shapesDrawing,
      key: "radar-fills",
      shapes: fills,
      font: `${theme.fontSize}px ${theme.font}`,
      fontSize: theme.fontSize,
    };
    return [filled, ...lines, ...dots];
  }

  /**
   * The rings' values beside the first spoke, the rim's first, as many as
   * fit; the center, where every spoke meets, is left unlabeled.
   */
  #ticks(
    rings: readonly number[],
    hi: number,
    stepped: boolean,
    place: Placement,
    spokeLabels: readonly SpokeLabel[],
    frame: LayoutFrame,
    font: string,
    lineHeight: number,
  ): TextGeometry {
    const { locale } = frame;
    const values = [...rings, hi];
    // Rings and rim alike, unless the rim is off their steps and needs its own precision.
    const texts = stepped
      ? numberTickLabels(values, locale)
      : [...numberTickLabels(rings, locale), formatNumber(hi, locale)];
    const ticks = values
      .map((v, i) => ({ text: texts[i]!, x: place.cx + 4, y: place.cy - place.distance(v) }))
      .reverse();
    const fitted = fitTickLabels(ticks, spokeLabels, frame.bounds, frame.measure, font, lineHeight);
    return {
      kind: "text",
      draw: textDrawing,
      key: "radar-ticks",
      fill: frame.theme.muted,
      anchor: "start",
      halo: this.spec.halo !== false,
      coords: Float32Array.from(fitted.flatMap(({ x, y }) => [x, y])),
      labels: fitted.map(({ text }) => text),
      count: fitted.length,
    };
  }

  /** What a radar of too few or too many spokes draws: nothing, and a sentence saying why. */
  #empty(series: number, spokes: number): LayoutResult {
    const what = this.#what();
    const why =
      series === 0 || spokes === 0
        ? `Radar of ${what}, with nothing to show.`
        : spokes < 3
          ? `Radar of ${what}, with ${count(spokes, "spoke", "spokes")}: too few to draw (a radar needs 3).`
          : `Radar of ${what}, with ${spokes} spokes: too many to draw (a radar draws at most ${MAX_SPOKES}).`;
    return {
      geometry: [],
      itemAt: () => undefined,
      count: 0,
      item: () => {
        throw new RangeError("radar has no items");
      },
      indexOf: () => -1,
      summary: () => why,
    };
  }

  #what(): string {
    const { spec } = this;
    return spec.fields
      ? (spec.label ?? spec.fields.join(", "))
      : `${spec.value} by ${spec.category}`;
  }

  #summary(data: Values, drawn: Drawn, lo: number, hi: number, locale: string | undefined): string {
    const what = this.#what();
    const { spokes, series, spoke, value } = data;
    const { entries, owners, polygons } = drawn;
    if (entries.length === 0) return `Radar of ${what}, with nothing to show.`;
    let highest = 0;
    let lowest = 0;
    entries.forEach((e, i) => {
      if (value[e]! > value[entries[highest]!]!) highest = i;
      if (value[e]! < value[entries[lowest]!]!) lowest = i;
    });
    const f = (v: number) => formatNumber(v, locale);
    // A radar of one polygon names only spokes.
    const name = (i: number) => {
      const e = entries[i]!;
      const owner = series.length > 1 ? `${series[owners[i]!]}'s ` : "";
      return `${owner}${spokes[spoke[e]!]} ${f(value[e]!)}`;
    };
    // The series with values here: in a facet panel, some may have none.
    const filled = polygons.filter(({ from, to }) => to > from).length;
    const many = series.length > 1 ? `${count(filled, "series", "series")} over ` : "";
    return `Radar of ${what}: ${many}${count(spokes.length, "spoke", "spokes")}, from ${f(lo)} at the center to ${f(hi)} at the rim. Highest: ${name(highest)}. Lowest: ${name(lowest)}.`;
  }
}

/** Refuses a radar of too few spokes to make a polygon, or too many to read. */
function checkSpokes(spokes: number, option: string): void {
  if (spokes < 3 || spokes > MAX_SPOKES)
    throw new Error(`radar ${option}: expected 3 to ${MAX_SPOKES} spokes; received ${spokes}`);
}

/** "1 spoke", "5 spokes". */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A category field's values that rows hold, and each code's place among them. */
interface Used {
  codes: Int32Array;
  names: string[];
  place: Int32Array;
}

/**
 * The values of a category field that rows hold, in dictionary order, and
 * each code's place among them (-1 for codes no row holds).
 */
function used(table: Table, field: string): Used {
  const { codes, dictionary } = table.categories(field);
  const held = new Uint8Array(dictionary.length);
  for (let row = 0; row < table.length; row++) if (codes[row]! >= 0) held[codes[row]!] = 1;
  const place = new Int32Array(dictionary.length).fill(-1);
  const names: string[] = [];
  for (let code = 0; code < dictionary.length; code++) {
    if (!held[code]) continue;
    place[code] = names.length;
    names.push(dictionary[code]!);
  }
  return { codes, names, place };
}

/**
 * `rows` (the first `length` rows without them) grouped by series, in row
 * order within each: series s's rows are `order[offsets[s]]` to
 * `order[offsets[s + 1] - 1]`. Rows of no series (`seriesOf` -1) are left out.
 */
function rowsBySeries(
  rows: Uint32Array | undefined,
  length: number,
  seriesCount: number,
  seriesOf: (row: number) => number,
): { offsets: Int32Array; order: Int32Array } {
  const count = rows ? rows.length : length;
  const offsets = new Int32Array(seriesCount + 1);
  for (let k = 0; k < count; k++) {
    const s = seriesOf(rows ? rows[k]! : k);
    if (s >= 0) offsets[s + 1]!++;
  }
  for (let s = 0; s < seriesCount; s++) offsets[s + 1]! += offsets[s]!;
  const order = new Int32Array(offsets[seriesCount]!);
  const next = offsets.slice(0, seriesCount);
  for (let k = 0; k < count; k++) {
    const row = rows ? rows[k]! : k;
    const s = seriesOf(row);
    if (s >= 0) order[next[s]!++] = row;
  }
  return { offsets, order };
}

/**
 * A radar chart: spokes from a center, evenly spaced clockwise from the top,
 * and a polygon per series through its values. Spokes are the values of
 * `category`, with `value` the number on each, or the number `fields`, each
 * series' last row its polygon.
 *
 * ```ts
 * radar(scores, { category: "skill", value: "score", series: "player" })
 * radar(players, { fields: ["speed", "power", "range"], series: "name" })
 * ```
 */
export function radar<S extends Schema>(
  table: Table<S>,
  options: RadarOptions<S>,
): ChartMark<Frozen<RadarSpec>> {
  const spec: RadarSpec = { type: "radar" };
  if (options.fields !== undefined) spec.fields = [...options.fields];
  else {
    spec.category = options.category;
    spec.value = options.value;
  }
  if (options.series !== undefined) spec.series = options.series;
  if (options.domain !== undefined) spec.domain = [options.domain[0], options.domain[1]];
  if (options.fillOpacity !== undefined) spec.fillOpacity = options.fillOpacity;
  if (options.points !== undefined) spec.points = options.points;
  if (options.label !== undefined) spec.label = options.label;
  if (options.halo !== undefined) spec.halo = options.halo;
  if (options.id !== undefined) spec.id = options.id;
  if (options.panel !== undefined) spec.panel = options.panel;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new RadarMark(spec, table as unknown as Table);
}
