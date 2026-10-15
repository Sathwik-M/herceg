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
import type { Geometry, RasterGeometry } from "../scene/scene.ts";
import type { CellReduce, Clip, Frozen, HeatmapSpec, Weekday } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { type Calendar, type CalendarLayout, placeCalendar } from "./heatmap-calendar.ts";
import {
  type AxisCells,
  bandOf,
  boundedCells,
  distinct,
  heldCells,
  placeCells,
  stepCell,
} from "./heatmap-cells.ts";
import { paint, rasterAxes } from "./heatmap-raster.ts";
import { rampLegend } from "./legend-parts.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
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
  type SelectionDrawing,
  type SummaryContext,
  seriesKey,
} from "./mark.ts";
import { type BandPlaces, placeAt, rowOf, type Series, TableCache } from "./series.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";
import { unionExtent } from "./trace.ts";

interface HeatmapCommon<S extends Schema> {
  /** Number or time field: each cell's value, mapped to color. */
  color: NumericField<S>;
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
   * How rows sharing a cell combine into its value: "last" (the default),
   * the last of them with a value, or their "mean", "sum", "min", or
   * "max". Cells keep their values at every zoom.
   */
  reduce?: CellReduce;
  /**
   * How a pixel showing several cells colors them, for grids with more
   * columns or rows than the plot has device pixels: by the "mean" (the
   * default), "max", or "min" of the cells' values.
   */
  sampling?: { reduce?: "mean" | "max" | "min" };
  label?: string;
  /** `false` leaves the mark out of the chart's legends. */
  legend?: false;
  /** With the chart's `facet`, draw all cells in every panel instead of splitting them. */
  facet?: "repeat";
  /**
   * What the mark's drawing is cut to: "plot", "chart", or false for
   * nothing, so markers at the plot's edge show whole. Without it, data is
   * cut to the plot and labels are drawn whole.
   */
  clip?: Clip;
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /** Fields of the row tooltips show besides the mark's values, such as counts that are not plotted. */
  tooltip?: MarkTooltip<S>;
  id?: string;
}

/**
 * Where cells sit along x: at the values of `x`, halfway to their
 * neighbors, a step wide, or in bands; or between the edges `x1` and `x2`.
 */
type XPlacement<S extends Schema> =
  | {
      /**
       * Column field. Number and time fields place cells along a number or
       * time axis, which zooms and pans; category fields give one column per
       * category.
       */
      x: PositionField<S>;
      /**
       * Each cell's width along a number or time x (milliseconds for
       * times), centered on its value but never past halfway to a closer
       * neighbor; values further apart leave gaps. Without it, cells reach
       * halfway to the values beside them.
       */
      xStep?: number;
      xBanded?: false;
      x1?: never;
      x2?: never;
    }
  | {
      x: PositionField<S>;
      /**
       * One column per distinct value of a number or time x, in ascending
       * order, as categories have, instead of cells along a number or time axis.
       */
      xBanded: true;
      xStep?: never;
      x1?: never;
      x2?: never;
    }
  | {
      /**
       * Number or time field: each row's cell's left edge, as the bins of a
       * `bin` transform with `end` give them. Rows of one left edge must
       * have one right edge, and cells must not overlap.
       */
      x1: NumericField<S>;
      /** Each row's cell's right edge, above its left. */
      x2: NumericField<S>;
      x?: never;
      xStep?: never;
      xBanded?: never;
    };

/** Where cells sit along y, as `XPlacement`. Categories run top to bottom, numbers and times bottom to top. */
type YPlacement<S extends Schema> =
  | {
      /** Row field, like `x`. */
      y: PositionField<S>;
      /** Each cell's height along a number or time y, as `xStep`. */
      yStep?: number;
      yBanded?: false;
      y1?: never;
      y2?: never;
    }
  | {
      y: PositionField<S>;
      /** One row per distinct value of a number or time y, rising, instead of cells along a y axis. */
      yBanded: true;
      yStep?: never;
      y1?: never;
      y2?: never;
    }
  | {
      /** Each row's cell's bottom edge, as `x1`. */
      y1: NumericField<S>;
      /** Each row's cell's top edge. */
      y2: NumericField<S>;
      y?: never;
      yStep?: never;
      yBanded?: never;
    };

