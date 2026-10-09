import type { RowView } from "../data/row-view.ts";
import type { CategoryField, NumericField, Schema, Table } from "../data/table.ts";
import { pointDrawing } from "../draw/point.ts";
import { SYMBOLS, type SymbolName, symbolPath, symbolReach } from "../draw/symbols.ts";
import { GridIndex } from "../lod/grid-index.ts";
import type { Breaks } from "../lod/m4.ts";
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
import { CLOUD_POINTS, type PointCloud, type PointGeometry } from "../scene/scene.ts";
import type { Frozen, PointSpec } from "../spec/spec.ts";
import { surface, type Theme } from "../theme.ts";
import { legendParts } from "./legend-parts.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  buildSeries,
  CATEGORY,
  type ChartMark,
  type ColorRamp,
  type Frame,
  frozen,
  type GlyphKey,
  type Hit,
  type MARK,
  type Mark,
  type MarkKey,
  NUMERIC,
  type Palette,
  requireField,
  SeriesSplitter,
} from "./mark.ts";
import { rowOf, type Series, visibleRange, xExtent, yExtent } from "./series.ts";
import { unionExtent } from "./trace.ts";

export interface PointOptions<S extends Schema> {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  x: NumericField<S>;
  y: NumericField<S>;
  /** Category field: one colored point series per value. */
  series?: CategoryField<S>;
  /** Radius in pixels, or a number field sized by area within `rRange` (bubbles). */
  r?: number | NumericField<S>;
  /** Radii of the smallest and largest values of an `r` field. Default [2, 12]. */
  rRange?: readonly [number, number];
  fill?: string;
  /** Opacity from 0 to 1, or a number field mapped from 0.15 to 1. */
  fillOpacity?: number | NumericField<S>;
  /** Outline color of every point; the chart's background with only `strokeWidth`. */
  stroke?: string;
  /** Outline width in pixels: 1 with only `stroke`, none by default. */
  strokeWidth?: number;
  /** A number field colored on a continuous scale, with a color legend. */
  color?: NumericField<S>;
  /**
   * Colors for `color`, low to high, such as an imported scheme (`viridis`,
   * `rdbu`, ...). Defaults to the theme's sequential ramp, or its diverging
   * one with a midpoint.
   */
  colors?: readonly string[];
  /** The values at the ends of the color ramp; the field's extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging ramps. */
  colorMidpoint?: number;
  /**
   * A shape's name, or a category field with a shape per value. Default
   * "circle". A field named like a shape must be renamed to be encoded.
   */
  symbol?: SymbolName | CategoryField<S>;
  /**
   * "pixel": draw opaque points whose centers share a device pixel once.
   * Faster for dense scatters; edges can differ by a fraction of a pixel.
   */
  sampling?: "none" | "pixel";
  label?: string;
  id?: string;
}

const DEFAULT_RADIUS = 2.5;
const R_RANGE: readonly [number, number] = [2, 12];
/** Opacity of a field's smallest value; its largest is opaque. */
const MIN_OPACITY = 0.15;
const NO_COORDS = new Float32Array(0);
/** The shape code of category values no row holds. */
const NO_SHAPE = 255;
/** Legend shapes: circles of this radius, other shapes reaching at most LEGEND_REACH. */
const LEGEND_RADIUS = 4.5;
const LEGEND_REACH = 6;

/** How a point's radius, color, opacity, and shape follow fields, for one frame. */
interface Encoding {
  radius?: (value: number) => number;
  color?: SequentialScale;
  palette?: readonly string[];
  opacity?: (value: number) => number;
}

/** Stream identities of clouds by table, x field, and y field, shared by every chart drawing them. */
const streamKeys = new WeakMap<Table, Map<string, Map<string, object>>>();

