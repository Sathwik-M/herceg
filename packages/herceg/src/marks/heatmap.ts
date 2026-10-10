import type { NumericArray } from "../data/column.ts";
import {
  type NumericField,
  type PositionField,
  type Schema,
  scanExtent,
  type Table,
  type TimeField,
} from "../data/table.ts";
import { rasterDrawing } from "../draw/raster.ts";
import { CellIndex } from "../lod/cell-index.ts";
import type { Breaks } from "../lod/m4.ts";
import type { LegendPart } from "../model/legend.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { RasterGeometry } from "../scene/scene.ts";
import type { Frozen, HeatmapSpec, Weekday } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { type Calendar, type CalendarLayout, placeCalendar } from "./heatmap-calendar.ts";
import { type AxisCells, heldCells, placeCells } from "./heatmap-cells.ts";
import { type AxisPlacement, paint, rasterAxes } from "./heatmap-raster.ts";
import { rampLegend } from "./legend-parts.ts";
import { definedFields } from "./line.ts";
import {
  type BandContext,
  type BandList,
  type Bands,
  bandIndices,
  type ChartMark,
  type Frame,
  fieldBands,
  frozen,
  type Hit,
  type MARK,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  type SummaryContext,
  seriesKey,
} from "./mark.ts";
import { type BandPlaces, placeAt, rowOf, type Series, TableCache } from "./series.ts";
import { unionExtent } from "./trace.ts";

