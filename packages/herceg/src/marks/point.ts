import type { RowView } from "../data/row-view.ts";
import type { CategoryField, NumericField, PositionField, Schema, Table } from "../data/table.ts";
import { pointDrawing } from "../draw/point.ts";
import { CYCLE, SYMBOLS, type SymbolName, symbolPath, symbolReach } from "../draw/symbols.ts";
import { formatNumber } from "../format/format.ts";
import { GridIndex } from "../lod/grid-index.ts";
import type { Breaks } from "../lod/m4.ts";
import { insetDomain } from "../model/axis.ts";
import type { CategoryColors } from "../model/features.ts";
import type { LegendPart } from "../model/legend.ts";
import {
  checkColorScale,
  checkRamp,
  fraction,
  isOpaqueColor,
  rampOf,
  SequentialScale,
} from "../scale/color.ts";
import { linearTicks } from "../scale/ticks.ts";
import {
  CLOUD_POINTS,
  MOVING_POINTS,
  type PointCloud,
  type PointGeometry,
  type PointItems,
} from "../scene/scene.ts";
import type { Clip, Frozen, PointSpec } from "../spec/spec.ts";
import { surface, type Theme } from "../theme.ts";
import { Appearance, scaleKey } from "./appearance.ts";
import { BandShares, jitterOf, STILL } from "./dodge.ts";
import { legendParts } from "./legend-parts.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type BandContext,
  type BandList,
  type Bands,
  bandIndices,
  buildSeries,
  CATEGORY,
  type ChartMark,
  type ColorRamp,
  type Frame,
  fieldBands,
  frozen,
  type GlyphKey,
  type Hit,
  type MARK,
  type Mark,
  type MarkKey,
  type MarkSources,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
  type SummaryContext,
  seriesOf,
} from "./mark.ts";
import { placeAt, rowOf, type Series, valueAt, visibleRange, xExtent, yExtent } from "./series.ts";
import { offsetOf, Swarms } from "./swarm.ts";
import { checkTooltip, type MarkTooltip } from "./tooltip-fields.ts";
import { unionExtent } from "./trace.ts";

/**
 * A point's size: a constant `radius`, or a number field `size` sized by
 * area within `radiusRange` (bubbles); not both.
 */
export type PointSize<S extends Schema> =
  | {
      /** Radius in pixels; 2.5 by default. */
      radius?: number;
      size?: never;
      radiusRange?: never;
    }
  | {
      radius?: never;
      /** A number field sized by area within `radiusRange` (bubbles). */
      size?: NumericField<S>;
      /** Radii of the smallest and largest values of `size`. Default [2, 12]. */
      radiusRange?: readonly [number, number];
    };

export type PointOptions<S extends Schema> = PointStyle<S> & PointSize<S>;

interface PointStyle<S extends Schema> {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /**
   * What the mark's drawing is cut to: "plot", "chart", or false for
   * nothing, so markers at the plot's edge show whole. Without it, data is
   * cut to the plot and labels are drawn whole.
   */
  clip?: Clip;
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  /** A number or time field, or a category field placing points in its bands (strip plots). */
  x: PositionField<S>;
  /** Like `x`: categories run top to bottom. */
  y: PositionField<S>;
  /**
   * Category field: one colored point series per value; by default the
   * category `color` field, and `false` for none (points colored each by
   * their row's `color`).
   */
  series?: CategoryField<S> | false;
  /** A number, time, or category field matching points across data resets when the chart animates values. */
  animationKey?: PositionField<S>;
  fill?: string;
  /** Opacity from 0 to 1, or a number field mapped from 0.15 to 1. */
  fillOpacity?: number | NumericField<S>;
  /** Outline color of every point; the chart's background with only `strokeWidth`. */
  stroke?: string;
  /** Outline width in pixels: 1 with only `stroke`, none by default. */
  strokeWidth?: number;
  /**
   * A number or time field colored on a continuous scale, with a color
   * legend; or a category field whose values take the theme's palette in
   * order of appearance, with a key of them (the `series` field, named here,
   * keeps its series' colors).
   */
  color?: PositionField<S>;
  /**
   * Colors for a number or time `color`, low to high, such as an imported
   * scheme (`viridis`, `rdbu`, ...). Defaults to the theme's sequential
   * ramp, or its diverging one with a midpoint.
   */
  colors?: readonly string[];
  /** The values at the ends of the color ramp; the field's extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging ramps. */
  colorMidpoint?: number;
  /**
   * A shape's name, or a category field with a shape per value: its name,
   * or `{ field }`, which a field named like a shape needs. Default "circle".
   */
  symbol?: SymbolName | CategoryField<S> | { field: CategoryField<S> };
  /**
   * "pixel": draw opaque points whose centers share a device pixel once.
   * Faster for dense scatters; edges can differ by a fraction of a pixel.
   */
  sampling?: "none" | "pixel";
  /**
   * With a `series` field and a category `x` or `y`: place the series side
   * by side in each band, as grouped bars are, instead of at its center.
   */
  dodge?: boolean;
  /**
   * With a category `x` or `y`: spread points across their band (or, with
   * `dodge`, their series' share of it) over `width`, a fraction of it, by a
   * hash of each row and `seed`, so points stay put as data streams.
   */
  jitter?: { width: number; seed?: number };
  /**
   * With a category `x` or `y`: pack points across their band (or, with
   * `dodge`, their series' share of it) without overlap, in order of their
   * values, as a beeswarm; points that do not fit stand at its edges. It
   * is laid out again as the chart resizes and zooms.
   */
  swarm?: boolean;
  label?: string;
  /** `false` leaves the mark out of the chart's legends. */
  legend?: false;
  /** Fields of the row tooltips show besides the mark's values, such as counts that are not plotted. */
  tooltip?: MarkTooltip<S>;
  id?: string;
}