/** Cells at an x and a y, or between edges along either. */
type GridOptions<S extends Schema> = {
  date?: never;
  calendar?: never;
  weekStart?: never;
} & XPlacement<S> &
  YPlacement<S>;

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
  x1?: never;
  x2?: never;
  y1?: never;
  y2?: never;
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
    for (const axis of ["x", "y"] as const) {
      const [one, low, high] = [spec[axis], spec[`${axis}1`], spec[`${axis}2`]];
      if (one !== undefined && (low !== undefined || high !== undefined))
        return `heatmap ${axis}1: ${axis} places cells at values, ${axis}1 and ${axis}2 between edges; give one form`;
      if ((low === undefined) !== (high === undefined))
        return `heatmap ${low === undefined ? `${axis}1` : `${axis}2`}: missing; cells between edges need ${axis}1 and ${axis}2`;
      if (one === undefined && low === undefined)
        return "heatmap: needs x and y (or x1 and x2, y1 and y2), or a date to lay out as a calendar";
      if (low !== undefined) {
        const option = [`${axis}Step`, `${axis}Banded`].find((name) => spec[name] !== undefined);
        if (option)
          return `heatmap ${option}: cells between ${axis}1 and ${axis}2 take their edges from them; drop ${option}`;
      }
    }
    if (spec.calendar !== undefined || spec.weekStart !== undefined)
      return "heatmap: calendar and weekStart are for heatmaps of a date; give date or drop them";
    return undefined;
  }
  const grid = GRID.find((name) => spec[name] !== undefined);
  if (grid) return `heatmap ${grid}: a calendar places its date itself; drop ${grid}`;
  if (spec.calendar === "months" && spec.weekStart !== undefined)
    return 'heatmap weekStart: for calendars of weeks; drop it or use calendar: "weeks"';
  return undefined;
}

/** What only heatmaps of cells at an x and a y take. */
const GRID = ["x", "y", "x1", "x2", "y1", "y2", "xStep", "yStep", "xBanded", "yBanded"] as const;