interface HeatmapCommon<S extends Schema> {
  /** Cell value, mapped to color. */
  value: NumericField<S>;
  /**
   * Color ramp from low to high values, such as an imported scheme
   * (`viridis`, `rdbu`, ...). Defaults to the theme's sequential ramp, or its
   * diverging one with a midpoint.
   */
  colors?: readonly string[];
  /** The values at the ends of the ramp; the values' extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging ramps. */
  colorMidpoint?: number;
  /**
   * How a pixel showing several cells colors them, for grids with more
   * columns or rows than the plot has device pixels: by the "mean" (the
   * default), "max", or "min" of their values.
   */
  reduce?: "mean" | "max" | "min";
  label?: string;
  /** With the chart's `facet`, draw all cells in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  id?: string;
}

/** How cells sit along a number or time x: halfway to their neighbors, a step wide, or in bands. */
type XPlacement =
  | {
      /**
       * Each cell's width along a number or time x (milliseconds for
       * times), centered on its value but never past halfway to a closer
       * neighbor; values further apart leave gaps. Without it, cells reach
       * halfway to the values beside them.
       */
      xStep?: number;
      xBanded?: false;
    }
  | {
      /**
       * One column per distinct value of a number or time x, in ascending
       * order, as categories have, instead of cells along a number or time axis.
       */
      xBanded: true;
      xStep?: never;
    };

/** How cells sit along a number or time y, like `XPlacement`. */
type YPlacement =
  | {
      /** Each cell's height along a number or time y, as `xStep`. */
      yStep?: number;
      yBanded?: false;
    }
  | {
      /** One row per distinct value of a number or time y, rising, instead of cells along a y axis. */
      yBanded: true;
      yStep?: never;
    };

/** Cells at an x and a y. */
type GridOptions<S extends Schema> = {
  /**
   * Column field. Number and time fields place cells along a number or
   * time axis, which zooms and pans; category fields give one column per
   * category.
   */
  x: PositionField<S>;
  /** Row field, like `x`. Categories run top to bottom, numbers and times bottom to top. */
  y: PositionField<S>;
  date?: never;
  calendar?: never;
  weekStart?: never;
} & XPlacement &
  YPlacement;

/** The days of a time field, laid out as a calendar in the chart's time zone. */
interface CalendarOptions<S extends Schema> {
  /** The time field whose days are laid out; rows sharing a day share its cell. */
  date: TimeField<S>;
  /**
   * "weeks" (the default): a column per week along a time x axis, which
   * zooms, and a row per day of the week. "months": a row per month, each
   * month from the first day's to the last's, and a column per day of the
   * month, 1 to 31.
   */
  calendar?: CalendarLayout;
  /** The day weeks start on, at the top: "mon" by default. */
  weekStart?: Weekday;
  x?: never;
  y?: never;
  xStep?: never;
  yStep?: never;
  xBanded?: never;
  yBanded?: never;
}

export type HeatmapOptions<S extends Schema> = HeatmapCommon<S> &
  (GridOptions<S> | CalendarOptions<S>);

/**
 * Why a heatmap spec has neither or both of its forms (`x` and `y`, or a
 * `date` laid out as a calendar), if it does.
 */
export function heatmapFormError(spec: Record<string, unknown>): string | undefined {
  if (spec.date === undefined) {
    if (spec.x === undefined || spec.y === undefined)
      return "A heatmap needs x and y, or a date to lay out as a calendar";
    if (spec.calendar !== undefined || spec.weekStart !== undefined)
      return "calendar and weekStart are for heatmaps of a date";
    return undefined;
  }
  const grid = GRID.find((name) => spec[name] !== undefined);
  if (grid) return `A calendar heatmap places its date itself; it takes no ${grid}`;
  if (spec.calendar === "months" && spec.weekStart !== undefined)
    return "weekStart is for calendars of weeks";
  return undefined;
}

/** What only heatmaps of cells at an x and a y take. */
const GRID = ["x", "y", "xStep", "yStep", "xBanded", "yBanded"] as const;

const ANY: readonly ["number", "time", "category"] = ["number", "time", "category"];
/** Rows a vertical step looks up one at a time before it scans the cells. */
const LOOKUPS = 32;
const WEEK_STARTS: readonly string[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const REDUCERS: readonly string[] = ["mean", "max", "min"];

/** What a raster's pixels were last painted from; unchanged inputs skip repainting. */
interface Painted {
  /** The mark that painted them: charts reuse a series' buffer for the next mark in its place. */
  mark: HeatmapMark;
  version: number;
  /** Each row's band or cell along x and y. */
  x: NumericArray;
  y: NumericArray;
  /** A facet panel's rows, and its categories' places (see `Series.places`). */
  panelRows: Uint32Array | undefined;
  xPlaces: BandPlaces | undefined;
  yPlaces: BandPlaces | undefined;
  theme: Theme;
  /** The scales' domains, ranges, and band widths, the plot, and the raster ratio. */
  frame: readonly (number | undefined)[];
  /** Where the image is along x and y, in CSS pixels, and how many pixels it has. */
  image: readonly [number, number, number, number, number, number];
}

/**
 * A grid of cells colored by a value. Along a number or time axis, each
 * distinct value of the field is a cell reaching halfway to its neighbors
 * (or `xStep` / `yStep` wide), so the axis zooms and pans as other marks'
 * do; along a band axis (a category field, or `xBanded` / `yBanded`), each
 * band is one. The cells are painted into one image of at most the plot's
 * device pixels, and found under the pointer through an index of the rows
 * by cell.
 */
export class HeatmapMark implements Mark<Frozen<HeatmapSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<HeatmapSpec>;
  readonly table: Table<Schema>;
  readonly tooltip = "cell";
  readonly bandPadding = 0;
  /** Automatic y domains end at the cells' edges rather than at round values. */
  readonly tight = true;
  /** Whether each axis is banded: a category field, or one asked to be. */
  readonly #banded: { readonly x: boolean; readonly y: boolean };
  /**
   * Cell lookups for tooltips and the keyboard, keyed by the rows they index
   * (a facet panel's), or for whole columns by the x cell array.
   */
  readonly #cells = new WeakMap<object, CellIndex>();
  readonly #extent = new TableCache<readonly [number, number] | null>();
  /**
   * The cells along each axis of numbers or times, for each of the few
   * break contexts (charts sharing the mark) they were last placed for.
   */
  readonly #axes: { x: PlacedCells[]; y: PlacedCells[] } = { x: [], y: [] };
  /** The x cells each series was drawn on, for summaries, which have no scale to say which. */
  readonly #drawnOn = new WeakMap<Series, AxisCells>();
  /** The first and last cell along each axis that a facet panel's rows hold, by the rows. */
  readonly #held = {
    x: new WeakMap<Uint32Array, Held>(),
    y: new WeakMap<Uint32Array, Held>(),
  };
  /** Each x cell's lowest and highest y cell, by the rows they are of (or the whole x cell array). */
  readonly #columns = new WeakMap<object, Columns>();
  /** A calendar's layout and first day of the week, for heatmaps of a date. */
  readonly #layout: { calendar: CalendarLayout; weekStart: Weekday } | undefined;
  /**
   * Where the calendar places rows, for each of the few zones and locales
   * (charts sharing the mark) it was last placed in.
   */
  readonly #calendars: PlacedCalendar[] = [];
  /** Each placement of the weeks, by the days it gave series along x. */
  readonly #byDays = new WeakMap<NumericArray, Calendar>();
  /** A calendar's band indices, by the chart's band keys they were remapped to. */
  readonly #remapped = new WeakMap<readonly string[], { own: Int32Array; indices: Int32Array }>();