const DEFAULT_RADIUS = 2.5;
const RADIUS_RANGE: readonly [number, number] = [2, 12];
/** Opacity of a field's smallest value; its largest is opaque. */
const MIN_OPACITY = 0.15;
const NO_COORDS = new Float32Array(0);
const POSITION: readonly ["number", "time", "category"] = ["number", "time", "category"];
/** The shape or color of rows without a category value (see Appearance). */
const NONE = -1;
/** Legend shapes: circles of this radius, other shapes reaching at most LEGEND_REACH. */
const LEGEND_RADIUS = 4.5;
const LEGEND_REACH = 6;

/** How a point's radius, color, opacity, and shape follow fields, for one frame. */
interface Encoding {
  radius?: (value: number) => number;
  /** A number or time `color`'s scale. */
  color?: SequentialScale;
  /** A category `color`'s codes, and each code's index into `palette` (NONE without rows). */
  categories?: { codes: Int32Array; tones: Int32Array };
  palette?: readonly string[];
  opacity?: (value: number) => number;
}

/** Stream identities of clouds by table, x field, and y field, shared by every chart drawing them. */
const streamKeys = new WeakMap<Table, Map<string, Map<string, object>>>();

export class PointMark implements Mark<Frozen<PointSpec>> {
  declare readonly [MARK]: true;
  readonly insetDomain = insetDomain;
  readonly spec: Frozen<PointSpec>;
  readonly table: Table<Schema>;
  readonly identity: MarkSources;
  readonly view: RowView | undefined;
  readonly tooltip = "point";
  /** A category `color` colors points through the chart's color scale (see model/features.ts). */
  readonly featured: boolean = false;
  readonly inset: { x: number; y: number };
  readonly #split: SeriesSplitter;
  /** Which positions are categories: each row's band index places it. */
  readonly #banded: { readonly x: boolean; readonly y: boolean };
  /** Pick indexes per frame (charts sharing this mark have separate frames), per series key. */
  readonly #indexes = new WeakMap<Frame, Map<string, GridIndex>>();
  /** Fields encoding size, opacity, color, and shape, when the options name fields. */
  readonly #sizeField: string | undefined;
  readonly #opacityField: string | undefined;
  readonly #symbolField: string | undefined;
  /** A number or time `color`, colored on a continuous scale. */
  readonly #toneField: string | undefined;
  /** A category `color` other than the series field, its values' colors through the chart's color scale. */
  readonly #colorField: string | undefined;
  /** A category symbol field's values in order of appearance, which take the shapes in turn. */
  readonly #shapes: Appearance | undefined;
  /** The shape of every point when no field gives one. */
  readonly #symbol: SymbolName;
  /** The radius of every point, or with a `size` field the largest. */
  readonly #radius: number;
  /** Outline width in pixels; 0 for none. */
  readonly #ringWidth: number;
  /** How far each of SYMBOLS reaches per unit of radius. */
  readonly #reaches = SYMBOLS.map(symbolReach);
  /** The field splitting series: `series`, or a category `color` field (see `seriesOf`). */
  readonly #series: string | undefined;
  /** The banded axis points spread along (dodge, jitter, swarm), and their series' shares of its bands. */
  readonly #spread: { axis: "x" | "y"; shares: BandShares } | undefined;
  /** With `swarm`, the layout of each panel's swarms. */
  readonly #swarms: Swarms | undefined;