const ANY: readonly ["number", "time", "category"] = ["number", "time", "category"];
const WEEK_STARTS: readonly string[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const REDUCERS: readonly string[] = ["last", "mean", "sum", "min", "max"];
const SAMPLERS: readonly string[] = ["mean", "max", "min"];

/** What each raster buffer holds, keyed by the buffer, whichever mark painted it. */
interface Painted {
  inputs: readonly unknown[];
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
  /** Each index of rows' cells, with the rows sharing a cell combined (see `combine`). */
  readonly #resolved = new WeakMap<CellIndex, CombinedCells>();
  /**
   * The same, by the rows (or a whole table's x positions) of series read
   * for tooltips, which hold the combined values already.
   */
  readonly #read = new WeakMap<object, CombinedCells>();
  /**
   * The buffer of combined values the panels of one facet split share, by
   * each panel's rows: panels' rows are apart, so one buffer of the table's
   * length holds every panel's cells rather than one each.
   */
  readonly #splits = new WeakMap<Uint32Array, { buffer: Float64Array | undefined }>();
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
  /**
   * With `reduce: "sum"`, the extent of the sums of each series' cells, by
   * its rows (a facet panel's) or, for a whole table's, its x positions.
   */
  readonly #sums = new WeakMap<object, Sums>();
  /**
   * The extent of sums facet panels share, over every panel's (see
   * `splitPanels`), by the series facets split and their panels' rows.
   */
  readonly #shared = new WeakMap<
    object,
    { version: number; extent: readonly [number, number] | null }
  >();
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
  /** What the selection drawn with each series (and its copies read for tooltips) holds of its cells. */
  readonly #selected = new WeakMap<Series, HeldCells>();
  /** Each index's cells with values, as selections are counted in them. */
  readonly #runs = new WeakMap<CellIndex, CellRuns>();

  constructor(input: HeatmapSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "heatmap");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    const form = heatmapFormError(spec);
    if (form) throw new TypeError(form);
    if (spec.date === undefined) {
      for (const axis of ["x", "y"] as const) {
        const low = spec[`${axis}1`];
        if (low === undefined) {
          requireField(table, spec[axis]!, ANY, `heatmap ${axis}`);
          continue;
        }
        const high = spec[`${axis}2`]!;
        requireField(table, low, NUMERIC, `heatmap ${axis}1`);
        requireField(table, high, NUMERIC, `heatmap ${axis}2`);
        if (table.kind(low) !== table.kind(high))
          throw new TypeError(
            `heatmap ${axis}2: field "${high}" holds ${table.kind(high)} values and ${axis}1's "${low}" ${table.kind(low)} values; give edges of one kind`,
          );
      }
    } else {
      requireField(table, spec.date, ["time"], "heatmap date");
      const { calendar = "weeks", weekStart = "mon" } = spec;
      if (calendar !== "weeks" && calendar !== "months")
        throw new TypeError(
          `heatmap calendar: expected "weeks" or "months"; received ${JSON.stringify(calendar)}`,
        );
      if (!WEEK_STARTS.includes(weekStart))
        throw new TypeError(
          `heatmap weekStart: expected a day such as "mon"; received ${JSON.stringify(weekStart)}`,
        );
      this.#layout = { calendar, weekStart };
    }
    requireField(table, spec.color, NUMERIC, "heatmap color");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "heatmap colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "heatmap");
    if (spec.reduce !== undefined && !REDUCERS.includes(spec.reduce)) {
      throw new TypeError(
        `heatmap reduce: expected "last", "mean", "sum", "min", or "max"; received ${JSON.stringify(spec.reduce)}`,
      );
    }
    const sampling = spec.sampling?.reduce;
    if (sampling !== undefined && !SAMPLERS.includes(sampling)) {
      throw new TypeError(
        `heatmap sampling.reduce: expected "mean", "max", or "min"; received ${JSON.stringify(sampling)}`,
      );
    }
    const banded = (axis: "x" | "y") => {
      // Calendars band weekdays, and in months days of the month too.
      if (this.#layout) return axis === "y" || this.#layout.calendar === "months";
      if (spec[`${axis}1`] !== undefined) return false;
      const field = spec[axis]!;
      const option = axis === "x" ? spec.xBanded : spec.yBanded;
      const step = axis === "x" ? spec.xStep : spec.yStep;
      if (option !== undefined && typeof option !== "boolean")
        throw new TypeError(
          `heatmap ${axis}Banded: expected true or false; received ${JSON.stringify(option)}`,
        );
      const category = table.kind(field) === "category";
      if (step !== undefined) {
        if (!(step > 0 && Number.isFinite(step)))
          throw new RangeError(`heatmap ${axis}Step: expected a positive number; received ${step}`);
        if (category || option)
          throw new TypeError(
            `heatmap ${axis}Step: sizes cells along a number or time ${axis} axis; ` +
              (category
                ? `"${field}" holds categories, so drop ${axis}Step`
                : `drop it or ${axis}Banded`),
          );
      }
      return category || option === true;
    };
    this.#banded = { x: banded("x"), y: banded("y") };
  }

  /** The field placing cells along an axis: `x` or `y` (or the cells' left or bottom edges), or a calendar's date. */
  #field(axis: "x" | "y"): string {
    return this.spec.date ?? this.spec[axis] ?? this.spec[`${axis}1`]!;
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
    const values = table.numbers(spec.color as never);
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
    const whole: Series = {
      key: seriesKey(key, "cells"),
      label: spec.label ?? spec.color,
      color: ramp[ramp.length - 1]!,
      x: position("x"),
      y: position("y"),
      y0: undefined,
      values,
      range: false,
      rows: undefined,
      length: table.length,
      sorted: false,
    };
    return [whole];
  }

  /**
   * The cells along a number or time axis, for the table's version and,
   * along x, the time axis' breaks, which leave cells out and move them.
   */
  #axisCells(
    axis: "x" | "y",
    breaks: Breaks | undefined,
    s: Series | undefined,
    log = false,
  ): AxisCells {
    if (log)
      throw new Error(`heatmap: cells cannot go on a log ${axis} axis yet; use a linear one`);
    const { spec, table } = this;
    if (this.#layout) {
      if (breaks)
        throw new Error("heatmap date: calendars cannot leave out time breaks; drop x.breaks");
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
    const name = `heatmap ${axis}`;
    const end = spec[`${axis}2`];
    if (end !== undefined && breaks)
      throw new Error(
        `heatmap ${axis}1: cells between edges cannot leave out time breaks yet; drop ${axis}.breaks`,
      );
    const cells =
      end === undefined
        ? placeCells(table.numbers(field as never), step, time, breaks, name)
        : boundedCells(table.numbers(field as never), table.numbers(end as never), name);
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
      const cells = this.#axisCells(axis, scale?.breaks, s, scale?.type === "log");
      if (axis === "x") this.#drawnOn.set(s, cells);
      return cells;
    }
    return this.#drawnOn.get(s) ?? this.#axisCells(axis, undefined, s);
  }

  /** Row ordinals and placement shared by painting, indexing, and interaction. */
  #resolve(s: Series, axis: "x" | "y", scale?: PositionScale): ResolvedAxis {
    if (this.#banded[axis]) {
      const places = s.places?.[axis];
      return {
        cells: undefined,
        ordinals: s[axis],
        places,
        count: lastBand(places, scale?.categories?.length ?? 0),
      };
    }
    const cells = this.#cellsFor(s, axis, scale);
    return { cells, ordinals: cells.cells, places: undefined, count: cells.length };
  }

  xExtent(series: readonly Series[], log: boolean, breaks?: Breaks) {
    if (this.#banded.x) return undefined;
    const cells = this.#axisCells("x", breaks, series[0], log);
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
    const ys = this.#axisCells("y", undefined, series[0], log);
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
    const { index } = this.#cellsOf(
      series,
      this.#resolve(series, "x", frame.x),
      this.#resolve(series, "y", frame.y),
    );
    return stepCell(index, position, columns, rows, frame, {
      x: this.#banded.x ? series.places?.x : undefined,
      y: this.#banded.y ? series.places?.y : undefined,
    });
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
    const resolved = parts.map((s) =>
      this.#cellsOf(s, this.#resolve(s, "x"), this.#resolve(s, "y"), columns, rows),
    );
    const usedColumns = new Uint8Array(columns);
    const usedRows = new Uint8Array(rows);
    let [cells, columnCount, rowCount] = [0, 0, 0];
    // The lowest and highest cells: their part and row, and their values.
    let low: [Series, number, number] | undefined;
    let high: [Series, number, number] | undefined;
    let [lowest, highest] = [Infinity, -Infinity];
    parts.forEach((s, i) => {
      const { index, values } = resolved[i]!;
      index.forEachCell((c, r, k) => {
        cells++;
        if (!usedColumns[c]) [usedColumns[c], columnCount] = [1, columnCount + 1];
        if (!usedRows[r]) [usedRows[r], rowCount] = [1, rowCount + 1];
        const row = rowOf(s, k);
        const value = values[row]!;
        if (value < lowest) [low, lowest] = [[s, row, value], value];
        if (value > highest) [high, highest] = [[s, row, value], value];
      });
    });
    if (!low || !high) return `${name}: no values`;
    const at = ([s, row, value]: [Series, number, number]) =>
      `${format.value(value)} at ${label("x", s, row)}, ${label("y", s, row)}`;
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
    const scale = series[0] && this.#colorScale(theme, series[0]);
    if (!scale) return [];
    const title = this.spec.label ?? this.spec.color;
    const { domain, midpoint } = scale;
    return [rampLegend({ stops: scale.legendStops(), domain, title, midpoint })];
  }

  /**
   * The scale coloring the cells of `s`: over `colorDomain` or the values'
   * extent, or with `reduce: "sum"`, the extent of its cells' sums (with
   * facets, of every panel's).
   */
  #colorScale(theme: Theme, s: Series): SequentialScale | undefined {
    const { spec } = this;
    const domain = spec.colorDomain ?? this.#valueExtent(s);
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  #valueExtent(s: Series): readonly [number, number] | undefined {
    // Sums reach past the values; other reductions stay within them.
    if (this.spec.reduce === "sum") {
      const shared = this.#shared.get(s.rows ?? s);
      if (shared?.version === this.table.version) return shared.extent ?? undefined;
      return this.#sumsOf(s) ?? undefined;
    }
    const values = this.table.numbers(this.spec.color as never);
    return (
      this.#extent.get(this.table, () => scanExtent(values, 0, values.length) ?? null) ?? undefined
    );
  }

  /** The extent of the sums of the cells of `s`, kept while its table and positions are. */
  #sumsOf(s: Series): readonly [number, number] | null {
    const key = s.rows ?? s.x;
    const { version } = this.table;
    const found = this.#sums.get(key);
    if (found?.version === version && found.x === s.x && found.y === s.y) return found.extent;
    // The series' rows that have a cell: with a value, a band (not a missing
    // category), and between edges a usable pair of them.
    const { rows } = s;
    const n = rows ? rows.length : s.length;
    const [x, y, values] = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
    for (let k = 0; k < n; k++) {
      const row = rows ? rows[k]! : k;
      const has =
        (!this.#banded.x || s.x[row]! >= 0) &&
        (!this.#banded.y || s.y[row]! >= 0) &&
        this.shows(s, row);
      [x[k], y[k], values[k]] = [s.x[row]!, s.y[row]!, has ? s.values[row]! : Number.NaN];
    }
    const extent = sumExtent(x, y, values);
    this.#sums.set(key, { version, x: s.x, y: s.y, extent });
    return extent;
  }

  /**
   * Gives the panels facets split `series` into one buffer to combine their
   * cells into, and with `reduce: "sum"`, colors them on one ramp: over the
   * least and greatest sum of any panel's cells, each panel summing its own
   * rows.
   */
  splitPanels(series: readonly Series[], panels: readonly (readonly Series[])[]): void {
    const known = panels.flat().find((s) => s.rows && this.#splits.has(s.rows));
    const buffer = (known && this.#splits.get(known.rows!)) ?? { buffer: undefined };
    for (const panel of panels) for (const s of panel) if (s.rows) this.#splits.set(s.rows, buffer);
    if (this.spec.reduce !== "sum") return;
    let [min, max] = [Infinity, -Infinity];
    for (const panel of panels)
      for (const s of panel) {
        const extent = this.#sumsOf(s);
        if (extent) [min, max] = [Math.min(min, extent[0]), Math.max(max, extent[1])];
      }
    const shared = {
      version: this.table.version,
      extent: min <= max ? ([min, max] as const) : null,
    };
    for (const s of series) this.#shared.set(s, shared);
    for (const panel of panels) for (const s of panel) this.#shared.set(s.rows ?? s, shared);
  }

  /** Whether a row has a cell: between edges, only with a usable pair of them. */
  shows(_s: Series, row: number): boolean {
    for (const axis of ["x", "y"] as const) {
      const upper = this.spec[`${axis}2`];
      if (upper === undefined) continue;
      const low = this.table.numbers(this.spec[`${axis}1`] as never)[row]!;
      const high = this.table.numbers(upper as never)[row]!;
      if (!(Number.isFinite(low) && high > low && Number.isFinite(high))) return false;
    }
    return true;
  }

  geometry(series: readonly Series[], frame: Frame): RasterGeometry[] {
    const s = series[0];
    // Drawn so, no selection is drawn with the series.
    if (s) this.#selected.delete(s);
    const colors = s && this.#colorScale(frame.theme, s);
    if (!s || s.length === 0 || frame.hidden.has(s.key) || !colors) return [];
    return this.#image(s, frame, colors, s.key);
  }

  /**
   * The cells with a selection's rows in them: the image dimmed, and in
   * each cell holding selected rows a square of its color covering the
   * share of its rows they are (see cell-selection.ts).
   */
  selectedGeometry(series: readonly Series[], frame: Frame, drawing: SelectionDrawing): Geometry[] {
    const s = series[0];
    const colors = s && this.#colorScale(frame.theme, s);
    if (!s || s.length === 0 || frame.hidden.has(s.key) || !colors) return [];
    const whole = this.geometry(series, frame).flatMap(drawing.dim);
    const across = this.#resolve(s, "x", frame.x);
    const down = this.#resolve(s, "y", frame.y);
    // Every row of each cell, which combining its values leaves one of.
    const { values } = this.#cellsOf(s, across, down);
    const runs = this.#runsOf(this.#indexOf(s, across, down), values);
    const held = this.#heldOf(runs, drawing.selected);
    this.#selected.set(s, held);
    // An image of no cell draws nothing.
    if (held.lit.length === 0) return whole;
    const { columns, lines, last, sizes } = runs;
    const key = `${s.key}|selected`;
    const squares = drawing.squares(
      {
        count: last.length,
        held: held.lit.length,
        size: [this.#smallest(across, frame.x), this.#smallest(down, frame.y)],
        box: (k) => {
          const [x0, x1] = this.#edges(across, frame.x, columns[k]!);
          const [y0, y1] = this.#edges(down, frame.y, lines[k]!);
          return [x0, y0, x1, y1];
        },
        share: (k) => held.selected[k]! / sizes[k]!,
        color: (k) => colors.color(values[last[k]!]!),
      },
      key,
    );
    return [...whole, ...(squares ?? this.#image(s, frame, colors, key, held))];
  }

  /** The pixels a cell spans along an axis: its band, or between its edges. */
  #edges(
    { cells, places }: ResolvedAxis,
    scale: PositionScale,
    cell: number,
  ): readonly [number, number] {
    if (!cells) {
      const center = scale.map(places ? places.at(cell) : cell);
      const half = Math.abs(scale.bandwidth ?? 0) / 2;
      return [center - half, center + half];
    }
    return [scale.map(cells.value(cells.lower[cell]!)), scale.map(cells.value(cells.upper[cell]!))];
  }

  /** The fewest pixels any cell spans along an axis: a band, or the narrowest between its edges. */
  #smallest({ cells }: ResolvedAxis, scale: PositionScale): number {
    if (!cells) return Math.abs(scale.bandwidth ?? 0);
    let least = Infinity;
    for (let c = 0; c < cells.length; c++) {
      const [a, b] = [
        scale.map(cells.value(cells.lower[c]!)),
        scale.map(cells.value(cells.upper[c]!)),
      ];
      least = Math.min(least, Math.abs(b - a));
    }
    return least;
  }

  /**
   * The cells of `index` (all of each cell's rows) drawn with `values`:
   * each one's column and row of the grid, how many rows it has, and the
   * row its value is at; kept with the index, whatever the selection. A
   * cell whose value is missing (a sum past the largest double) is drawn
   * by none, and is left out.
   */
  #runsOf(index: CellIndex, values: NumericArray): CellRuns {
    const known = this.#runs.get(index);
    if (known?.values === values) return known;
    // At most a cell per position: cut to the cells found.
    const most = index.length;
    const [columns, lines] = [new Uint32Array(most), new Uint32Array(most)];
    const [sizes, last] = [new Uint32Array(most), new Uint32Array(most)];
    let count = 0;
    index.forEachRun((c, r, from, to) => {
      const row = index.rowOf(index.positionAt(to - 1));
      if (!Number.isFinite(values[row]!)) return;
      columns[count] = c;
      lines[count] = r;
      sizes[count] = to - from;
      last[count++] = row;
    });
    const cut = (array: Uint32Array) => (count < most ? array.slice(0, count) : array);
    const runs: CellRuns = {
      index,
      values,
      columns: cut(columns),
      lines: cut(lines),
      sizes: cut(sizes),
      last: cut(last),
    };
    this.#runs.set(index, runs);
    return runs;
  }

  /**
   * How many of each cell's rows `selected` holds, and the rows the values
   * of the cells holding any are at, for an image of them: one pass over the
   * cells' rows, kept while the selection and the cells are the same.
   */
  #heldOf(runs: CellRuns, selected: Uint8Array): HeldCells {
    let byRuns = helds.get(selected);
    if (!byRuns) {
      byRuns = new WeakMap();
      helds.set(selected, byRuns);
    }
    const known = byRuns.get(runs);
    if (known) return known;
    const { index, last } = runs;
    const counts = new Uint32Array(last.length);
    const lit: number[] = [];
    let k = 0;
    index.forEachRun((_c, _r, from, to) => {
      // Cells without a value are not among the runs: their last row tells them apart.
      if (k >= last.length || index.rowOf(index.positionAt(to - 1)) !== last[k]) return;
      let count = 0;
      for (let i = from; i < to; i++) count += selected[index.rowOf(index.positionAt(i))]!;
      counts[k] = count;
      if (count > 0) lit.push(last[k]!);
      k++;
    });
    const held: HeldCells = { runs, selected: counts, lit: Uint32Array.from(lit) };
    byRuns.set(runs, held);
    return held;
  }

  /**
   * The cell of `runs` whose value is at `row`, or -1: a binary search for
   * the row's cell among the runs, which are in cell order (by row, then
   * column), as the index is.
   */
  #cellAtRow(runs: CellRuns, row: number): number {
    const { index, columns, lines, last } = runs;
    const c = index.x[row]!;
    const r = index.y[row]!;
    let [lo, hi] = [0, last.length];
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (lines[mid]! < r || (lines[mid] === r && columns[mid]! < c)) lo = mid + 1;
      else hi = mid;
    }
    return lo < last.length && last[lo] === row ? lo : -1;
  }

  /**
   * The image of the cells of `s`, keyed `key`, as its buffers are: every
   * cell, or with `held`, those holding selected rows.
   */
  #image(
    s: Series,
    frame: Frame,
    colors: SequentialScale,
    key: string,
    held?: HeldCells,
  ): RasterGeometry[] {
    const { x, y, plot } = frame;
    const acrossAxis = this.#resolve(s, "x", x);
    const downAxis = this.#resolve(s, "y", y);
    const inputs = [
      this,
      held?.lit,
      this.table.version,
      acrossAxis.ordinals,
      downAxis.ordinals,
      s.rows,
      s.places?.x,
      s.places?.y,
      frame.theme,
      ...x.domain,
      ...x.range,
      x.bandwidth,
      ...y.domain,
      ...y.range,
      y.bandwidth,
      plot.x,
      plot.y,
      plot.width,
      plot.height,
      frame.rasterRatio,
    ];
    // An unchanged frame draws the image last painted into the series'
    // buffer again, without placing a cell.
    let pixels = frame.bytes(key, "raster", 0);
    const last = painted.get(pixels.buffer);
    let image = last && sameInputs(last.inputs, inputs) ? last.image : undefined;
    if (!image) {
      const buffer = (stage: string, length: number) => frame.doubles(key, stage, length);
      const axes = rasterAxes(
        { ...acrossAxis, scale: x },
        { ...downAxis, scale: y },
        plot,
        frame.rasterRatio,
        buffer,
      );
      if (!axes) return [];
      const [across, down] = axes;
      const count = across.size * down.size;
      pixels = frame.bytes(key, "raster", count * 4);
      const { index, values } = this.#cellsOf(s, acrossAxis, downAxis);
      // With `held`, only the rows of the cells holding selected rows are painted.
      const rows = held ? held.lit : s.rows;
      const source = {
        ...{
          x: acrossAxis.ordinals,
          y: downAxis.ordinals,
          values,
          rows,
          length: rows ? rows.length : s.length,
        },
        // The cells' index, or one of those holding selected rows.
        index: () =>
          held ? new CellIndex(index.x, index.y, values, index.columns, index.lines, rows) : index,
      };
      const sampling = this.spec.sampling?.reduce ?? "mean";
      paint(source, across, down, colors, sampling, pixels, (stage) => buffer(stage, count));
      image = [across.from, across.to, across.size, down.from, down.to, down.size];
      painted.set(pixels.buffer, { inputs, image });
    }
    const [x0, x1, columns, y0, y1, rows] = image;
    return [
      {
        kind: "raster",
        draw: rasterDrawing,
        key,
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

  /** A cell's row: its y (between edges, both), as tooltips name the cell. */
  pointLabel(series: Series, row: number, format: AxisFormat): string {
    const y = format.y(placeAt(series, "y", row));
    const high = this.spec.y2;
    return high === undefined ? y : `${y} – ${format.y(this.table.numbers(high as never)[row]!)}`;
  }

  /**
   * A cell's value, after its x edges for a cell between them; while a
   * selection is drawn, how many of its rows it holds.
   */
  pointText(series: Series, row: number, format: AxisFormat): string {
    const value = format.value(series.values[row]!);
    const high = this.spec.x2;
    const text =
      high === undefined
        ? value
        : `${format.x(series.x[row]!)} – ${format.x(this.table.numbers(high as never)[row]!)}: ${value}`;
    // A cell is read at the row its value is at.
    const held = this.#selected.get(series);
    const k = held ? this.#cellAtRow(held.runs, row) : -1;
    if (k < 0) return text;
    const [count, all] = [held!.selected[k]!, held!.runs.sizes[k]!];
    const f = format.value;
    return `${text}; ${f(count)} of ${f(all)} ${all === 1 ? "row" : "rows"} selected`;
  }

  /**
   * The cell under the pointer, found in an index of the rows by cell: the
   * band under it, or along a number or time axis the cell whose span holds
   * the value there, so gaps between cells hold none.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    const s = series[0];
    if (!s || frame.hidden.has(s.key)) return undefined;
    const across = this.#resolve(s, "x", frame.x);
    const down = this.#resolve(s, "y", frame.y);
    const c = this.#cellAt(across, frame.x, px);
    const r = this.#cellAt(down, frame.y, py);
    if (c < 0 || r < 0) return undefined;
    const position = this.#cellsOf(s, across, down).index.find(c, r);
    return position < 0 ? undefined : { series: s, position, distance: 0 };
  }

  /**
   * The series as tooltips and the keyboard read them: with each cell's
   * value at its last row (rows sharing it combined by `reduce`), and the
   * cell's other rows without one.
   */
  readSeries(series: readonly Series[], frame: Frame): Series[] {
    return series.map((s) => {
      const { values } = this.#cellsOf(
        s,
        this.#resolve(s, "x", frame.x),
        this.#resolve(s, "y", frame.y),
      );
      if (values === s.values) return s;
      const read = { ...s, values };
      // Tooltips of the copy say what the selection drawn with it holds.
      const selected = this.#selected.get(s);
      if (selected) this.#selected.set(read, selected);
      return read;
    });
  }

  /**
   * The cells of `s`: each one's value, its rows combined by `reduce`, and
   * an index of them (`#indexOf`'s, of the rows, when no rows share a cell).
   * A series read for tooltips (see `readSeries`) holds the values already.
   */
  #cellsOf(
    s: Series,
    across: ResolvedAxis,
    down: ResolvedAxis,
    columns = across.count,
    rows = down.count,
  ): CombinedCells {
    const key = s.rows ?? s.x;
    const read = this.#read.get(key);
    const { index: own } = read ?? {};
    if (
      read?.values === s.values &&
      own!.x === across.ordinals &&
      own!.y === down.ordinals &&
      own!.rows === s.rows
    )
      return read;
    const index = this.#indexOf(s, across, down, columns, rows);
    let cells = this.#resolved.get(index);
    if (!cells) {
      const split = s.rows && this.#splits.get(s.rows);
      if (split && split.buffer?.length !== s.values.length)
        split.buffer = new Float64Array(s.values.length).fill(Number.NaN);
      cells = combine(index, this.spec.reduce ?? "last", split ? split.buffer : undefined);
      this.#resolved.set(index, cells);
      if (cells.values !== index.values) this.#read.set(key, cells);
    }
    return cells;
  }

  /** The chart band or cell along `axis` at `pixel`, or -1 for none. */
  #cellAt({ cells, places }: ResolvedAxis, scale: PositionScale, pixel: number): number {
    const at = scale.invert(pixel);
    if (cells) return cells.find(at);
    const place = Math.round(at);
    return place < 0 || place >= (scale.categories?.length ?? 0) ? -1 : bandOf(places, place);
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
    across: ResolvedAxis,
    down: ResolvedAxis,
    columns = across.count,
    rows = down.count,
  ): CellIndex {
    const x = across.ordinals;
    const y = down.ordinals;
    const key = s.rows ?? x;
    const cached = this.#cells.get(key);
    if (cached?.x === x && cached.y === y && cached.values === s.values && cached.rows === s.rows)
      return cached;
    const index = new CellIndex(x, y, s.values, columns, rows, s.rows);
    this.#cells.set(key, index);
    return index;
  }
}