export class PointMark implements Mark<Frozen<PointSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<PointSpec>;
  readonly table: Table<Schema>;
  readonly view: RowView | undefined;
  readonly tooltip = "point";
  readonly inset: { x: number; y: number };
  readonly #split: SeriesSplitter;
  /** Pick indexes per frame (charts sharing this mark have separate frames), per series key. */
  readonly #indexes = new WeakMap<Frame, Map<string, GridIndex>>();
  /** Fields encoding size, opacity, color, and shape, when the options name fields. */
  readonly #rField: string | undefined;
  readonly #opacityField: string | undefined;
  readonly #symbolField: string | undefined;
  /** The shape of every point when no field gives one. */
  readonly #symbol: SymbolName;
  /** The radius of every point, or with an `r` field the largest. */
  readonly #radius: number;
  /** Outline width in pixels; 0 for none. */
  readonly #ringWidth: number;
  /** How far each of SYMBOLS reaches per unit of radius. */
  readonly #reaches = SYMBOLS.map(symbolReach);

  constructor(input: PointSpec, table: Table<Schema>, view?: RowView) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.table = table;
    if (view && view.source !== table) throw new Error("A point mark's view must be of its table");
    this.view = view;
    requireField(table, spec.x, NUMERIC, "point x");
    requireField(table, spec.y, NUMERIC, "point y");
    if (spec.series !== undefined) requireField(table, spec.series, CATEGORY, "point series");
    this.#split = new SeriesSplitter(table, spec.x, [spec.y], spec.series, spec.label, view);
    if (typeof spec.r === "string") requireField(table, spec.r, NUMERIC, "point r");
    if (typeof spec.fillOpacity === "string")
      requireField(table, spec.fillOpacity, NUMERIC, "point fillOpacity");
    if (spec.color !== undefined) requireField(table, spec.color, NUMERIC, "point color");
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "point colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "Point");
    if (typeof spec.r === "number" && !(spec.r > 0 && Number.isFinite(spec.r)))
      throw new RangeError(`Point r must be a positive radius or a field, not ${spec.r}`);
    if (typeof spec.fillOpacity === "number" && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(
        `Point fillOpacity must be from 0 to 1 or a field, not ${spec.fillOpacity}`,
      );
    const range = spec.rRange ?? R_RANGE;
    if (!(range[0] >= 0 && range[1] > range[0] && Number.isFinite(range[1])))
      throw new RangeError(`Point rRange must be two finite radii, ascending, not ${range}`);
    this.#rField = typeof spec.r === "string" ? spec.r : undefined;
    this.#opacityField = typeof spec.fillOpacity === "string" ? spec.fillOpacity : undefined;
    // A shape's name draws that shape and any other name is a category
    // field. A name that is both would leave the choice to the table's
    // columns, so it is refused.
    const symbol = spec.symbol;
    const shape = symbol === undefined || SYMBOLS.includes(symbol as SymbolName);
    if (shape && symbol !== undefined && table.has(symbol)) {
      throw new Error(
        `Point symbol "${symbol}" names both a shape and a field; rename the field to encode it`,
      );
    }
    if (shape) {
      this.#symbol = (symbol as SymbolName | undefined) ?? "circle";
    } else {
      if (!table.has(symbol)) {
        throw new RangeError(
          `Unknown symbol "${symbol}": use a category field or one of ${SYMBOLS.join(", ")}`,
        );
      }
      requireField(table, symbol, CATEGORY, "point symbol");
      this.#symbolField = symbol;
      this.#symbol = "circle";
    }
    const radius =
      this.#rField !== undefined ? range[1] : typeof spec.r === "number" ? spec.r : DEFAULT_RADIUS;
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
      throw new RangeError(`point strokeWidth must be 0 or more pixels, not ${spec.strokeWidth}`);
    this.#ringWidth = spec.strokeWidth ?? (spec.stroke !== undefined ? 1 : 0);
    // Outlines reach half their width past the shape.
    const outline = this.#ringWidth / 2;
    this.inset = { x: radius * reach + outline, y: radius * reach + outline };
  }

  channelKind(axis: "x" | "y") {
    return this.table.kind(axis === "x" ? this.spec.x : this.spec.y);
  }

  series(key: MarkKey, palette: Palette) {
    return buildSeries(
      this.table,
      this.#split.sources(),
      this.table.numbers(this.spec.x as never),
      key,
      palette,
      this.spec.fill,
    );
  }

  xExtent(series: readonly Series[], log: boolean) {
    return unionExtent(series.map((s) => xExtent(s, log)));
  }

  yExtent(series: readonly Series[], x0: number, x1: number, log: boolean, breaks?: Breaks) {
    return unionExtent(series.map((s) => yExtent(s, x0, x1, s.y, log, undefined, false, breaks)));
  }

  geometry(series: readonly Series[], frame: Frame): PointGeometry[] {
    const encoding = this.#encoding(frame.theme);
    // With no color value at all, no point has the value it encodes.
    if (this.spec.color !== undefined && !encoding.color) return [];
    const radius = this.#radius;
    const reachOf = this.#reaches;
    const fixedReach = reachOf[SYMBOLS.indexOf(this.#symbol)]!;
    const opacity = typeof this.spec.fillOpacity === "number" ? this.spec.fillOpacity : 1;
    // Points of one size, color, opacity, and circle shape can take the fast paths.
    const encoded =
      encoding.radius !== undefined ||
      encoding.color !== undefined ||
      encoding.opacity !== undefined ||
      this.#symbolField !== undefined ||
      this.#symbol !== "circle";
    const { plot, pixelRatio } = frame;
    const out: PointGeometry[] = [];
    const columns = Math.ceil(plot.width * pixelRatio) + 1;
    const rows = Math.ceil(plot.height * pixelRatio) + 1;
    const read = (field: string | undefined) =>
      field === undefined ? undefined : this.table.numbers(field as never);
    const sizes = read(this.#rField);
    const tones = read(this.spec.color);
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
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      const opaque =
        encoding.opacity === undefined &&
        opacity >= 1 &&
        (encoding.color !== undefined || isOpaqueColor(s.color));
      // Device-pixel occupancy for sampling; only opaque plain points qualify,
      // since overlapping translucent or varied points look different from one.
      const sample = this.spec.sampling === "pixel" && opaque && !encoded;
      const [start, end] = this.#visible(s, frame);
      // The GPU maps linearly; points on an axis with breaks are placed here.
      const linear = frame.x.breaks === undefined;
      // The WebGL painter draws whole columns; a view's rows are drawn on the CPU.
      if (
        frame.clouds &&
        !this.view &&
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
      const colorIndex = tones && frame.bytes(s.key, "color", length);
      const opacities = alphas && frame.floats(s.key, "opacity", length);
      const symbols = codes && frame.bytes(s.key, "symbol", length);
      let count = 0;
      for (let k = start; k < end; k++) {
        const row = rowOf(s, k);
        // A point missing a value it encodes is not drawn.
        const r = sizes ? encoding.radius!(sizes[row]!) : radius;
        const tone = tones ? encoding.color!.index(tones[row]!) : 0;
        const alpha = alphas ? encoding.opacity!(alphas[row]!) : opacity;
        const shape = codes ? (shapeOf![codes[row]!] ?? NO_SHAPE) : 0;
        if (!(r > 0 && tone >= 0 && Number.isFinite(alpha) && shape !== NO_SHAPE)) continue;
        // Points whose shape reaches into the plot are drawn.
        const reach = r * (codes ? reachOf[shape]! : fixedReach) + this.#ringWidth / 2;
        const placed = place(s, row, frame, reach);
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
        colors: colorIndex && { index: colorIndex, palette: encoding.palette! },
        opacities,
        symbols,
        ring,
      });
    }
    return out;
  }

  /** How sizes, colors, and opacities follow their fields, with the current data. */
  #encoding(theme: Theme): Encoding {
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
    return out;
  }

  /**
   * Radius of a value of the `r` field: areas grow linearly within `rRange`
   * from zero, or from the least value when some are negative.
   */
  #radiusScale(): ((value: number) => number) | undefined {
    if (this.#rField === undefined) return undefined;
    const extent = this.table.extent(this.#rField as never);
    const [lo, hi] = extent ? (extent[0] >= 0 ? [0, extent[1]] : extent) : [0, 0];
    const [r0, r1] = this.spec.rRange ?? R_RANGE;
    return (value) => {
      if (!Number.isFinite(value)) return Number.NaN;
      const t = Math.min(1, Math.max(0, fraction(value, lo, hi)));
      return Math.sqrt(r0 * r0 + (r1 * r1 - r0 * r0) * t);
    };
  }

  /** The continuous color scale of the `color` field, with the current data. */
  #colorScale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    if (spec.color === undefined) return undefined;
    const domain = spec.colorDomain ?? this.table.extent(spec.color as never);
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
   * Point series show their symbol; with a color field, in a neutral color.
   * An outline in a color of its own shows too, so hollow points have a
   * swatch; one in the background color only keeps points apart.
   */
  legendEntry(s: Series, theme: Theme): { color: string; glyph: string; stroke?: string } {
    const entry = {
      color: this.spec.color === undefined ? s.color : theme.muted,
      glyph: legendGlyph(this.#legendSymbol(s)).glyph,
    };
    const stroke = this.spec.stroke;
    return stroke !== undefined && this.#ringWidth > 0 ? { ...entry, stroke } : entry;
  }

  /** A series' shape: its own when the symbol field also splits series, else a circle. */
  #legendSymbol(s: Series): SymbolName {
    const field = this.#symbolField;
    if (field === undefined) return this.#symbol;
    if (field !== this.spec.series) return "circle";
    this.#shapesByCode();
    return SYMBOLS[this.#shapes.get(s.label) ?? 0]!;
  }

  /**
   * A key of sizes (three round values of the `r` field) and of shapes (each
   * value of a symbol field that does not also split series).
   */
  #glyphKeys(series: readonly Series[], format: (value: number) => string): GlyphKey[] {
    if (series.length === 0) return [];
    const out: GlyphKey[] = [];
    const radius = this.#radiusScale();
    const extent = this.#rField !== undefined && this.table.extent(this.#rField as never);
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
        title: this.#rField!,
        channel: "size",
        entries: values.map((value) => {
          const r = radius(value);
          return { label: format(value), glyph: symbolPath("circle", 0, 0, r), r };
        }),
      });
    }
    const field = this.#symbolField;
    if (field !== undefined && field !== this.spec.series) {
      const { dictionary } = this.table.categories(field as never);
      const shapeOf = this.#shapesByCode();
      out.push({
        title: field,
        channel: "shape",
        // The values in the table now, in order of appearance.
        entries: dictionary.flatMap((label, code) => {
          if (shapeOf[code] === NO_SHAPE) return [];
          const shape = SYMBOLS[shapeOf[code]!]!;
          const { glyph, reach } = legendGlyph(shape);
          return [{ label, glyph, r: reach, shape }];
        }),
      });
    }
    return out;
  }

  /**
   * The shape (an index into SYMBOLS) of each code of the symbol field, or
   * NO_SHAPE for codes no row holds, for the table's current version. Values
   * take shapes in order of appearance and keep them while they stay in the
   * table, though compaction renumbers codes.
   */
  #shapesByCode(): Uint8Array {
    const { version } = this.table;
    if (this.#codeShapes?.version === version) return this.#codeShapes.shapes;
    const { codes, dictionary } = this.table.categories(this.#symbolField as never);
    const present = new Uint8Array(dictionary.length);
    let count = 0;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code >= 0 && !present[code]) {
        present[code] = 1;
        count++;
      }
    }
    // Values that left the table are forgotten once they outnumber those in it.
    if (this.#shapes.size > 2 * count + 64) {
      const live = new Set(dictionary.filter((_, code) => present[code]));
      for (const label of this.#shapes.keys()) if (!live.has(label)) this.#shapes.delete(label);
    }
    const shapes = new Uint8Array(dictionary.length).fill(NO_SHAPE);
    dictionary.forEach((label, code) => {
      if (!present[code]) return;
      let shape = this.#shapes.get(label);
      if (shape === undefined) {
        shape = this.#nextShape++ % SYMBOLS.length;
        this.#shapes.set(label, shape);
      }
      shapes[code] = shape;
    });
    this.#codeShapes = { version, shapes };
    return shapes;
  }

  /** Shapes by category value, and the next shape a new value takes. */
  readonly #shapes = new Map<string, number>();
  #nextShape = 0;
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

  #codeShapes: { version: number; shapes: Uint8Array } | undefined;

  /** The y value and the values of the fields encoded as size, color, and opacity. */
  pointText(s: Series, row: number, format: AxisFormat): string {
    let text = format.y(s.values[row]!);
    for (const field of [this.#rField, this.spec.color, this.#opacityField]) {
      if (field === undefined) continue;
      text += `, ${field} ${format.value(this.table.numbers(field as never)[row]!)}`;
    }
    if (this.#symbolField !== undefined && this.#symbolField !== this.spec.series) {
      const { codes, dictionary } = this.table.categories(this.#symbolField as never);
      text += `, ${this.#symbolField} ${dictionary[codes[row]!] ?? ""}`;
    }
    return text;
  }

  /** The color a row's point is drawn in: its series', or from the `color` field. */
  pointColor(s: Series, row: number, theme: Theme): string {
    if (this.spec.color === undefined) return s.color;
    return (
      this.#colorScale(theme)?.color(this.table.numbers(this.spec.color as never)[row]!) ?? s.color
    );
  }

  /** Whether a row is drawn: rows missing a value they encode, or sized to nothing, are not. */
  shows(_s: Series, row: number): boolean {
    return this.#reach(row, this.#radiusScale()) > 0;
  }

  #drawn(row: number): boolean {
    const finite = (field: string | undefined) =>
      field === undefined || Number.isFinite(this.table.numbers(field as never)[row]);
    return (
      finite(this.#rField) &&
      finite(this.spec.color) &&
      finite(this.#opacityField) &&
      (this.#symbolField === undefined ||
        this.table.categories(this.#symbolField as never).codes[row]! >= 0)
    );
  }

  /** Rows of a series in the x domain, widened by how far points reach past it. */
  #visible(s: Series, frame: Frame): [number, number] {
    const { plot, x } = frame;
    const reach = this.inset.x;
    return visibleRange(s, x.invert(plot.x - reach), x.invert(plot.x + plot.width + reach));
  }

  /** How far a row's point and outline reach from its center, in pixels; NaN when it is not drawn. */
  #reach(row: number, radiusOf: ((value: number) => number) | undefined): number {
    if (!this.#drawn(row)) return Number.NaN;
    const r = radiusOf ? radiusOf(this.table.numbers(this.#rField as never)[row]!) : this.#radius;
    const shape =
      this.#symbolField !== undefined
        ? this.#shapesByCode()[this.table.categories(this.#symbolField as never).codes[row]!]!
        : SYMBOLS.indexOf(this.#symbol);
    return r > 0 ? r * this.#reaches[shape]! + this.#ringWidth / 2 : Number.NaN;
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
    for (const s of series) {
      if (frame.hidden.has(s.key)) continue;
      let index = indexes.get(s.key);
      if (!index) {
        index = buildIndex(s, frame, this.#visible(s, frame), (row) => this.#reach(row, radiusOf));
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
 * Pixel position of a row, or undefined when the point is not drawn: missing,
 * or farther outside the plot than points reach.
 */
function place(s: Series, row: number, frame: Frame, reach: number): [number, number] | undefined {
  // Points inside an axis break are not drawn.
  if (frame.x.breaks?.hides(s.x[row]!)) return undefined;
  const px = frame.x.map(s.x[row]!);
  const py = frame.y.map(s.y[row]!);
  if (!(Number.isFinite(px) && Number.isFinite(py))) return undefined;
  const { plot } = frame;
  if (px < plot.x - reach || px > plot.x + plot.width + reach) return undefined;
  if (py < plot.y - reach || py > plot.y + plot.height + reach) return undefined;
  return [px, py];
}

/** A grid index of the rows in [start, end) whose points reach into the plot. */
function buildIndex(
  s: Series,
  frame: Frame,
  [start, end]: [number, number],
  reachOf: (row: number) => number,
): GridIndex {
  const coords = new Float32Array((end - start) * 2);
  const ids = new Uint32Array(end - start);
  let count = 0;
  for (let k = start; k < end; k++) {
    const row = rowOf(s, k);
    const reach = reachOf(row);
    const placed = reach >= 0 ? place(s, row, frame, reach) : undefined;
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
  const spec: PointSpec = {
    type: "point",
    x: options.x,
    y: options.y,
    ...definedFields(options, [
      "series",
      "r",
      "fill",
      "fillOpacity",
      "stroke",
      "strokeWidth",
      "color",
      "colorMidpoint",
      "symbol",
      "sampling",
      "label",
      "id",
      "axis",
      "facet",
      "panel",
    ]),
  };
  if (options.rRange) spec.rRange = [options.rRange[0], options.rRange[1]];
  if (options.colors) spec.colors = [...options.colors];
  if (options.colorDomain) spec.colorDomain = [options.colorDomain[0], options.colorDomain[1]];
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