  constructor(input: HeatmapSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    const form = heatmapFormError(spec);
    if (form) throw new TypeError(form);
    if (spec.date === undefined) {
      requireField(table, spec.x!, ANY, "heatmap x");
      requireField(table, spec.y!, ANY, "heatmap y");
    } else {
      requireField(table, spec.date, ["time"], "heatmap date");
      const { calendar = "weeks", weekStart = "mon" } = spec;
      if (calendar !== "weeks" && calendar !== "months")
        throw new TypeError(`Heatmap calendar must be "weeks" or "months", not ${calendar}`);
      if (!WEEK_STARTS.includes(weekStart))
        throw new TypeError(`Heatmap weekStart must be a day such as "mon", not ${weekStart}`);
      this.#layout = { calendar, weekStart };
    }
    requireField(table, spec.value, NUMERIC, "heatmap value");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "heatmap colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "Heatmap");
    if (spec.reduce !== undefined && !REDUCERS.includes(spec.reduce)) {
      throw new TypeError(
        `Heatmap reduce must be "mean", "max", or "min", not ${JSON.stringify(spec.reduce)}`,
      );
    }
    const banded = (axis: "x" | "y") => {
      // Calendars band weekdays, and in months days of the month too.
      if (this.#layout) return axis === "y" || this.#layout.calendar === "months";
      const field = spec[axis]!;
      const option = axis === "x" ? spec.xBanded : spec.yBanded;
      const step = axis === "x" ? spec.xStep : spec.yStep;
      if (option !== undefined && typeof option !== "boolean")
        throw new TypeError(`Heatmap ${axis}Banded must be true or false, not ${option}`);
      const category = table.kind(field) === "category";
      if (step !== undefined) {
        if (!(step > 0 && Number.isFinite(step)))
          throw new RangeError(`Heatmap ${axis}Step must be a positive number, not ${step}`);
        if (category || option)
          throw new TypeError(
            `Heatmap ${axis}Step sizes cells along a number or time ${axis} axis; ` +
              (category ? `"${field}" holds categories` : `not with ${axis}Banded`),
          );
      }
      return category || option === true;
    };
    this.#banded = { x: banded("x"), y: banded("y") };
  }

  /** The field placing cells along an axis: `x` or `y`, or a calendar's date. */
  #field(axis: "x" | "y"): string {
    return this.spec.date ?? this.spec[axis]!;
  }