/**
 * A series' cells with values (see `HeatmapMark.#runsOf`), in the order of
 * the index they were found in: each one's column and row of the grid, how
 * many rows it has, and the row its value is at.
 */
interface CellRuns {
  index: CellIndex;
  /** The cells' values these were found with. */
  values: NumericArray;
  columns: Uint32Array;
  lines: Uint32Array;
  sizes: Uint32Array;
  last: Uint32Array;
}

/** What a selection holds of a series' cells: how many rows of each, and the rows the values of those holding any are at. */
interface HeldCells {
  runs: CellRuns;
  selected: Uint32Array;
  lit: Uint32Array;
}

/** What selections hold of cells, by membership, then by the cells. */
const helds = new WeakMap<Uint8Array, WeakMap<CellRuns, HeldCells>>();

/** A series' cells: their values by table row (none at rows a cell shares), and their index. */
interface CombinedCells {
  values: NumericArray;
  index: CellIndex;
}

/**
 * `index`'s cells with the rows sharing each combined by `reduce`: the
 * cell's value at its last row, and none (NaN) at its others, so painting,
 * tooltips, and summaries see one value per cell. An index without shared
 * cells is its own. A facet panel's cells go `into` the buffer its split
 * shares, at its own rows only.
 */
function combine(index: CellIndex, reduce: CellReduce, into?: Float64Array): CombinedCells {
  let shared = false;
  index.forEachRun((_c, _r, from, to) => {
    if (to - from > 1) shared = true;
  });
  if (!shared) return { values: index.values, index };
  const source = index.values;
  let values: Float64Array;
  if (into && index.rows) {
    values = into;
    for (const row of index.rows) values[row] = Number.NaN;
  } else values = new Float64Array(source.length).fill(Number.NaN);
  index.forEachRun((_c, _r, from, to) => {
    let total = reduce === "min" ? Infinity : reduce === "max" ? -Infinity : 0;
    let value = 0;
    for (let i = from; i < to; i++) {
      value = source[index.rowOf(index.positionAt(i))]!;
      if (reduce === "mean" || reduce === "sum") total += value;
      else if (reduce === "min") total = Math.min(total, value);
      else if (reduce === "max") total = Math.max(total, value);
    }
    let cell = reduce === "last" ? value : reduce === "mean" ? total / (to - from) : total;
    // A mean of values near the largest doubles, whose sum overflows: of the
    // values scaled to the largest of them, scaled back.
    if (reduce === "mean" && !Number.isFinite(total)) {
      let largest = 0;
      for (let i = from; i < to; i++)
        largest = Math.max(largest, Math.abs(source[index.rowOf(index.positionAt(i))]!));
      let scaled = 0;
      for (let i = from; i < to; i++) scaled += source[index.rowOf(index.positionAt(i))]! / largest;
      cell = Math.max(-largest, Math.min(largest, (scaled / (to - from)) * largest));
    }
    values[index.rowOf(index.positionAt(to - 1))] = cell;
  });
  const combined = new CellIndex(index.x, index.y, values, index.columns, index.lines, index.rows);
  return { values, index: combined };
}