  constructor(input: PointSpec, table: Table<Schema>, view?: RowView) {
    this.spec = frozen(input);
    checkTooltip(table, this.spec.tooltip, "point");
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    if (view && view.source !== table)
      throw new Error("point: the view must be of the mark's table");
    this.view = view;
    requireField(table, spec.x, POSITION, "point x");
    requireField(table, spec.y, POSITION, "point y");
    if (typeof spec.series === "string") requireField(table, spec.series, CATEGORY, "point series");
    // A category color names the series, as on lines and bars.
    const series = seriesOf(spec, table, "fill");
    this.#series = series;
    if (spec.animationKey !== undefined)
      requireField(table, spec.animationKey, POSITION, "point animationKey");
    this.#banded = {
      x: table.kind(spec.x) === "category",
      y: table.kind(spec.y) === "category",
    };
    const { dodge, jitter, swarm } = spec;
    if (swarm !== undefined && typeof swarm !== "boolean")
      throw new TypeError(`point swarm: expected true or false; received ${JSON.stringify(swarm)}`);
    if (swarm && jitter) throw new Error("point swarm: places points itself; drop jitter or swarm");
    if (swarm && spec.sampling === "pixel")
      throw new Error('point sampling: a swarm places every point; drop sampling: "pixel"');
    if (dodge || jitter || swarm) {
      const option = dodge ? "dodge" : jitter ? "jitter" : "swarm";
      if (this.#banded.x === this.#banded.y)
        throw new Error(`point ${option}: needs one category position, x or y`);
      if (dodge && series === undefined)
        throw new Error("point dodge: places series side by side; give a series field");
      if (jitter && !(jitter.width >= 0 && jitter.width <= 1))
        throw new RangeError(
          `point jitter.width: expected a number from 0 to 1; received ${jitter.width}`,
        );
      if (jitter?.seed !== undefined && !Number.isInteger(jitter.seed))
        throw new RangeError(`point jitter.seed: expected a whole number; received ${jitter.seed}`);
      this.#spread = { axis: this.#banded.x ? "x" : "y", shares: new BandShares() };
      if (swarm) this.#swarms = new Swarms();
    }
    // Points in bands are in no x order.
    const xField = this.#banded.x ? undefined : spec.x;
    this.#split = new SeriesSplitter(table, xField, [spec.y], series, spec.label, view);
    this.identity = { field: series, values: [spec.y] };
    if (spec.radius !== undefined && spec.size !== undefined)
      throw new Error("point radius: a constant radius or a size field, not both; drop one");
    if (spec.size !== undefined) requireField(table, spec.size, NUMERIC, "point size");
    if (typeof spec.fillOpacity === "string")
      requireField(table, spec.fillOpacity, NUMERIC, "point fillOpacity");
    if (spec.color !== undefined) {
      requireField(table, spec.color, POSITION, "point color");
      if (table.kind(spec.color) !== "category") this.#toneField = spec.color;
      else if (
        spec.colors !== undefined ||
        spec.colorDomain !== undefined ||
        spec.colorMidpoint !== undefined
      )
        throw new Error(
          `point colors: "${spec.color}" is a category field, colored by the theme's palette; drop colors, colorDomain, and colorMidpoint`,
        );
      // Colored by the series field, points keep their series' colors, which
      // the chart's color scale gives them; other fields color each point.
      else {
        this.featured = true;
        if (spec.color !== series) this.#colorField = spec.color;
      }
    }
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "point colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "point");
    if (spec.radius !== undefined && !(spec.radius > 0 && Number.isFinite(spec.radius)))
      throw new RangeError(
        `point radius: expected a positive number of pixels; received ${spec.radius}`,
      );
    if (typeof spec.fillOpacity === "number" && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(
        `point fillOpacity: expected a number from 0 to 1 or a field; received ${spec.fillOpacity}`,
      );
    const range = spec.radiusRange ?? RADIUS_RANGE;
    if (!(range[0] >= 0 && range[1] > range[0] && Number.isFinite(range[1])))
      throw new RangeError(
        `point radiusRange: expected two finite radii, ascending; received [${range}]`,
      );
    this.#sizeField = spec.size;
    this.#opacityField = typeof spec.fillOpacity === "string" ? spec.fillOpacity : undefined;
    // `{ field }` names a field; a shape's name draws that shape, and any
    // other name is a field. A name that is both would leave the choice to
    // the table's columns, so it is refused.
    const symbol = spec.symbol;
    const named = typeof symbol === "object" ? undefined : symbol;
    const shape = named === undefined ? undefined : SYMBOLS.find((s) => s === named);
    if (shape !== undefined && table.has(shape)) {
      throw new Error(
        `point symbol: "${shape}" names both a shape and a field; give { field: "${shape}" } to encode the field`,
      );
    }
    const field =
      typeof symbol === "object" ? symbol.field : shape === undefined ? named : undefined;
    if (field === undefined) {
      this.#symbol = shape ?? "circle";
    } else {
      if (!table.has(field)) {
        throw new RangeError(
          `point symbol: no shape or field "${field}"; name a category field or one of ${SYMBOLS.map((s) => `"${s}"`).join(", ")}`,
        );
      }
      requireField(table, field, CATEGORY, "point symbol");
      this.#symbolField = field;
      this.#shapes = new Appearance(field);
      this.#symbol = "circle";
    }
    const radius = this.#sizeField !== undefined ? range[1] : (spec.radius ?? DEFAULT_RADIUS);
    // Pointed shapes reach past the radius of a circle of the same area.
    const reach =
      this.#symbolField !== undefined
        ? Math.max(...this.#reaches)
        : this.#reaches[SYMBOLS.indexOf(this.#symbol)]!;
    this.#radius = radius;
    if (
      spec.strokeWidth !== undefined &&
      !(spec.strokeWidth >= 0 && Number.isFinite(spec.strokeWidth))
    )
      throw new RangeError(
        `point strokeWidth: expected 0 or more pixels; received ${spec.strokeWidth}`,
      );
    this.#ringWidth = spec.strokeWidth ?? (spec.stroke !== undefined ? 1 : 0);
    // Outlines reach half their width past the shape.
    const outline = this.#ringWidth / 2;
    this.inset = { x: radius * reach + outline, y: radius * reach + outline };
  }

  channelKind(axis: "x" | "y") {
    return this.table.kind(axis === "x" ? this.spec.x : this.spec.y);
  }

  bands(axis: "x" | "y", context: BandContext): BandList | undefined {
    return this.#banded[axis] ? fieldBands(this.table, this.spec[axis], context) : undefined;
  }

  series(
    key: MarkKey,
    palette: Palette,
    _hidden: ReadonlySet<string>,
    bands: Bands,
    context: BandContext,
  ) {
    const { spec, table } = this;
    // A category position is each row's band index on the chart's axis.
    const banded = (axis: "x" | "y") =>
      bandIndices(table, spec[axis], bands[axis]?.keys ?? [], context);
    return buildSeries(
      table,
      this.#split.sources(),
      this.#banded.x ? banded("x") : table.numbers(spec.x as never),
      key,
      palette,
      spec.fill,
      this.#banded.y ? banded("y") : undefined,
    );
  }

  xExtent(series: readonly Series[], log: boolean) {
    if (this.#banded.x) return undefined;
    return unionExtent(
      series.map((s) => (this.#banded.y ? bandedExtent(s, "x", log) : xExtent(s, log))),
    );
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    if (this.#banded.y) return undefined;
    // A category x axis shows all its bands.
    if (this.#banded.x) return unionExtent(series.map((s) => bandedExtent(s, "y", log)));
    return unionExtent(series.map((s) => yExtent(s, x0, x1, s.y, log, undefined, false, breaks)));
  }

  geometry(series: readonly Series[], frame: Frame): PointGeometry[] {
    const encoding = this.#encoding(frame.theme, categoriesOf(series));
    // With no color value at all, no point has the value it encodes.
    if (this.#toneField !== undefined && !encoding.color) return [];
    const radius = this.#radius;
    const reachOf = this.#reaches;
    const fixedReach = reachOf[SYMBOLS.indexOf(this.#symbol)]!;
    const opacity = typeof this.spec.fillOpacity === "number" ? this.spec.fillOpacity : 1;
    // Points of one size, color, opacity, and circle shape can take the fast paths.
    const encoded =
      encoding.radius !== undefined ||
      encoding.palette !== undefined ||
      encoding.opacity !== undefined ||
      this.#symbolField !== undefined ||
      this.#symbol !== "circle";
    const { plot, pixelRatio } = frame;
    const out: PointGeometry[] = [];
    const columns = Math.ceil(plot.width * pixelRatio) + 1;
    const rows = Math.ceil(plot.height * pixelRatio) + 1;
    const read = (field: string | undefined) =>
      field === undefined ? undefined : this.table.numbers(field as never);
    const sizes = read(this.#sizeField);
    const tones = read(this.#toneField);
    const categories = encoding.categories;
    const alphas = read(this.#opacityField);
    const codes =
      this.#symbolField !== undefined
        ? this.table.categories(this.#symbolField as never).codes
        : undefined;
    const shapeOf = codes && this.#shapesByCode();
    // Outlined points are drawn one by one, each outline over its point, on the CPU.
    const ring =
      this.#ringWidth > 0
        ? { color: this.spec.stroke ?? surface(frame.theme), width: this.#ringWidth }
        : undefined;
    const keyField = frame.keyed ? this.spec.animationKey : undefined;
    const keyKind = keyField === undefined ? undefined : this.table.kind(keyField);
    const keyLabels = keyKind === "category" ? this.table.categories(keyField as never) : undefined;
    const keyNumbers = keyLabels ? undefined : read(keyField);
    this.#spread?.shares.split(series, frame, Boolean(this.spec.dodge));
    // Swarms are laid out for the panel's scales before any point is placed.
    if (this.#swarms) {
      const radiusOf = this.#radiusScale();
      const values = this.table.numbers(
        (this.#spread!.axis === "x" ? this.spec.y : this.spec.x) as never,
      );
      this.#swarms.offsets(
        series,
        frame,
        this.#spread!.axis,
        this.#spread!.shares,
        (row) => this.#reach(row, radiusOf),
        values,
        this.table.version,
      );
    }
    const placeRow = this.#placer();
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      const opaque =
        encoding.opacity === undefined &&
        opacity >= 1 &&
        (encoding.color !== undefined ||
          (categories ? encoding.palette!.every(isOpaqueColor) : isOpaqueColor(s.color)));
      // Device-pixel occupancy for sampling; only opaque plain points qualify,
      // since overlapping translucent or varied points look different from one.
      const sample = this.spec.sampling === "pixel" && opaque && !encoded;
      const [start, end] = this.#visible(s, frame);
      // The GPU maps linearly; points on an axis with breaks are placed here.
      const linear = frame.x.breaks === undefined;
      // The WebGL painter draws whole columns of numbers; a view's rows, and
      // points in bands (read through a panel's places), are drawn on the CPU.
      if (
        frame.clouds &&
        !this.view &&
        !this.#banded.x &&
        !this.#banded.y &&
        !ring &&
        !sample &&
        !encoded &&
        linear &&
        end - start >= CLOUD_POINTS
      ) {
        out.push({
          kind: "point",
          draw: pointDrawing,
          key: s.key,
          fill: s.color,
          fillOpacity: opacity,
          opaque,
          radius,
          symbol: "circle",
          coords: NO_COORDS,
          count: end - start,
          cloud: {
            x: s.x,
            y: s.y,
            rows: s.rows,
            start,
            end,
            xMap: frame.x.mapping(),
            yMap: frame.y.mapping(),
            version: this.table.version,
            stream: this.#stream(s),
          },
        });
        continue;
      }
      const length = end - start;
      const coords = frame.floats(s.key, "point", length * 2);
      const occupied = sample ? frame.bytes(s.key, "occupied", columns * rows) : undefined;
      occupied?.fill(0);
      const radii = sizes && frame.floats(s.key, "radius", length);
      const colorIndex = encoding.palette && frame.bytes(s.key, "color", length);
      const opacities = alphas && frame.floats(s.key, "opacity", length);
      const symbols = codes && frame.bytes(s.key, "symbol", length);
      // Capture identity alongside positions; static and sampled charts keep none.
      let items: PointItems | undefined;
      if (frame.keyed && !sample && length <= MOVING_POINTS) {
        const identity = { table: this.table, generation: this.table.generation };
        if (keyLabels) {
          items = { ...identity, ids: [], key: { field: keyField!, kind: "category" } };
        } else {
          const ids = frame.doubles(s.key, "id", length);
          items =
            keyField === undefined
              ? { ...identity, ids }
              : { ...identity, ids, key: { field: keyField, kind: keyKind as "number" | "time" } };
        }
      }
      let count = 0;
      for (let k = start; k < end; k++) {
        const row = rowOf(s, k);
        // A point missing a value it encodes is not drawn.
        const r = sizes ? encoding.radius!(sizes[row]!) : radius;
        const tone = tones
          ? encoding.color!.index(tones[row]!)
          : categories
            ? (categories.tones[categories.codes[row]!] ?? NONE)
            : 0;
        const alpha = alphas ? encoding.opacity!(alphas[row]!) : opacity;
        const shape = codes ? (shapeOf![codes[row]!] ?? NONE) : 0;
        if (!(r > 0 && tone >= 0 && Number.isFinite(alpha) && shape >= 0)) continue;
        // Points whose shape reaches into the plot are drawn.
        const reach = r * (codes ? reachOf[shape]! : fixedReach) + this.#ringWidth / 2;
        const placed = placeRow(s, row, frame, reach);
        if (!placed) continue;
        const [px, py] = placed;
        if (occupied) {
          const cell =
            Math.floor((py - plot.y) * pixelRatio) * columns +
            Math.floor((px - plot.x) * pixelRatio);
          if (cell >= 0 && cell < occupied.length) {
            if (occupied[cell]) continue;
            occupied[cell] = 1;
          }
        }
        coords[count * 2] = px;
        coords[count * 2 + 1] = py;
        if (radii) radii[count] = r;
        if (colorIndex) colorIndex[count] = tone;
        if (opacities) opacities[count] = alpha;
        if (symbols) symbols[count] = shape;
        if (items) {
          if (keyLabels) {
            (items.ids as (string | undefined)[])[count] =
              keyLabels.dictionary[keyLabels.codes[row]!];
          } else {
            (items.ids as Float64Array)[count] = keyNumbers
              ? keyNumbers[row]!
              : this.table.rowOffset + row;
          }
        }
        count++;
      }
      out.push({
        kind: "point",
        draw: pointDrawing,
        key: s.key,
        fill: s.color,
        fillOpacity: opacity,
        opaque,
        radius,
        symbol: this.#symbol,
        coords,
        count,
        radii,
        colors: colorIndex && {
          index: colorIndex,
          palette: encoding.palette!,
          ...(categories && { categorical: true }),
        },
        opacities,
        symbols,
        ring,
        items,
      });
    }
    return out;
  }

  /** How sizes, colors, and opacities follow their fields, with the current data. */
  #encoding(theme: Theme, categories: CategoryColors | undefined): Encoding {
    const { table } = this;
    const out: Encoding = {};
    const radius = this.#radiusScale();
    if (radius) out.radius = radius;
    if (this.#opacityField !== undefined) {
      const [lo, hi] = table.extent(this.#opacityField as never) ?? [0, 0];
      out.opacity = (value) => {
        if (!Number.isFinite(value)) return Number.NaN;
        return MIN_OPACITY + (1 - MIN_OPACITY) * fraction(value, lo, hi);
      };
    }
    const color = this.#colorScale(theme);
    if (color) {
      out.color = color;
      out.palette = this.#palette(color);
    }
    if (categories) {
      out.categories = { codes: categories.codes, tones: categories.tones };
      out.palette = categories.colors;
    }
    return out;
  }

  /**
   * Radius of a value of the `size` field: areas grow linearly within `radiusRange`
   * from zero, or from the least value when some are negative.
   */
  #radiusScale(): ((value: number) => number) | undefined {
    if (this.#sizeField === undefined) return undefined;
    const extent = this.table.extent(this.#sizeField as never);
    const [lo, hi] = extent ? (extent[0] >= 0 ? [0, extent[1]] : extent) : [0, 0];
    const [r0, r1] = this.spec.radiusRange ?? RADIUS_RANGE;
    return (value) => {
      if (!Number.isFinite(value)) return Number.NaN;
      const t = Math.min(1, Math.max(0, fraction(value, lo, hi)));
      return Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * t);
    };
  }

  /** The continuous color scale of a number or time `color` field, with the current data. */
  #colorScale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    if (this.#toneField === undefined) return undefined;
    const domain = spec.colorDomain ?? this.table.extent(this.#toneField as never);
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  /** The scale's colors, kept while the scale's ramp, domain, and midpoint are unchanged. */
  #palette(scale: SequentialScale): readonly string[] {
    const key = `${scale.stops.join()}|${scale.domain.join()}|${scale.midpoint}`;
    if (this.#palettes?.key !== key) this.#palettes = { key, colors: scale.colors() };
    return this.#palettes.colors;
  }

  #palettes: { key: string; colors: readonly string[] } | undefined;

  /** A color legend for a `color` field, and keys of sizes and shapes encoded by field. */
  legends(
    series: readonly Series[],
    theme: Theme,
    format: (value: number) => string,
  ): LegendPart[] {
    const scale = series.length > 0 ? this.#colorScale(theme) : undefined;
    const ramps: ColorRamp[] = scale
      ? [
          {
            stops: scale.legendStops(),
            domain: scale.domain,
            midpoint: scale.midpoint,
            title: this.spec.color!,
          },
        ]
      : [];
    return legendParts(ramps, this.#glyphKeys(series, format));
  }

  /**
   * Point series show their symbol; with a color field coloring points, in a
   * neutral color. An outline in a color of its own shows too, so hollow
   * points have a swatch; one in the background color only keeps points apart.
   */
  legendEntry(s: Series, theme: Theme): { color: string; glyph: string; stroke?: string } {
    const entry = {
      color: this.#toneField === undefined && !this.#colorField ? s.color : theme.muted,
      glyph: legendGlyph(this.#legendSymbol(s)).glyph,
    };
    const stroke = this.spec.stroke;
    return stroke !== undefined && this.#ringWidth > 0 ? { ...entry, stroke } : entry;
  }

  /** A series' shape: its own when the symbol field also splits series, else a circle. */
  #legendSymbol(s: Series): SymbolName {
    const field = this.#symbolField;
    if (field === undefined) return this.#symbol;
    if (field !== this.#series) return "circle";
    const shapes = this.#shapes!;
    shapes.places(this.table);
    return SYMBOLS[(shapes.of(s.label) ?? 0) % CYCLE]!;
  }

  /**
   * A key of sizes (three round values of the `size` field), of shapes (each
   * value of a symbol field that does not also split series), and of colors
   * (each value of a category `color`).
   */
  #glyphKeys(series: readonly Series[], format: (value: number) => string): GlyphKey[] {
    if (series.length === 0) return [];
    const out: GlyphKey[] = [];
    const radius = this.#radiusScale();
    const extent = this.#sizeField !== undefined && this.table.extent(this.#sizeField as never);
    if (radius && extent) {
      // Round values nearest a quarter, half, and all of the way from the
      // smallest size's value (zero, or the least) to the largest's.
      const [lo, hi] = extent[0] >= 0 ? [0, extent[1]] : extent;
      const ticks = linearTicks(extent[0], extent[1], 5).filter((v) => !(lo === 0 && v === 0));
      const nearest = (target: number) =>
        ticks.reduce(
          (a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a),
          ticks.at(-1) ?? extent[1],
        );
      const values = [...new Set([0.25, 0.5, 1].map((f) => nearest(lo + (hi - lo) * f)))];
      out.push({
        title: this.#sizeField!,
        channel: "size",
        entries: values.map((value) => {
          const r = radius(value);
          return { label: format(value), glyph: symbolPath("circle", 0, 0, r), r };
        }),
      });
    }
    const field = this.#symbolField;
    if (field !== undefined && field !== this.#series) {
      const { dictionary } = this.table.categories(field as never);
      const shapeOf = this.#shapesByCode();
      out.push({
        title: field,
        channel: "shape",
        // The values in the table now, in order of appearance.
        entries: this.#shapes!.order(this.table).map((code) => {
          const shape = SYMBOLS[shapeOf[code]!]!;
          const { glyph, reach } = legendGlyph(shape);
          return { label: dictionary[code]!, glyph, r: reach, shape };
        }),
      });
    }
    const categories = this.#colorField !== undefined ? categoriesOf(series) : undefined;
    if (categories) out.push(scaleKey(categories));
    return out;
  }

  /** The shape (an index into SYMBOLS) of each code of the symbol field; -1 for none. */
  #shapesByCode(): Int32Array {
    return this.#shapes!.tones(this.table, CYCLE);
  }

  /** The stream identity of a series of whole columns, for GPU uploads that follow appends. */
  #stream(s: Series): PointCloud["stream"] {
    const { table } = this;
    const x = this.spec.x as string;
    // A series' rows grouped from the table stream as their group does.
    if (s.rows !== undefined) {
      if (!s.stream || s.x !== table.numbers(x as never)) return undefined;
      return { key: s.stream.key, offset: s.stream.dropped, modified: table.modifiedVersion };
    }
    if (s.field === undefined) return undefined;
    if (s.x !== table.numbers(x as never) || s.y !== table.numbers(s.field as never))
      return undefined;
    let byX = streamKeys.get(table);
    if (!byX) {
      byX = new Map();
      streamKeys.set(table, byX);
    }
    let byY = byX.get(x);
    if (!byY) {
      byY = new Map();
      byX.set(x, byY);
    }
    let key = byY.get(s.field);
    if (!key) {
      key = {};
      byY.set(s.field, key);
    }
    return { key, offset: table.rowOffset, modified: table.modifiedVersion };
  }

  /**
   * The y value (or category) and the values of the fields encoded as size,
   * color, opacity, and shape.
   */
  pointText(s: Series, row: number, format: AxisFormat): string {
    let text = format.y(valueAt(s, row));
    for (const field of [this.#sizeField, this.#toneField, this.#opacityField]) {
      if (field === undefined) continue;
      text += `, ${field} ${format.value(this.table.numbers(field as never)[row]!)}`;
    }
    const symbols = this.#symbolField !== this.#series ? this.#symbolField : undefined;
    for (const field of [this.#colorField, symbols]) {
      if (field === undefined) continue;
      const { codes, dictionary } = this.table.categories(field as never);
      text += `, ${field} ${dictionary[codes[row]!] ?? ""}`;
    }
    return text;
  }

  /** The color a row's point is drawn in: its series', or from the `color` field. */
  pointColor(s: Series, row: number, theme: Theme): string {
    const categories = this.#colorField !== undefined ? s.features?.categories : undefined;
    if (categories) {
      const tone = categories.tones[categories.codes[row]!] ?? NONE;
      return tone < 0 ? s.color : categories.colors[tone]!;
    }
    if (this.#toneField === undefined) return s.color;
    return (
      this.#colorScale(theme)?.color(this.table.numbers(this.#toneField as never)[row]!) ?? s.color
    );
  }

  /** How far a row's point reaches from its center, in pixels; NaN when it is not drawn. */
  reach(row: number): number {
    return this.#reach(row, this.#radiusScale());
  }

  /** Whether a row is drawn: rows missing a value they encode, or sized to nothing, are not. */
  shows(_s: Series, row: number): boolean {
    return this.#reach(row, this.#radiusScale()) > 0;
  }

  #drawn(row: number): boolean {
    const finite = (field: string | undefined) =>
      field === undefined || Number.isFinite(this.table.numbers(field as never)[row]);
    const held = (field: string | undefined) =>
      field === undefined || this.table.categories(field as never).codes[row]! >= 0;
    return (
      finite(this.#sizeField) &&
      finite(this.#toneField) &&
      finite(this.#opacityField) &&
      held(this.#symbolField) &&
      held(this.#colorField)
    );
  }

  /**
   * How many points are drawn and over what values: on category y, in how
   * many categories and over what x. Rows without a category, a position, or
   * a value they encode are not drawn, so not counted; points on numeric axes
   * that encode no field take the chart's sentence.
   */
  summarize(
    parts: readonly Series[],
    name: string,
    { format, bands, locale }: SummaryContext,
  ): string | undefined {
    const { x: bandX, y: bandY } = this.#banded;
    // Points of no encoded field are drawn wherever they are placed.
    const encodes = [
      this.#sizeField,
      this.#toneField,
      this.#colorField,
      this.#opacityField,
      this.#symbolField,
    ].some((field) => field !== undefined);
    if (!bandX && !bandY && !encodes) return undefined;
    const radiusOf = this.#radiusScale();
    // Parts hold the chart's band indices, which panels may place apart.
    const used = new Uint8Array(bandY ? (bands.y?.keys.length ?? 0) : 0);
    let [points, categories, low, high] = [0, 0, Infinity, -Infinity];
    // The last value is a part's last drawn point (a view's rows may run in
    // any order), of the part whose last point is the table's latest row.
    let [last, lastRow] = [Number.NaN, -1];
    for (const s of parts) {
      let [partLast, partRow] = [Number.NaN, -1];
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        const x = s.x[row]!;
        const y = s.y[row]!;
        const placed =
          (bandX ? x >= 0 : Number.isFinite(x)) && (bandY ? y >= 0 : Number.isFinite(y));
        if (!placed || (encodes && !(this.#reach(row, radiusOf) > 0))) continue;
        points++;
        if (bandY && !used[y]) {
          used[y] = 1;
          categories++;
        }
        // The value along the axis of values: y, or x along category y.
        const value = bandY ? x : y;
        if (value < low) low = value;
        if (value > high) high = value;
        partLast = value;
        partRow = row;
      }
      if (partRow > lastRow) [last, lastRow] = [partLast, partRow];
    }
    if (points === 0) return `${name}: no data`;
    const count = `${points} point${points === 1 ? "" : "s"}`;
    // Numbers read as the chart's sentence reads them; along category x, as tooltips do.
    const value = bandX ? format.value : (v: number) => formatNumber(v, locale);
    if (!bandY)
      return `${name}: ${count}, from ${value(low)} to ${value(high)}, last ${value(last)}`;
    const among = `${count} in ${categories} ${categories === 1 ? "category" : "categories"}`;
    return bandX
      ? `${name}: ${among}`
      : `${name}: ${among}, x from ${format.x(low)} to ${format.x(high)}`;
  }

  /** Rows of a series in the x domain, widened by how far points reach past it; all on category x. */
  #visible(s: Series, frame: Frame): [number, number] {
    if (this.#banded.x) return [0, s.length];
    const { plot, x } = frame;
    const reach = this.inset.x;
    return visibleRange(s, x.invert(plot.x - reach), x.invert(plot.x + plot.width + reach));
  }

  /** How far a row's point and outline reach from its center, in pixels; NaN when it is not drawn. */
  #reach(row: number, radiusOf: ((value: number) => number) | undefined): number {
    if (!this.#drawn(row)) return Number.NaN;
    const r = radiusOf
      ? radiusOf(this.table.numbers(this.#sizeField as never)[row]!)
      : this.#radius;
    const shape =
      this.#symbolField !== undefined
        ? this.#shapesByCode()[this.table.categories(this.#symbolField as never).codes[row]!]!
        : SYMBOLS.indexOf(this.#symbol);
    return r > 0 ? r * this.#reaches[shape]! + this.#ringWidth / 2 : Number.NaN;
  }

  /** Where a row is drawn, from where its values place it: spread across its band. */
  displace(s: Series, row: number, frame: Frame): readonly [number, number] {
    const spread = this.#spread;
    if (!spread) return STILL;
    const shift = this.#shift(s, row, frame);
    return spread.axis === "x" ? [shift, 0] : [0, shift];
  }

  /** Rows spread within their bands: at most half a band off their places. */
  maxDisplacement(_s: Series, frame: Frame): number {
    return this.#spread?.axis === "x" ? Math.abs(frame.x.bandwidth ?? 0) / 2 : 0;
  }

  /** How rows are placed in pixels: through their bands' places, spread as `dodge` and `jitter` say. */
  #placer(): Place {
    if (!this.#banded.x && !this.#banded.y) return place;
    const spread = this.#spread;
    if (!spread) return placeBanded;
    const along = spread.axis === "x" ? 0 : 1;
    return (s, row, frame, reach) => {
      const placed = placeBanded(s, row, frame, reach);
      if (placed) placed[along] += this.#shift(s, row, frame);
      return placed;
    };
  }

  /** How far a row stands from its band's center along the banded axis, in pixels. */
  #shift(s: Series, row: number, frame: Frame): number {
    const spread = this.#spread!;
    const band = spread.axis === "x" ? frame.x : frame.y;
    const { center, width } = spread.shares.of(s, band.bandwidth ?? 0);
    // A swarm's offsets are its panel's last layout, which geometry made.
    if (this.#swarms) {
      const layout = this.#swarms.last(frame);
      return center + (layout ? offsetOf(layout, row) : 0);
    }
    const jitter = this.spec.jitter;
    if (!jitter) return center;
    const unit = jitterOf(this.table.rowOffset + row, jitter.seed ?? 0);
    return center + (unit - 0.5) * jitter.width * width;
  }

  /**
   * Nearest drawn point to a pixel position, through a grid index per series.
   * The index covers every visible point (not only those kept by sampling),
   * so the tooltip reports a real row.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    let indexes = this.#indexes.get(frame);
    if (!indexes) {
      indexes = new Map();
      this.#indexes.set(frame, indexes);
    }
    let best: Hit | undefined;
    const radiusOf = this.#radiusScale();
    const placeRow = this.#placer();
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      let index = indexes.get(s.key);
      if (!index) {
        index = buildIndex(s, frame, this.#visible(s, frame), placeRow, (row) =>
          this.#reach(row, radiusOf),
        );
        indexes.set(s.key, index);
      }
      const found = index.nearest(px, py, best?.distance ?? Infinity);
      if (found && found.distance < (best?.distance ?? Infinity))
        best = { series: s, position: found.id, distance: found.distance };
    }
    return best;
  }
}

/**
 * Pixel position of a point at `x` and `y`, or undefined when it is not
 * drawn: missing, or farther outside the plot than points reach.
 */
function pixelOf(x: number, y: number, frame: Frame, reach: number): [number, number] | undefined {
  // Points inside an axis break are not drawn.
  if (frame.x.breaks?.hides(x)) return undefined;
  const px = frame.x.map(x);
  const py = frame.y.map(y);
  if (!(Number.isFinite(px) && Number.isFinite(py))) return undefined;
  const { plot } = frame;
  if (px < plot.x - reach || px > plot.x + plot.width + reach) return undefined;
  if (py < plot.y - reach || py > plot.y + plot.height + reach) return undefined;
  return [px, py];
}

/**
 * How a row of a series is placed: `place` at its x and y, or `placeBanded`
 * for points in bands. Declared functions, not constants: calls through a
 * constant cost dense scatters about a twentieth of their scene.
 */
type Place = typeof place;

function place(s: Series, row: number, frame: Frame, reach: number): [number, number] | undefined {
  return pixelOf(s.x[row]!, s.y[row]!, frame, reach);
}

/** Categories are read at their panel's places; a band index of -1 is a missing one. */
function placeBanded(
  s: Series,
  row: number,
  frame: Frame,
  reach: number,
): [number, number] | undefined {
  const x = placeAt(s, "x", row);
  const y = placeAt(s, "y", row);
  if ((x < 0 && frame.x.type === "band") || (y < 0 && frame.y.type === "band")) return undefined;
  return pixelOf(x, y, frame, reach);
}

/**
 * [min, max] of a series' `axis` values (with `log`, positive ones) at rows
 * with a category on the other axis: rows without one are not drawn.
 */
function bandedExtent(s: Series, axis: "x" | "y", log: boolean): [number, number] | undefined {
  const [values, bands] = axis === "x" ? [s.x, s.y] : [s.y, s.x];
  let min = Infinity;
  let max = -Infinity;
  for (let k = 0; k < s.length; k++) {
    const row = rowOf(s, k);
    const value = values[row]!;
    if (bands[row]! < 0 || !Number.isFinite(value) || (log && value <= 0)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return min <= max ? [min, max] : undefined;
}

/** A grid index of the rows in [start, end) whose points reach into the plot. */
function buildIndex(
  s: Series,
  frame: Frame,
  [start, end]: [number, number],
  placeRow: Place,
  reachOf: (row: number) => number,
): GridIndex {
  const coords = new Float32Array((end - start) * 2);
  const ids = new Uint32Array(end - start);
  let count = 0;
  for (let k = start; k < end; k++) {
    const row = rowOf(s, k);
    const reach = reachOf(row);
    const placed = reach >= 0 ? placeRow(s, row, frame, reach) : undefined;
    if (!placed) continue;
    coords[count * 2] = placed[0];
    coords[count * 2 + 1] = placed[1];
    ids[count] = k;
    count++;
  }
  return new GridIndex(coords, ids, count, frame.plot);
}

/**
 * Points at (x, y): scatter plots.
 *
 * ```ts
 * point(cars, { x: "weight", y: "mpg", series: "origin" })
 * ```
 */
/**
 * Points at x and y. Over a `RowView`, the points of the view's rows only,
 * read from its table without a copy, and following the view as it changes.
 */
export function point<S extends Schema>(
  data: Table<S> | RowView<S>,
  options: PointOptions<S>,
): ChartMark<Frozen<PointSpec>> {
  const view = isRowView(data) ? data : undefined;
  const table = view ? view.source : (data as Table<S>);
  // A radius or a size, as the options' types allow; the mark refuses both from others.
  const spec = {
    type: "point",
    x: options.x,
    y: options.y,
    ...definedFields(options, [
      "tooltip",
      "series",
      "animationKey",
      "radius",
      "size",
      "fill",
      "fillOpacity",
      "stroke",
      "strokeWidth",
      "color",
      "colorMidpoint",
      "sampling",
      "dodge",
      "swarm",
      "label",
      "legend",
      "id",
      "axis",
      "facet",
      "panel",
      "clip",
    ]),
    ...(options.radiusRange && {
      radiusRange: [options.radiusRange[0], options.radiusRange[1]] as const,
    }),
  } as unknown as PointSpec;
  // Specs name symbol fields as { field }, so a reader never mistakes one for a shape.
  const { symbol } = options;
  if (typeof symbol === "object") spec.symbol = { field: symbol.field };
  else if (symbol !== undefined)
    spec.symbol = SYMBOLS.includes(symbol as SymbolName) ? symbol : { field: symbol };
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
  if (options.jitter) spec.jitter = { ...options.jitter };
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new PointMark(spec, table as unknown as Table, view as unknown as RowView | undefined);
}

/**
 * Whether marks' data is a row view rather than a table, told apart by
 * shape so that charts without views do not bundle the view code.
 */
export function isRowView<S extends Schema>(data: Table<S> | RowView<S>): data is RowView<S> {
  return "source" in data && typeof (data as RowView<S>).read === "function";
}

/** A shape for legends, about as large as the 10-pixel swatch, and how far it reaches. */
function legendGlyph(symbol: SymbolName): { glyph: string; reach: number } {
  const reach = symbolReach(symbol);
  const r = Math.min(LEGEND_RADIUS, LEGEND_REACH / reach);
  return { glyph: symbolPath(symbol, 0, 0, r), reach: r * reach };
}

/** Points' category colors, which every series of the mark shares (see the feature compiler). */
function categoriesOf(series: readonly Series[]): CategoryColors | undefined {
  return series[0]?.features?.categories;
}