  /** Band axes for categories, banded fields, and calendar days; number and time axes otherwise. */
  channelKind(axis: "x" | "y") {
    return this.#banded[axis] ? "category" : this.table.kind(this.#field(axis));
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    if (!this.#banded[axis]) return undefined;
    if (this.#layout) return this.#placedCalendar(context).bands[axis];
    return fieldBands(this.table, this.#field(axis), context);
  }

  /** Where the calendar places the table's rows, in the chart's zone and locale. */
  #placedCalendar(context: Pick<BandContext, "zone" | "locale">): Calendar {
    const { table } = this;
    const { zone, locale } = context;
    const found = this.#calendars.find((c) => c.zone === zone && c.locale === locale);
    if (found?.version === table.version) return found.placed;
    const { calendar, weekStart } = this.#layout!;
    const dates = table.numbers(this.spec.date as never);
    const placed = placeCalendar(dates, calendar, weekStart, zone, locale);
    if (found) [found.version, found.placed] = [table.version, placed];
    else {
      this.#calendars.unshift({ version: table.version, zone, locale, placed });
      this.#calendars.length = Math.min(this.#calendars.length, 4);
    }
    if (placed.days) this.#byDays.set(placed.days, placed);
    return placed;
  }

  /** A calendar's band indices along `axis`, by the chart's bands there, whose order may differ. */
  #calendarBands(axis: "x" | "y", keys: readonly string[], context: BandContext): Int32Array {
    const placed = this.#placedCalendar(context);
    const own = placed.rows[axis]!;
    const ownKeys = placed.bands[axis]!.keys;
    if (keys.length === ownKeys.length && keys.every((key, i) => key === ownKeys[i])) return own;
    const cached = this.#remapped.get(keys);
    if (cached?.own === own) return cached.indices;
    const position = new Map(keys.map((key, i) => [key, i] as const));
    const to = Int32Array.from(ownKeys, (key) => position.get(key) ?? -1);
    const indices = own.map((band) => (band < 0 ? -1 : to[band]!));
    this.#remapped.set(keys, { own, indices });
    return indices;
  }

  series(
    key: MarkKey,
    _palette: Palette,
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ): Series[] {
    const { spec, table } = this;
    const values = table.numbers(spec.value as never);
    const ramp = spec.colors ?? context.theme.sequential;
    // Band axes place rows by band index; others by their values.
    const position = (axis: "x" | "y") => {
      const keys = bands[axis]?.keys ?? [];
      // A calendar's weeks place each row at the start of its day.
      if (!this.#banded[axis])
        return this.#layout
          ? this.#placedCalendar(context).days!
          : table.numbers(this.#field(axis) as never);
      if (this.#layout) return this.#calendarBands(axis, keys, context);
      return bandIndices(table, this.#field(axis), keys, context);
    };
    return [
      {
        key: seriesKey(key, "cells"),
        label: spec.label ?? spec.value,
        color: ramp[ramp.length - 1]!,
        x: position("x"),
        y: position("y"),
        y0: undefined,
        values,
        range: false,
        rows: undefined,
        length: table.length,
        sorted: false,
      },
    ];
  }

  /**
   * The cells along a number or time axis, for the table's version and,
   * along x, the time axis' breaks, which leave cells out and move them.
   */
  #axisCells(axis: "x" | "y", breaks: Breaks | undefined, s: Series | undefined): AxisCells {
    const { spec, table } = this;
    if (this.#layout) {
      if (breaks) throw new Error("Calendar heatmaps cannot leave out time breaks");
      // The weeks `s`'s days were placed in, in its chart's zone (see `series`).
      const placed = (s && this.#byDays.get(s.x)) ?? this.#calendars[0]?.placed;
      return (placed ?? this.#placedCalendar({ zone: "local", locale: undefined })).weeks!;
    }
    const placed = this.#axes[axis];
    const found = placed.find((entry) => entry.breaks === breaks);
    if (found?.version === table.version) return found.cells;
    const field = this.#field(axis);
    const step = axis === "x" ? spec.xStep : spec.yStep;
    const time = table.kind(field) === "time";
    const name = `Heatmap ${axis}`;
    const cells = placeCells(table.numbers(field as never), step, time, breaks, name);
    if (found) [found.version, found.cells] = [table.version, cells];
    else {
      placed.unshift({ version: table.version, breaks, cells });
      placed.length = Math.min(placed.length, 4);
    }
    return cells;
  }

  /**
   * The cells along an axis drawn by `scale` (without one, the x cells `s`
   * was drawn on, as summaries read them).
   */
  #cellsFor(s: Series, axis: "x" | "y", scale: PositionScale | undefined): AxisCells {
    if (scale || axis === "y") {
      const cells = this.#axisCells(axis, scale?.breaks, s);
      if (axis === "x") this.#drawnOn.set(s, cells);
      return cells;
    }
    return this.#drawnOn.get(s) ?? this.#axisCells(axis, undefined, s);
  }

  /**
   * Each row's cell along an axis drawn by `scale` (see `#cellsFor`): its
   * chart band on a band axis, else its cell among the axis' cells.
   */
  #ordinals(s: Series, axis: "x" | "y", scale: PositionScale | undefined): NumericArray {
    return this.#banded[axis] ? s[axis] : this.#cellsFor(s, axis, scale).cells;
  }

  /** The cells along a number or time axis (of `s`); log axes are refused. */
  #continuous(
    axis: "x" | "y",
    log: boolean,
    breaks: Breaks | undefined,
    s: Series | undefined,
  ): AxisCells {
    if (log) throw new Error(`Heatmap cells cannot be placed on a log ${axis} axis yet`);
    return this.#axisCells(axis, breaks, s);
  }

  xExtent(series: readonly Series[], log: boolean, breaks?: Breaks) {
    if (this.#banded.x) return undefined;
    const cells = this.#continuous("x", log, breaks, series[0]);
    return unionExtent(series.map((s) => this.#heldExtent(cells, "x", s)));
  }

  /** The edges of the cells the rows of `s` hold along `axis`. */
  #heldExtent(cells: AxisCells, axis: "x" | "y", s: Series): [number, number] | undefined {
    let held: [number, number] | undefined;
    if (!s.rows) held = heldCells(cells, undefined);
    else {
      const cached = this.#held[axis].get(s.rows);
      if (cached?.cells === cells) held = cached.held;
      else {
        held = heldCells(cells, s.rows);
        this.#held[axis].set(s.rows, { cells, held });
      }
    }
    return held && cells.extent(held[0], held[1]);
  }

  /**
   * The edges of the y cells in the columns that the x range [x0, x1]
   * overlaps (every column on a band x axis), as y extents of other marks
   * follow what x shows.
   */
  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    if (this.#banded.y) return undefined;
    const ys = this.#continuous("y", log, undefined, series[0]);
    if (this.#banded.x) return unionExtent(series.map((s) => this.#heldExtent(ys, "y", s)));
    const xs = this.#axisCells("x", breaks, series[0]);
    const [first, last] = xs.overlapping(Math.min(x0, x1), Math.max(x0, x1));
    let [low, high] = [ys.length, -1];
    for (const s of series) {
      const columns = this.#columnsOf(s, xs, ys);
      for (let c = first; c <= last; c++) {
        low = Math.min(low, columns.low[c]!);
        high = Math.max(high, columns.high[c]!);
      }
    }
    return low <= high ? ys.extent(low, high) : undefined;
  }

  /** Each x cell's lowest and highest y cell among the rows of `s`, built once per rows. */
  #columnsOf(s: Series, xs: AxisCells, ys: AxisCells): Columns {
    const key = s.rows ?? xs.cells;
    const cached = this.#columns.get(key);
    if (cached?.xs === xs && cached.ys === ys) return cached;
    const low = new Int32Array(xs.length).fill(ys.length);
    const high = new Int32Array(xs.length).fill(-1);
    const [xc, yc, rows] = [xs.cells, ys.cells, s.rows];
    for (let k = 0; k < s.length; k++) {
      const row = rows ? rows[k]! : k;
      const c = xc[row]!;
      const r = yc[row]!;
      if (c < 0 || r < 0) continue;
      if (r < low[c]!) low[c] = r;
      if (r > high[c]!) high[c] = r;
    }
    const columns = { xs, ys, low, high };
    this.#columns.set(key, columns);
    return columns;
  }

  stepCell(
    series: Series,
    position: number,
    columns: number,
    rows: number,
    frame: { x: PositionScale; y: PositionScale },
  ): number | undefined {
    // The index holds chart bands, or cells; a panel's own categories are
    // read at their places, as the panel draws them.
    const xPlaces = this.#banded.x ? series.places?.x : undefined;
    const yPlaces = this.#banded.y ? series.places?.y : undefined;
    const index = this.#cellIndex(series, frame.x, frame.y);
    const xs = this.#ordinals(series, "x", frame.x);
    const ys = this.#ordinals(series, "y", frame.y);
    // Which way cells run on screen: rows of categories run down the plot,
    // rows of numbers up it, and reversed domains run back.
    const right = direction(frame.x) < 0 ? -1 : 1;
    const up = direction(frame.y) < 0 ? 1 : -1;
    // The best cell so far, by a rank compared key by key (lowest first).
    let best = -1;
    let [ra, rb, rc] = [Number.POSITIVE_INFINITY, 0, 0];
    const consider = (position: number, a: number, b = 0, c = 0) => {
      if (a < ra || (a === ra && (b < rb || (b === rb && c < rc)))) {
        best = position;
        [ra, rb, rc] = [a, b, c];
      }
    };
    if (position < 0) {
      // Entering the grid: its top left cell, which places, kept in the
      // chart's order, leave where the index has it.
      const cell = index.corner(up > 0, right < 0);
      return cell < 0 ? undefined : cell;
    }
    const along = columns !== 0;
    const steps = Math.abs(along ? columns : rows);
    const ahead = Math.sign(along ? columns * right : rows * up);
    const row = rowOf(series, position);
    const [column, line] = [placeOf(xPlaces, xs[row]!), placeOf(yPlaces, ys[row]!)];
    // A step finds the next cell in its row (or column) by binary search
    // while there is one near; jumps and steps off the end scan the cells.
    if (steps !== Number.POSITIVE_INFINITY) {
      if (along) {
        const near = index.beside(xs[row]!, ys[row]!, ahead > 0);
        if (near >= 0) return near;
      } else {
        for (let j = 1; j <= LOOKUPS && line + j * ahead >= 0; j++) {
          const band = bandOf(yPlaces, line + j * ahead);
          if (band < 0) break;
          const near = index.find(xs[row]!, band);
          if (near >= 0) return near;
        }
      }
    }
    index.forEachCell((cb, rb, k) => {
      const c = placeOf(xPlaces, cb);
      const r = placeOf(yPlaces, rb);
      const offset = (along ? c - column : r - line) * ahead;
      if (offset <= 0) return;
      const across = Math.abs(along ? r - line : c - column);
      // The next cell in the same row (or column), else the nearest ahead in
      // another, so no cell is out of reach; the furthest for jumps.
      if (steps === Number.POSITIVE_INFINITY) {
        if (across === 0) consider(k, -offset);
      } else consider(k, across === 0 ? 0 : 1, offset, across);
    });
    return best < 0 ? undefined : best;
  }

  /**
   * How many cells are drawn in how many columns and rows, and the lowest
   * and highest, over the series' parts in every panel. Parts hold the
   * chart's band indices, so cells on band axes are named by the chart's
   * categories, and others by their values.
   */
  summarize(parts: readonly Series[], name: string, { format, bands }: SummaryContext): string {
    const count = (axis: "x" | "y") =>
      this.#banded[axis]
        ? (bands[axis]?.keys.length ?? 0)
        : parts[0]
          ? this.#cellsFor(parts[0], axis, undefined).length
          : 0;
    const label = (axis: "x" | "y", s: Series, row: number) => {
      const at = s[axis][row]!;
      return this.#banded[axis] ? (bands[axis]?.labels[at] ?? "") : format[axis](at);
    };
    const [columns, rows] = [count("x"), count("y")];
    const indexes = parts.map((s) => this.#indexOf(s, undefined, undefined, columns, rows));
    const usedColumns = new Uint8Array(columns);
    const usedRows = new Uint8Array(rows);
    let [cells, columnCount, rowCount] = [0, 0, 0];
    // The lowest and highest cells: their part and row, and their values.
    let low: [Series, number] | undefined;
    let high: [Series, number] | undefined;
    let [lowest, highest] = [Infinity, -Infinity];
    parts.forEach((s, i) => {
      indexes[i]!.forEachCell((c, r, k) => {
        cells++;
        if (!usedColumns[c]) [usedColumns[c], columnCount] = [1, columnCount + 1];
        if (!usedRows[r]) [usedRows[r], rowCount] = [1, rowCount + 1];
        const row = rowOf(s, k);
        const value = s.values[row]!;
        if (value < lowest) [low, lowest] = [[s, row], value];
        if (value > highest) [high, highest] = [[s, row], value];
      });
    });
    if (!low || !high) return `${name}: no values`;
    const at = ([s, row]: [Series, number]) =>
      `${format.value(s.values[row]!)} at ${label("x", s, row)}, ${label("y", s, row)}`;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
    return (
      `${name}: ${plural(cells, "cell")} in ${plural(columnCount, "column")} and ` +
      `${plural(rowCount, "row")}, lowest ${at(low)}, highest ${at(high)}`
    );
  }

  /** Cells are colored by value, so the legend shows the ramp instead of series. */
  legendEntry(): false {
    return false;
  }

  /** The legend of the scale coloring cells. */
  legends(series: readonly Series[], theme: Theme): LegendPart[] {
    const scale = this.#colorScale(theme);
    if (!scale || series.length === 0) return [];
    const title = this.spec.label ?? this.spec.value;
    const { domain, midpoint } = scale;
    return [rampLegend({ stops: scale.legendStops(), domain, title, midpoint })];
  }

  /** The scale coloring cells: over `colorDomain` or the values' extent. */
  #colorScale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    const domain = spec.colorDomain ?? this.#valueExtent();
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  #valueExtent(): readonly [number, number] | undefined {
    const values = this.table.numbers(this.spec.value as never);
    const extent = this.#extent.get(this.table, () => scanExtent(values, 0, values.length) ?? null);
    return extent ?? undefined;
  }

  /** How the image places `s`'s cells along `axis` of the frame. */
  #placement(s: Series, axis: "x" | "y", scale: PositionScale): AxisPlacement {
    if (!this.#banded[axis])
      return {
        kind: "cells",
        scale,
        cells: this.#continuous(axis, scale.type === "log", scale.breaks, s),
      };
    const places = s.places?.[axis];
    return { kind: "bands", scale, places, count: lastBand(places, scale.categories?.length ?? 0) };
  }

  geometry(series: readonly Series[], frame: Frame): RasterGeometry[] {
    const s = series[0];
    const colors = this.#colorScale(frame.theme);
    if (!s || s.length === 0 || frame.hidden.has(s.key) || !colors) return [];
    const { x, y, plot } = frame;
    const inputs: Painted = {
      mark: this,
      version: this.table.version,
      x: this.#ordinals(s, "x", x),
      y: this.#ordinals(s, "y", y),
      panelRows: s.rows,
      xPlaces: s.places?.x,
      yPlaces: s.places?.y,
      theme: frame.theme,
      frame: [
        ...[...x.domain, ...x.range, x.bandwidth, ...y.domain, ...y.range, y.bandwidth],
        ...[plot.x, plot.y, plot.width, plot.height, frame.rasterRatio],
      ],
      image: [0, 0, 0, 0, 0, 0],
    };
    // An unchanged frame draws the image last painted into the series'
    // buffer again, without placing a cell.
    let pixels = frame.bytes(s.key, "raster", 0);
    const last = painted.get(pixels.buffer);
    let image = last && samePainting(last, inputs) ? last.image : undefined;
    if (!image) {
      const buffer = (stage: string, length: number) => frame.doubles(s.key, stage, length);
      const axes = rasterAxes(
        this.#placement(s, "x", x),
        this.#placement(s, "y", y),
        plot,
        frame.rasterRatio,
        buffer,
      );
      if (!axes) return [];
      const [across, down] = axes;
      const count = across.size * down.size;
      pixels = frame.bytes(s.key, "raster", count * 4);
      const source = {
        ...{ x: inputs.x, y: inputs.y, values: s.values, rows: s.rows, length: s.length },
        index: () => this.#cellIndex(s, x, y),
      };
      paint(source, across, down, colors, this.spec.reduce ?? "mean", pixels, (stage) =>
        buffer(stage, count),
      );
      image = [across.from, across.to, across.size, down.from, down.to, down.size];
      painted.set(pixels.buffer, { ...inputs, image });
    }
    const [x0, x1, columns, y0, y1, rows] = image;
    return [
      {
        kind: "raster",
        draw: rasterDrawing,
        key: s.key,
        x: x0,
        y: y0,
        width: x1 - x0,
        height: y1 - y0,
        columns,
        rows,
        pixels: pixels.subarray(0, columns * rows * 4),
      },
    ];
  }

  /**
   * The center of a row's cell, where its marker sits and lassos and
   * calendar brushes find it: a value lies anywhere in its cell (a
   * calendar's day at the start of its week's).
   */
  pointAnchor(series: Series, row: number, frame: Frame): readonly [number, number] | undefined {
    const center = (axis: "x" | "y", scale: PositionScale) => {
      if (this.#banded[axis]) {
        const place = placeAt(series, axis, row);
        return place < 0 ? Number.NaN : scale.map(place);
      }
      const cells = this.#cellsFor(series, axis, scale);
      const cell = cells.cells[row]!;
      if (cell < 0) return Number.NaN;
      return scale.map(cells.value(cells.lower[cell]! / 2 + cells.upper[cell]! / 2));
    };
    const [px, py] = [center("x", frame.x), center("y", frame.y)];
    return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : undefined;
  }

  /**
   * The cell under the pointer, found in an index of the rows by cell: the
   * band under it, or along a number or time axis the cell whose span holds
   * the value there, so gaps between cells hold none.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const s = series[0];
    if (!s || frame.hidden.has(s.key)) return undefined;
    const c = this.#cellAt(s, "x", frame.x, px);
    const r = this.#cellAt(s, "y", frame.y, py);
    if (c < 0 || r < 0) return undefined;
    const position = this.#cellIndex(s, frame.x, frame.y).find(c, r);
    return position < 0 ? undefined : { series: s, position, distance: 0 };
  }

  /** The chart band or cell along `axis` at `pixel`, or -1 for none. */
  #cellAt(s: Series, axis: "x" | "y", scale: PositionScale, pixel: number): number {
    if (this.#banded[axis]) {
      // The band under the pointer, whether or not its cell has a pixel of its own.
      const place = Math.round(scale.invert(pixel));
      if (place < 0 || place >= (scale.categories?.length ?? 0)) return -1;
      // The index holds chart bands, which a panel's own categories place apart.
      return bandOf(s.places?.[axis], place);
    }
    const cells = this.#continuous(axis, scale.type === "log", scale.breaks, s);
    return cells.find(scale.invert(pixel));
  }

  /** The index of `s`'s positions by cell, for a frame drawing it on `x` and `y`. */
  #cellIndex(s: Series, x: PositionScale, y: PositionScale): CellIndex {
    const count = (axis: "x" | "y", scale: PositionScale) =>
      this.#banded[axis]
        ? lastBand(s.places?.[axis], scale.categories?.length ?? 0)
        : this.#axisCells(axis, scale.breaks, s).length;
    return this.#indexOf(s, x, y, count("x", x), count("y", y));
  }

  /**
   * The index of `s`'s positions by cell, in chart bands or cells, built
   * for a grid of `columns` x `rows` of them. Every caller's grid holds
   * every cell `s`'s rows do (the chart's bands, or those of the panel
   * drawing them, or every cell), so an index is whole whichever built it.
   * Band index and cell arrays are rebuilt whenever the table or the band
   * order changes, and a facet panel's rows whenever its table or the
   * panels do, so their identity tells whether an index is current. Panels
   * with categories of their own place the same bands in the same order
   * (see `BandPlaces`), so one index serves every panel drawing the same
   * rows (a mark repeated in each).
   */
  #indexOf(
    s: Series,
    xScale: PositionScale | undefined,
    yScale: PositionScale | undefined,
    columns: number,
    rows: number,
  ): CellIndex {
    const x = this.#ordinals(s, "x", xScale);
    const y = this.#ordinals(s, "y", yScale);
    const key = s.rows ?? x;
    const cached = this.#cells.get(key);
    if (cached?.x === x && cached.y === y && cached.values === s.values && cached.rows === s.rows)
      return cached;
    const index = new CellIndex(x, y, s.values, columns, rows, s.rows);
    this.#cells.set(key, index);
    return index;
  }
}

/** Where a calendar places rows, as of the table version, zone, and locale it was placed for. */
interface PlacedCalendar {
  version: number;
  readonly zone: string;
  readonly locale: string | undefined;
  placed: Calendar;
}

/** The cells along an axis, as of the table version and breaks they were placed for. */
interface PlacedCells {
  version: number;
  readonly breaks: Breaks | undefined;
  cells: AxisCells;
}

/** The cells a facet panel's rows hold along an axis, as of the cells they were found among. */
interface Held {
  cells: AxisCells;
  held: [number, number] | undefined;
}

/** Each x cell's lowest and highest y cell (`ys.length` and -1 for none), as of the cells they index. */
interface Columns {
  xs: AxisCells;
  ys: AxisCells;
  low: Int32Array;
  high: Int32Array;
}

/** What each raster buffer holds, keyed by the buffer, whichever heatmap painted it. */
const painted = new WeakMap<ArrayBuffer, Painted>();

function samePainting(a: Painted | undefined, b: Painted): boolean {
  return (
    a !== undefined &&
    a.mark === b.mark &&
    a.version === b.version &&
    a.x === b.x &&
    a.y === b.y &&
    a.panelRows === b.panelRows &&
    a.xPlaces === b.xPlaces &&
    a.yPlaces === b.yPlaces &&
    a.theme === b.theme &&
    a.frame.length === b.frame.length &&
    a.frame.every((v, i) => v === b.frame[i])
  );
}

/** Which way a scale's values run on screen: positive rightward or downward. */
function direction(scale: PositionScale): number {
  return Math.sign((scale.range[1] - scale.range[0]) * (scale.domain[1] - scale.domain[0]));
}

/** The place of chart band `band` in a panel placing bands at `places`. */
function placeOf(places: BandPlaces | undefined, band: number): number {
  return places ? places.at(band) : band;
}

/**
 * How many chart bands an axis of `count` bands reaches, from the first:
 * past its last, which a panel's own categories place last.
 */
function lastBand(places: BandPlaces | undefined, count: number): number {
  return places && count > 0 ? places.band(count - 1) + 1 : count;
}

/** The chart band at place `place` in a panel placing bands at `places`. */
function bandOf(places: BandPlaces | undefined, place: number): number {
  return places ? places.band(place) : place;
}

/**
 * A grid of colored cells: heatmaps and matrices.
 *
 * ```ts
 * heatmap(load, { x: "hour", y: "host", value: "cpu" })
 * ```
 */
export function heatmap<S extends Schema>(
  table: Table<S>,
  options: HeatmapOptions<S>,
): ChartMark<Frozen<HeatmapSpec>> {
  const shared = definedFields(options, [
    "label",
    "id",
    "facet",
    "panel",
    "colorMidpoint",
    "reduce",
  ]);
  let spec: HeatmapSpec;
  if (options.date !== undefined) {
    const { date, value } = options;
    spec = { type: "heatmap", date, value, ...shared };
    Object.assign(spec, definedFields(options, ["calendar", "weekStart"]));
  } else {
    const grid = options as HeatmapCommon<S> & GridOptions<S>;
    spec = { type: "heatmap", x: grid.x, y: grid.y, value: grid.value, ...shared };
    Object.assign(spec, definedFields(grid, ["xStep", "yStep", "xBanded", "yBanded"]));
  }
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [...options.colorDomain];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new HeatmapMark(spec, table as unknown as Table);
}