/** The least and greatest sum of the values of the rows sharing a place (`x` and `y`). */
function sumExtent(
  x: NumericArray,
  y: NumericArray,
  values: NumericArray,
): readonly [number, number] | null {
  const [xs, columns] = distinct(x);
  const [ys, lines] = distinct(y);
  const index = new CellIndex(columns, lines, values, xs.length, ys.length);
  const sums = combine(index, "sum").values;
  let [min, max] = [Infinity, -Infinity];
  index.forEachRun((_c, _r, _from, to) => {
    // Sums past the largest doubles are no value, as their cells draw none.
    const value = sums[index.rowOf(index.positionAt(to - 1))]!;
    if (!Number.isFinite(value)) return;
    if (value < min) min = value;
    if (value > max) max = value;
  });
  return min <= max ? [min, max] : null;
}

/** The extent of the sums of a series' cells, as of its table version and positions. */
interface Sums {
  version: number;
  x: NumericArray;
  y: NumericArray;
  extent: readonly [number, number] | null;
}

interface ResolvedAxis {
  cells: AxisCells | undefined;
  ordinals: NumericArray;
  places: BandPlaces | undefined;
  count: number;
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

function sameInputs(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/**
 * How many chart bands an axis of `count` bands reaches, from the first:
 * past its last, which a panel's own categories place last.
 */
function lastBand(places: BandPlaces | undefined, count: number): number {
  return places && count > 0 ? places.band(count - 1) + 1 : count;
}

/**
 * A grid of colored cells: heatmaps and matrices.
 *
 * ```ts
 * heatmap(load, { x: "hour", y: "host", color: "cpu" })
 * ```
 */
export function heatmap<S extends Schema>(
  table: Table<S>,
  options: HeatmapOptions<S>,
): ChartMark<Frozen<HeatmapSpec>> {
  const shared = definedFields(options, [
    "tooltip",
    "label",
    "legend",
    "id",
    "facet",
    "panel",
    "clip",
    "colorMidpoint",
    "reduce",
  ]);
  let spec: HeatmapSpec;
  if (options.date !== undefined) {
    const { date, color } = options;
    spec = { type: "heatmap", date, color, ...shared };
    Object.assign(spec, definedFields(options, ["calendar", "weekStart"]));
  } else {
    const grid = options as HeatmapCommon<S> & GridOptions<S>;
    const placement = definedFields(grid, [
      "x",
      "y",
      "x1",
      "x2",
      "y1",
      "y2",
      "xStep",
      "yStep",
      "xBanded",
      "yBanded",
    ]);
    spec = {
      type: "heatmap",
      color: grid.color,
      ...shared,
      // Typed as the first form; the options' types allow only whole forms.
      ...(placement as { x: string; y: string }),
    };
  }
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [...options.colorDomain];
  if (options.sampling) spec.sampling = { ...options.sampling };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new HeatmapMark(spec, table as unknown as Table);
}
