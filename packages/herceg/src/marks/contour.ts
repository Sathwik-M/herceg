// Contours of a field sampled on a grid: lines where it crosses thresholds,
// or bands filled between them. The field is a table's rows, each a value
// at an x and a y of a rectilinear grid (the distinct x values crossed with
// the distinct y values), or a matrix table, which holds the grid as it is.
// Tracing (contour-trace.ts) runs once per grid and thresholds; recoloring,
// zooming, and panning only project what it traced.

import type { NumericArray } from "../data/column.ts";
import { type Matrix, matrixOf } from "../data/matrix.ts";
import {
  type NumberField,
  type NumericField,
  type Schema,
  scanExtent,
  type Table,
} from "../data/table.ts";
import { lineDrawing } from "../draw/line.ts";
import { polygonsDrawing } from "../draw/polygons.ts";
import { formatNumber } from "../format/format.ts";
import type { LegendPart } from "../model/legend.ts";
import { checkColorScale, checkRamp, rampOf, SequentialScale } from "../scale/color.ts";
import type { PositionScale } from "../scale/scale.ts";
import { linearTicks, niceDomain } from "../scale/ticks.ts";
import type { LineGeometry, PolygonGeometry } from "../scene/scene.ts";
import type { ContourSpec, Frozen } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { contourFormError } from "./contour-input.ts";
import { bandRings, GridTracer, type ScalarGrid, type Traced } from "./contour-trace.ts";
import { distinct } from "./heatmap-cells.ts";
import { keyLegend } from "./legend-parts.ts";
import { definedFields } from "./line.ts";
import {
  type BandContext,
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
  type SummaryContext,
  seriesKey,
} from "./mark.ts";
import type { Series } from "./series.ts";

export interface ContourOptions<S extends Schema> {
  /** Number or time field: each grid point's x. */
  x: NumericField<S>;
  /** Number or time field: each grid point's y. */
  y: NumericField<S>;
  /** Number field: the field's value at each grid point. */
  color: NumberField<S>;
  /**
   * The values contours are drawn at: about how many round values (10 by
   * default) across the field's values, or the values themselves,
   * increasing. Lines are drawn at each; bands fill between neighbors.
   */
  thresholds?: number | readonly number[];
  /** "lines" (the default) at each threshold, or "bands" filled between them. */
  variant?: "lines" | "bands";
  /** Color ramp from low to high values, such as an imported scheme; the theme's by default. */
  colors?: readonly string[];
  /** The values at the ends of the ramp; the field's extent by default. */
  colorDomain?: readonly [number, number];
  /** The value at the ramp's middle, for diverging ramps. */
  colorMidpoint?: number;
  /** One color for every line, instead of each line's value on the ramp. Lines only. */
  stroke?: string;
  /** Line width in pixels; the theme's by default. Lines only. */
  strokeWidth?: number;
  /** Opacity of the bands' fill, from 0 to 1; 1 by default. Bands only. */
  fillOpacity?: number;
  /** What the field is, in the legend and tooltips; the `color` field's name by default. */
  label?: string;
  /** Draw every row in every facet panel instead of the panel's own. */
  facet?: "repeat";
  /** The subplot to draw in, or "*" for every panel. */
  panel?: string;
  id?: string;
}

/** Thresholds a count asks for when none are given. */
const THRESHOLDS = 10;
/** Pixels from a line the pointer may be and still be on it. */
const LINE_REACH = 4;
/**
 * Grid units a band's anchor sits inside its boundary: well above the
 * error of testing a point against Float32 ring points, well below any band
 * thin enough to see.
 */
const NUDGE = 1e-6;
/** Grid units per side of the blocks that index rings and lines for the pointer. */
const BLOCK = 16;

/** One series' geometry: a band's rings (those of its two thresholds), or a level's lines. */
interface Contours {
  grid: ScalarGrid;
  /** Bands: their lower and upper threshold; lines: their level. */
  thresholds: readonly number[];
  /**
   * Bands: the rings at their lower and upper threshold, and the rings
   * those along cells' sides make of the band together (see `bandRings`);
   * lines: the lines at their level.
   */
  sets: readonly Traced[];
  /** Per set, the rings `bandRings` replaced: they bound no region and are not drawn. */
  cancelled: readonly Uint8Array[];
  /** Each position's line or region: the set and the ring (a band's outer boundary) or line. */
  parts: Int32Array;
  /** Per set, each ring's or line's position, -1 for a band's holes. */
  positions: readonly Int32Array[];
  /** Each position's anchor, in the grid's x and y values. */
  x: Float64Array;
  y: Float64Array;
  /** Each position's value: the band's lower threshold, or the level. */
  values: Float64Array;
  /** Where the pointer finds rings and lines, built when first asked for. */
  index?: BlockIndex | undefined;
}

/** A grid traced at the thresholds, as of the rows it was made from. */
interface Traces {
  version: number;
  thresholds: readonly number[];
  grid: ScalarGrid;
  /** Per threshold: bands' rings (the last strictly above it), or lines. */
  sets: Traced[];
  /** Per series (band or level), its contours, made when first read. */
  series: (Contours | undefined)[];
}

/**
 * Contours of a field over a rectilinear grid. Lines run where the field
 * crosses each threshold, interpolated linearly between grid points, and
 * bands fill the regions from one threshold up to the next (the last band
 * holding its upper threshold too): disjoint polygons, with holes, each a
 * series, its regions its points. Grid points without a value leave out
 * the cells around them, as holes. Contours end where the grid does.
 */
export class ContourMark implements Mark<Frozen<ContourSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<ContourSpec>;
  readonly table: Table<Schema>;
  readonly tooltip = "cell";
  readonly summarizes = true;
  /** Automatic y domains end at the grid's edges rather than at round values. */
  readonly tight = true;
  readonly #bands: boolean;
  /** The traced grid, by the rows it was made from (or the x column for every row). */
  readonly #traces = new WeakMap<object, Traces>();
  /** Each series' contours, by its values, which only it holds. */
  readonly #contours = new WeakMap<NumericArray, Contours>();
  #thresholds: { version: number; values: readonly number[] } | undefined;
  #extent: { version: number; extent: readonly [number, number] | undefined } | undefined;

  constructor(input: ContourSpec, table: Table<Schema>) {
    this.spec = frozen(input);
    const spec = this.spec;
    this.table = table;
    requireField(table, spec.x, NUMERIC, "contour x");
    requireField(table, spec.y, NUMERIC, "contour y");
    requireField(table, spec.color, ["number"], "contour color");
    const variant = spec.variant ?? "lines";
    if (variant !== "lines" && variant !== "bands")
      throw new TypeError(
        `contour variant: expected "lines" or "bands"; received ${JSON.stringify(variant)}`,
      );
    this.#bands = variant === "bands";
    const form = contourFormError(spec);
    if (form) throw new TypeError(form);
    checkThresholds(spec.thresholds);
    if (Array.isArray(spec.colors)) checkRamp(spec.colors, "contour colors");
    checkColorScale(spec.colorDomain, spec.colorMidpoint, "contour");
    if (
      spec.strokeWidth !== undefined &&
      !(spec.strokeWidth >= 0 && Number.isFinite(spec.strokeWidth))
    )
      throw new RangeError(
        `contour strokeWidth: expected a number of at least 0; received ${spec.strokeWidth}`,
      );
    if (spec.fillOpacity !== undefined && !(spec.fillOpacity >= 0 && spec.fillOpacity <= 1))
      throw new RangeError(
        `contour fillOpacity: expected a number from 0 to 1; received ${spec.fillOpacity}`,
      );
  }

  channelKind(axis: "x" | "y") {
    return this.table.kind(this.spec[axis]);
  }

  /** The field's values, all rows'. */
  #values(): NumericArray {
    return this.table.numbers(this.spec.color as never);
  }

  /** The least and greatest value of the field, over every row. */
  #valueExtent(): readonly [number, number] | undefined {
    const { version } = this.table;
    if (this.#extent?.version !== version) {
      const values = this.#values();
      this.#extent = { version, extent: scanExtent(values, 0, values.length) };
    }
    return this.#extent.extent;
  }

  /**
   * The thresholds, the same in every panel: given, or round values across
   * the field's values (for bands, round edges covering them).
   */
  #levels(): readonly number[] {
    const { version } = this.table;
    if (this.#thresholds?.version === version) return this.#thresholds.values;
    const given = this.spec.thresholds;
    let values: readonly number[];
    if (Array.isArray(given)) values = given as readonly number[];
    else {
      const count = (given as number | undefined) ?? THRESHOLDS;
      const extent = this.#valueExtent();
      if (!extent) values = [];
      else if (this.#bands) {
        // A field of one value gets one band around it, of a width its magnitude can hold.
        const half = Math.max(0.5, Math.abs(extent[0]) * 1e-6);
        const [lo, hi] =
          extent[0] < extent[1]
            ? niceDomain(extent[0], extent[1], count)
            : [
                Math.max(-Number.MAX_VALUE, extent[0] - half),
                Math.min(Number.MAX_VALUE, extent[1] + half),
              ];
        values = linearTicks(lo, hi, count);
        if (values.length < 2) values = [lo, hi];
        // Spans past the largest doubles have no round values: even ones instead.
        if (!increasing(values)) values = evenly(extent[0], extent[1], count, true);
      } else {
        const inside = (t: number) => t > extent[0] && t < extent[1];
        values = linearTicks(extent[0], extent[1], count).filter(inside);
        // `count` lines strictly between the ends: count + 1 steps.
        if (extent[0] < extent[1] && !(values.length > 0 && increasing(values)))
          values = evenly(extent[0], extent[1], count + 1, false);
      }
    }
    this.#thresholds = { version, values };
    return values;
  }

  /** The series' names and keys: a band per neighboring thresholds, or a line per threshold. */
  #roster(key: MarkKey, theme: Theme, locale: string | undefined) {
    const levels = this.#levels();
    const f = (value: number) => formatNumber(value, locale);
    const scale = this.#colorScale(theme);
    if (this.#bands)
      return levels.slice(0, -1).map((lo, i) => {
        const hi = levels[i + 1]!;
        return {
          key: seriesKey(key, `${lo}|${hi}`),
          label: `${f(lo)} – ${f(hi)}`,
          color: scale?.color(lo / 2 + hi / 2) ?? theme.text,
          level: lo,
        };
      });
    return levels.map((level) => ({
      key: seriesKey(key, `${level}`),
      label: f(level),
      color: this.spec.stroke ?? scale?.color(level) ?? theme.text,
      level,
    }));
  }

  series(
    key: MarkKey,
    _palette: Palette,
    _hidden: ReadonlySet<string>,
    _bands: unknown,
    context: BandContext,
    split = false,
  ): Series[] {
    const roster = this.#roster(key, context.theme, context.locale);
    if (split) return roster.map((entry) => withoutParts(entry.key, entry.label, entry.color));
    return this.#seriesOf(roster, undefined);
  }

  /** Each panel's contours: of the grid its rows sample, at the thresholds of every panel. */
  summarizePanels(roster: readonly Series[], rows: readonly Uint32Array[]): Series[][] {
    const entries = roster.map((s, i) => ({
      key: s.key,
      label: s.label,
      color: s.color,
      level: this.#levels()[i]!,
    }));
    return rows.map((panel) => this.#seriesOf(entries, panel));
  }

  /** The series of the contours of `rows` (every row without them), one per roster entry. */
  #seriesOf(
    roster: readonly { key: string; label: string; color: string; level: number }[],
    rows: Uint32Array | undefined,
  ): Series[] {
    const traces = this.#traced(rows);
    return roster.map((entry, i) => {
      const contours = traces && this.#contoursOf(traces, i, entry.level);
      if (!contours) return withoutParts(entry.key, entry.label, entry.color);
      return {
        key: entry.key,
        label: entry.label,
        color: entry.color,
        x: contours.x,
        y: contours.y,
        y0: undefined,
        values: contours.values,
        range: false,
        rows: undefined,
        length: contours.values.length,
        sorted: false,
      };
    });
  }

  /**
   * Series `i`'s contours in `traces`: a band's regions, or a level's
   * lines, each with an anchor.
   */
  #contoursOf(traces: Traces, i: number, level: number): Contours {
    const cached = traces.series[i];
    if (cached) return cached;
    const bands = this.#bands;
    let sets: Traced[];
    let cancelled: Uint8Array[];
    if (bands) {
      const [lower, upper] = [traces.sets[i]!, traces.sets[i + 1]!];
      const { rings, replaced } = bandRings(lower, upper);
      sets = [lower, upper, rings];
      cancelled = [...replaced, new Uint8Array(rings.areas.length)];
    } else {
      sets = [traces.sets[i]!];
      cancelled = [new Uint8Array(sets[0]!.areas.length)];
    }
    // A band's regions: what the lower threshold's rings go around, the
    // upper one's holes, and the pieces its own rings go around.
    const isRegion = (k: number, r: number) =>
      !cancelled[k]![r] && (!bands || (k === 1 ? sets[k]!.areas[r]! < 0 : sets[k]!.areas[r]! > 0));
    const contours = this.#regions(traces, i, level, sets, cancelled, isRegion);
    traces.series[i] = contours;
    this.#contours.set(contours.values, contours);
    return contours;
  }

  /**
   * Series `i`'s contours, the regions or lines `isRegion` says are its
   * points, each anchored where the pointer finds it; a band region it
   * finds nowhere (a sliver below single precision) is left out.
   */
  #regions(
    traces: Traces,
    i: number,
    level: number,
    sets: readonly Traced[],
    cancelled: readonly Uint8Array[],
    isRegion: (k: number, r: number) => boolean,
  ): Contours {
    const bands = this.#bands;
    const parts: number[] = [];
    const positions = sets.map((set, k) => {
      const position = new Int32Array(set.areas.length).fill(-1);
      for (let r = 0; r < set.areas.length; r++)
        if (isRegion(k, r)) {
          position[r] = parts.length / 2;
          parts.push(k, r);
        }
      return position;
    });
    const n = parts.length / 2;
    const contours: Contours = {
      grid: traces.grid,
      thresholds: bands ? [traces.thresholds[i]!, traces.thresholds[i + 1]!] : [level],
      sets,
      cancelled,
      parts: Int32Array.from(parts),
      positions,
      x: new Float64Array(n),
      y: new Float64Array(n),
      values: new Float64Array(n).fill(level),
    };
    const lost = new Set<string>();
    for (let p = 0; p < n; p++) {
      const anchor = bands ? bandAnchor(contours, p) : lineAnchor(contours, p);
      if (!anchor) {
        lost.add(`${parts[p * 2]} ${parts[p * 2 + 1]}`);
        continue;
      }
      contours.x[p] = along(traces.grid.xs, anchor[0]);
      contours.y[p] = along(traces.grid.ys, anchor[1]);
    }
    if (lost.size === 0) return contours;
    return this.#regions(
      traces,
      i,
      level,
      sets,
      cancelled,
      (k, r) => isRegion(k, r) && !lost.has(`${k} ${r}`),
    );
  }

  /** The grid of `rows` (every row without them), traced at the thresholds; undefined without one. */
  #traced(rows: Uint32Array | undefined): Traces | undefined {
    const { table } = this;
    const key = rows ?? table;
    const thresholds = this.#levels();
    const cached = this.#traces.get(key);
    if (cached?.version === table.version && cached.thresholds === thresholds) return cached;
    // A matrix table's grid is its matrix, read as it is.
    const matrix = rows ? undefined : this.#matrix();
    const grid = matrix
      ? matrixGrid(matrix, this.#values())
      : gridOf(
          table.numbers(this.spec.x as never),
          table.numbers(this.spec.y as never),
          this.#values(),
          rows,
        );
    if (!grid) return undefined;
    const tracer = new GridTracer(grid);
    const last = thresholds.length - 1;
    const sets = thresholds.map((t, i) =>
      this.#bands ? tracer.rings(t, i === last) : tracer.lines(t),
    );
    const traces = { version: table.version, thresholds, grid, sets, series: [] };
    this.#traces.set(key, traces);
    return traces;
  }

  /** The table's matrix, when its coordinates are this mark's x and y (either way round). */
  #matrix(): (Matrix & { transposed: boolean }) | undefined {
    const matrix = matrixOf(this.table);
    const { x, y } = this.spec;
    if (matrix?.x === x && matrix.y === y) return { ...matrix, transposed: false };
    if (matrix?.x === y && matrix.y === x) return { ...matrix, transposed: true };
    return undefined;
  }

  /** The scale coloring contours: over `colorDomain`, or the field's extent. */
  #colorScale(theme: Theme): SequentialScale | undefined {
    const { spec } = this;
    const domain = spec.colorDomain ?? this.#valueExtent();
    if (!domain) return undefined;
    const fallback = spec.colorMidpoint === undefined ? theme.sequential : theme.diverging;
    return new SequentialScale(domain, rampOf(spec.colors, fallback), spec.colorMidpoint);
  }

  /** Contours are colored by value: the legend lists the bands, or the lines of the ramp. */
  legendEntry(): false {
    return false;
  }

  /** A key of each band's color and range, or of each line's color and level. */
  legends(series: readonly Series[]): LegendPart[] {
    if (series.length === 0 || (!this.#bands && this.spec.stroke !== undefined)) return [];
    const glyph = this.#bands ? "M-5,-5h10v10h-10Z" : "M-6,-1h12v2h-12Z";
    return [
      keyLegend({
        title: this.spec.label ?? this.spec.color,
        channel: "color",
        entries: series.map((s) => ({ label: s.label, glyph, r: 5, color: s.color })),
      }),
    ];
  }

  xExtent(series: readonly Series[], log: boolean, breaks?: unknown) {
    return this.#gridExtent(series, "x", log, breaks !== undefined);
  }

  yExtent(series: readonly Series[], _x0: number, _x1: number, log: boolean) {
    return this.#gridExtent(series, "y", log, false);
  }

  /** The grid's extent along an axis, over every panel's: contours end where the grid does. */
  #gridExtent(
    series: readonly Series[],
    axis: "x" | "y",
    log: boolean,
    breaks: boolean,
  ): readonly [number, number] | undefined {
    if (log)
      throw new Error(`contour ${axis}: cannot go on a log ${axis} axis yet; use a linear one`);
    if (breaks) throw new Error("contour x: cannot leave out time breaks yet; drop x.breaks");
    let lo = Infinity;
    let hi = -Infinity;
    let found = false;
    for (const s of series) {
      const contours = this.#contours.get(s.values);
      if (!contours) continue;
      found = true;
      const positions = axis === "x" ? contours.grid.xs : contours.grid.ys;
      lo = Math.min(lo, positions[0]!);
      hi = Math.max(hi, positions[positions.length - 1]!);
    }
    // A split chart's roster holds no contours: the grid's values span them.
    if (!found) {
      const matrix = this.#matrix();
      const column = matrix
        ? (axis === "x") !== matrix.transposed
          ? matrix.xs
          : matrix.ys
        : this.table.numbers(this.spec[axis] as never);
      return scanExtent(column, 0, column.length);
    }
    return lo <= hi ? ([lo, hi] as const) : undefined;
  }

  geometry(series: readonly Series[], frame: Frame): (PolygonGeometry | LineGeometry)[] {
    const out: (PolygonGeometry | LineGeometry)[] = [];
    const { x, y, plot } = frame;
    const view = {
      u: [x.invert(plot.x), x.invert(plot.x + plot.width)],
      v: [y.invert(plot.y + plot.height), y.invert(plot.y)],
    };
    // What projecting depends on: an unchanged view (as when colors change)
    // draws what the buffer holds again.
    const inputs = [...x.domain, ...x.range, ...y.domain, ...y.range];
    for (const s of series) {
      const contours = this.#contours.get(s.values);
      if (!contours || s.length === 0 || frame.hidden.has(s.key)) continue;
      const project = projector(contours.grid, x, y);
      // Rings and lines wholly out of view draw nothing there: a ring out of
      // view changes no fill inside it.
      const [u0, u1] = gridRange(contours.grid.xs, view.u);
      const [v0, v1] = gridRange(contours.grid.ys, view.v);
      const visible = (boxes: Float32Array, cancelled: Uint8Array, r: number) =>
        !cancelled[r] &&
        boxes[r * 4 + 2]! >= u0 &&
        boxes[r * 4]! <= u1 &&
        boxes[r * 4 + 3]! >= v0 &&
        boxes[r * 4 + 1]! <= v1;
      if (this.#bands) {
        let points = 0;
        let rings = 0;
        for (let k = 0; k < contours.sets.length; k++) {
          const set = contours.sets[k]!;
          const cancelled = contours.cancelled[k]!;
          for (let r = 0; r < set.areas.length; r++)
            if (visible(set.boxes, cancelled, r)) {
              points += set.starts[r + 1]! - set.starts[r]!;
              rings++;
            }
        }
        if (rings === 0) continue;
        const coords = frame.floats(s.key, "contour", points * 2);
        const last = projected.get(coords.buffer);
        let starts: Uint32Array;
        let at = points;
        if (last?.contours === contours && sameInputs(last.inputs, inputs)) starts = last.starts!;
        else {
          starts = new Uint32Array(rings + 1);
          let ring = 0;
          at = 0;
          for (let k = 0; k < contours.sets.length; k++) {
            const set = contours.sets[k]!;
            const cancelled = contours.cancelled[k]!;
            for (let r = 0; r < set.areas.length; r++) {
              if (!visible(set.boxes, cancelled, r)) continue;
              starts[ring++] = at;
              for (let p = set.starts[r]!; p < set.starts[r + 1]!; p++) {
                project(set.points[p * 2]!, set.points[p * 2 + 1]!, coords, at * 2);
                at++;
              }
            }
          }
          starts[ring] = at;
          projected.set(coords.buffer, { contours, inputs, starts });
        }
        const opacity = this.spec.fillOpacity ?? 1;
        out.push({
          kind: "polygons",
          draw: polygonsDrawing,
          key: s.key,
          shapes: [{ coords: coords.subarray(0, at * 2), rings: starts, path: undefined }],
          colors: [s.color],
          colorIndex: Uint32Array.of(0),
          fillOpacity: opacity,
          // Opaque bands are outlined in their own color, which covers the
          // seams antialiasing leaves between neighbors.
          stroke: s.color,
          strokeWidth: opacity === 1 ? 0.5 : 0,
        });
        continue;
      }
      const path = frame.polyline(s.key, "contour");
      const last = projected.get(path);
      if (!(last?.contours === contours && sameInputs(last.inputs, inputs))) {
        path.reset();
        const point = new Float32Array(2);
        const [set] = contours.sets;
        for (let r = 0; r < set!.areas.length; r++) {
          if (!visible(set!.boxes, contours.cancelled[0]!, r)) continue;
          path.break();
          for (let p = set!.starts[r]!; p < set!.starts[r + 1]!; p++) {
            project(set!.points[p * 2]!, set!.points[p * 2 + 1]!, point, 0);
            path.push(point[0]!, point[1]!);
          }
        }
        projected.set(path, { contours, inputs });
      }
      if (path.count === 0) continue;
      out.push({
        kind: "line",
        draw: lineDrawing,
        key: s.key,
        stroke: s.color,
        strokeWidth: this.spec.strokeWidth ?? frame.theme.lineWidth,
        dash: undefined,
        path,
      });
    }
    return out;
  }

  /**
   * The band region under the pointer, or the line nearest it within a few
   * pixels, there: tooltips follow the pointer along contours.
   */
  pick(series: readonly Series[], px: number, py: number, frame: Frame): Hit | undefined {
    let best: Hit | undefined;
    for (const s of series) {
      const contours = this.#contours.get(s.values);
      if (!contours || s.length === 0 || frame.hidden.has(s.key)) continue;
      const { grid } = contours;
      const u = gridUnit(grid.xs, frame.x.invert(px));
      const v = gridUnit(grid.ys, frame.y.invert(py));
      contours.index ??= new BlockIndex(contours);
      if (this.#bands) {
        if (!Number.isFinite(u) || !Number.isFinite(v)) continue;
        const position = contours.index.region(u, v);
        if (position >= 0) return { series: s, position, distance: 0, at: [px, py] };
        continue;
      }
      const project = projector(grid, frame.x, frame.y);
      const reach = LINE_REACH + (this.spec.strokeWidth ?? frame.theme.lineWidth) / 2;
      // How many grid units the reach spans here, to look in the blocks it touches.
      const span = Math.max(
        Math.abs(gridUnit(grid.xs, frame.x.invert(px + reach)) - u),
        Math.abs(gridUnit(grid.ys, frame.y.invert(py + reach)) - v),
        Math.abs(gridUnit(grid.xs, frame.x.invert(px - reach)) - u),
        Math.abs(gridUnit(grid.ys, frame.y.invert(py - reach)) - v),
      );
      const near = contours.index.nearestLine(u, v, span, project, px, py, reach);
      if (near && near.distance <= (best?.distance ?? Infinity))
        best = { series: s, position: near.position, distance: near.distance, at: near.at };
    }
    return best;
  }

  /** Where a region's or line's marker sits: a point on it (inside a band region, by its edge). */
  pointAnchor(s: Series, row: number, frame: Frame): readonly [number, number] | undefined {
    const px = frame.x.map(s.x[row]!);
    const py = frame.y.map(s.y[row]!);
    return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : undefined;
  }

  pointColor(s: Series): string {
    return s.color;
  }

  /** Tooltips name the field. */
  pointLabel(): string {
    return this.spec.label ?? this.spec.color;
  }

  /** A band's range, or a line's level. */
  pointText(s: Series): string {
    return s.label;
  }

  /**
   * How many regions a band has, or lines a level, and where, over every
   * panel.
   */
  summarize(parts: readonly Series[], name: string, { format }: SummaryContext): string {
    let count = 0;
    let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
    for (const part of parts) {
      const contours = this.#contours.get(part.values);
      if (!contours) continue;
      count += part.length;
      for (let p = 0; p < part.length; p++) {
        const set = contours.sets[contours.parts[p * 2]!]!;
        const r = contours.parts[p * 2 + 1]!;
        const { xs, ys } = contours.grid;
        x0 = Math.min(x0, along(xs, set.boxes[r * 4]!));
        y0 = Math.min(y0, along(ys, set.boxes[r * 4 + 1]!));
        x1 = Math.max(x1, along(xs, set.boxes[r * 4 + 2]!));
        y1 = Math.max(y1, along(ys, set.boxes[r * 4 + 3]!));
      }
    }
    const what = this.#bands ? "region" : "line";
    const field = this.spec.label ?? this.spec.color;
    const heading = this.#bands ? `${field} ${name}` : `${field} at ${name}`;
    if (count === 0) return `${heading}: none`;
    return (
      `${heading}: ${count} ${what}${count === 1 ? "" : "s"}, ` +
      `x from ${format.x(x0)} to ${format.x(x1)} and y from ${format.y(y0)} to ${format.y(y1)}`
    );
  }
}

/**
 * What each buffer of projected points (a band's, or a level's polyline)
 * holds: whose contours, projected on what scales, and a band's rings.
 */
const projected = new WeakMap<
  object,
  { contours: Contours; inputs: readonly number[]; starts?: Uint32Array }
>();

function sameInputs(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Given thresholds' values (a count is checked as a form), finite and increasing. */
function checkThresholds(thresholds: unknown): void {
  if (thresholds === undefined || typeof thresholds === "number") return;
  if (!Array.isArray(thresholds))
    throw new TypeError(
      `contour thresholds: expected a count or a list of values; received ${JSON.stringify(thresholds)}`,
    );
  thresholds.forEach((value, i) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new RangeError(`contour thresholds[${i}]: expected a finite number; received ${value}`);
    if (i > 0 && !(value > thresholds[i - 1]))
      throw new RangeError(
        `contour thresholds[${i}]: expected a value above ${thresholds[i - 1]}, the one before; received ${value}`,
      );
  });
}

/** A series of no regions or lines. */
function withoutParts(key: string, label: string, color: string): Series {
  const values = new Float64Array(0);
  return {
    key,
    label,
    color,
    x: values,
    y: values,
    y0: undefined,
    values,
    range: false,
    rows: undefined,
    length: 0,
    sorted: false,
  };
}

/** Whether `values` are finite and each above the one before. */
function increasing(values: readonly number[]): boolean {
  return values.every((value, i) => Number.isFinite(value) && (i === 0 || value > values[i - 1]!));
}

/**
 * `count` steps from `lo` to `hi`, as weighted means of the two, which no
 * span of doubles overflows: with `ends` the thresholds of bands covering
 * them, without them the lines strictly between. Values the doubles cannot
 * tell apart are taken once.
 */
function evenly(lo: number, hi: number, count: number, ends: boolean): number[] {
  const values: number[] = [];
  for (let k = ends ? 0 : 1; k <= (ends ? count : count - 1); k++) {
    const f = k / count;
    const value = lo * (1 - f) + hi * f;
    if (values.length === 0 || value > values[values.length - 1]!) values.push(value);
  }
  return values;
}

/** Rows a grid needs with values, at least, per grid point, before its rows count as one. */
const FILLED = 0.25;

/**
 * The grid the rows (every row without `rows`) sample: their distinct x
 * and y values, ascending, and each pair's value (the last row's with one;
 * NaN for pairs no row has). Undefined for fewer than two values along
 * either axis. Rows scattered rather than on a grid are refused.
 */
export function gridOf(
  xColumn: NumericArray,
  yColumn: NumericArray,
  valueColumn: NumericArray,
  rows: Uint32Array | undefined,
): ScalarGrid | undefined {
  const gather = (column: NumericArray) =>
    rows ? Float64Array.from(rows, (row) => column[row]!) : column;
  const [xs, columns] = distinct(gather(xColumn));
  const [ys, lines] = distinct(gather(yColumn));
  const values = gather(valueColumn);
  if (xs.length < 2 || ys.length < 2) return undefined;
  const nx = xs.length;
  const points = nx * ys.length;
  const refuse = (given: number) => {
    if (given < points * FILLED)
      throw new RangeError(
        `contour: the rows give values at ${given} (${Math.round((given / points) * 1000) / 10}%) of the ${nx} by ${ys.length} grid points of their x and y values; contours need a value at (nearly) every x with every y, as fromMatrix holds them; for scattered points, use a 2D histogram or a density estimate`,
      );
  };
  // Rows with values bound the grid points with them: too few are refused
  // before the grid is made, so scattered rows never make a huge one.
  let rowsWith = 0;
  for (let k = 0; k < values.length; k++)
    if (columns[k]! >= 0 && lines[k]! >= 0 && Number.isFinite(values[k]!)) rowsWith++;
  refuse(rowsWith);
  const grid = new Float64Array(points).fill(Number.NaN);
  for (let k = 0; k < values.length; k++) {
    const [c, r] = [columns[k]!, lines[k]!];
    if (c >= 0 && r >= 0 && Number.isFinite(values[k]!)) grid[r * nx + c] = values[k]!;
  }
  // Grid points with a value, however many rows repeat them.
  let given = 0;
  for (const value of grid) if (Number.isFinite(value)) given++;
  refuse(given);
  return { xs, ys, values: grid };
}

/**
 * A matrix table's grid: its coordinates (along x the mark's x, either way
 * round), ascending, and its values, as they are when the coordinates
 * already ascend along x, or reordered.
 */
function matrixGrid(
  matrix: Matrix & { transposed: boolean },
  values: NumericArray,
): ScalarGrid | undefined {
  const [along, across] = matrix.transposed ? [matrix.ys, matrix.xs] : [matrix.xs, matrix.ys];
  const sorted = (positions: NumericArray, axis: string) => {
    const order = Array.from(positions, (_, i) => i).filter((i) => Number.isFinite(positions[i]!));
    order.sort((a, b) => positions[a]! - positions[b]!);
    for (let k = 1; k < order.length; k++)
      if (positions[order[k]!] === positions[order[k - 1]!])
        throw new RangeError(
          `contour ${axis}: the matrix's ${axis} value ${positions[order[k]!]} repeats; give each of its columns and rows a position of its own`,
        );
    return order;
  };
  const xOrder = sorted(along, "x");
  const yOrder = sorted(across, "y");
  if (xOrder.length < 2 || yOrder.length < 2) return undefined;
  const xs = Float64Array.from(xOrder, (i) => along[i]!);
  const ys = Float64Array.from(yOrder, (j) => across[j]!);
  const nx = matrix.xs.length;
  const inOrder = (order: number[], n: number) =>
    order.length === n && order.every((i, k) => i === k);
  if (!matrix.transposed && inOrder(xOrder, along.length) && inOrder(yOrder, across.length))
    return { xs, ys, values };
  const grid = new Float64Array(xs.length * ys.length);
  for (let j = 0; j < yOrder.length; j++)
    for (let i = 0; i < xOrder.length; i++) {
      const [c, r] = matrix.transposed ? [yOrder[j]!, xOrder[i]!] : [xOrder[i]!, yOrder[j]!];
      grid[j * xs.length + i] = values[r * nx + c]!;
    }
  return { xs, ys, values: grid };
}

/** The value at grid unit `u` along sample positions `positions`: a sample's, or between two. */
function along(positions: Float64Array, u: number): number {
  const last = positions.length - 1;
  const i = Math.max(0, Math.min(last - 1, Math.floor(u)));
  return positions[i]! + (u - i) * (positions[i + 1]! - positions[i]!);
}

/** The grid unit of `value` along sample positions `positions`, past the ends linearly; NaN for none. */
function gridUnit(positions: Float64Array, value: number): number {
  const last = positions.length - 1;
  if (!(last >= 1) || !Number.isFinite(value)) return Number.NaN;
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const middle = (lo + hi) >> 1;
    if (positions[middle]! <= value) lo = middle;
    else hi = middle;
  }
  return lo + (value - positions[lo]!) / (positions[lo + 1]! - positions[lo]!);
}

/** The range of grid units the values `[a, b]` span, a unit wider on each side. */
function gridRange(positions: Float64Array, [a, b]: number[]): [number, number] {
  const [lo, hi] = [gridUnit(positions, Math.min(a!, b!)), gridUnit(positions, Math.max(a!, b!))];
  return [Number.isFinite(lo) ? lo - 1 : -Infinity, Number.isFinite(hi) ? hi + 1 : Infinity];
}

/** Writes a grid unit point's pixels into `out` at `at`. */
type Project = (u: number, v: number, out: Float32Array, at: number) => void;

/** Grid units to pixels through the grid's positions and the scales; evenly spaced grids by one step. */
function projector(grid: ScalarGrid, x: PositionScale, y: PositionScale): Project {
  const mapping = (positions: Float64Array, scale: PositionScale) => {
    const n = positions.length;
    const step = (positions[n - 1]! - positions[0]!) / (n - 1);
    const even = positions.every(
      (p, i) => Math.abs(p - (positions[0]! + i * step)) <= Math.abs(step) * 1e-9,
    );
    const first = positions[0]!;
    return even
      ? (u: number) => scale.map(first + u * step)
      : (u: number) => scale.map(along(positions, u));
  };
  const mx = mapping(grid.xs, x);
  const my = mapping(grid.ys, y);
  return (u, v, out, at) => {
    out[at] = mx(u);
    out[at + 1] = my(v);
  };
}

/** The middle point of line `p` of `contours`, in grid units. */
function lineAnchor(contours: Contours, p: number): [number, number] {
  const set = contours.sets[0]!;
  const r = contours.parts[p * 2 + 1]!;
  const from = set.starts[r]!;
  const middle = from + Math.floor((set.starts[r + 1]! - from - 1) / 2);
  return [set.points[middle * 2]!, set.points[middle * 2 + 1]!];
}

/**
 * A point inside band region `p` of `contours`, in grid units, where the
 * pointer finds it; undefined for none. Where the region's boundary crosses
 * an edge of a cell, the band lies along that edge between the two
 * thresholds' crossings (or the edge's end, past which the band goes on),
 * with no other ring between: the point is halfway, at the first gap of a
 * quarter of a cell or else the widest, on an edge between two cells, or
 * else a little way into the cell
 * from one of the grid's ends or holes. A region with neither takes a
 * point a hair inside a side of it.
 */
function bandAnchor(contours: Contours, p: number): [number, number] | undefined {
  const k = contours.parts[p * 2]!;
  const r = contours.parts[p * 2 + 1]!;
  const set = contours.sets[k]!;
  const from = set.starts[r]!;
  const to = set.starts[r + 1]!;
  const points = set.points;
  const { xs, ys, values } = contours.grid;
  const nx = xs.length;
  const ny = ys.length;
  const [low, high] = contours.thresholds as [number, number];
  const valid = (i: number, j: number) =>
    i >= 0 &&
    j >= 0 &&
    i + 1 < nx &&
    j + 1 < ny &&
    Number.isFinite(
      values[j * nx + i]! +
        values[j * nx + i + 1]! +
        values[(j + 1) * nx + i]! +
        values[(j + 1) * nx + i + 1]!,
    );
  let inner: [number, number] | undefined;
  let widest = 0;
  // Points by edges with a cell on one side only, widest gap first.
  const outer: { gap: number; point: [number, number] }[] = [];
  for (let q = from; q + 1 < to; q++) {
    const [u, v] = [points[q * 2]!, points[q * 2 + 1]!];
    const horizontal = Number.isInteger(v) && !Number.isInteger(u);
    if (!horizontal && !(Number.isInteger(u) && !Number.isInteger(v))) continue;
    const [i, j] = [Math.floor(u), Math.floor(v)];
    // The cells either side: below and above a horizontal edge, left and right of a vertical one.
    const before = horizontal ? valid(i, j - 1) : valid(i - 1, j);
    const after = valid(i, j);
    if (!before && !after) continue;
    const a = values[j * nx + i]!;
    const b = values[horizontal ? j * nx + i + 1 : (j + 1) * nx + i]!;
    // The band along the edge, between the thresholds' crossings, where the rings put them.
    const base = horizontal ? i : j;
    const place = (t: number) =>
      Math.fround(base + Math.min(1, Math.max(0, fractionOf(t, a, b)))) - base;
    const [start, end] = [place(low), place(high)];
    const at = horizontal ? u - i : v - j;
    if (at !== start && at !== end) continue;
    const gap = Math.abs(end - start);
    if (gap === 0) continue;
    const middle = (start + end) / 2;
    if (before && after) {
      if (gap > widest) {
        widest = gap;
        inner = horizontal ? [i + middle, j] : [i, j + middle];
        // A quarter of a cell is wide enough to see the point inside.
        if (gap >= 0.25) return inner;
      }
      continue;
    }
    // Into the cell there is, a hundredth of the gap.
    const into = (after ? 1 : -1) * gap * 0.01;
    outer.push({ gap, point: horizontal ? [i + middle, j + into] : [i + into, j + middle] });
  }
  if (inner) return inner;
  outer.sort((a, b) => b.gap - a.gap);
  contours.index ??= new BlockIndex(contours);
  for (const { point } of outer) if (contours.index.region(point[0], point[1]) === p) return point;
  return sideAnchor(contours, p);
}

/** How far from `a` to `b` the value `t` is, as the tracer places crossings. */
function fractionOf(t: number, a: number, b: number): number {
  const f = (t - a) / (b - a);
  return Number.isFinite(t - a) && Number.isFinite(b - a) ? f : (t / 2 - a / 2) / (b / 2 - a / 2);
}

/**
 * A point a hair inside a side of band region `p`'s boundary (left of a
 * ring around what is above the lower threshold, right of the upper
 * threshold's hole rings), longest sides first, where the pointer's lookup
 * finds the region; undefined where it finds it by none.
 */
function sideAnchor(contours: Contours, p: number): [number, number] | undefined {
  const k = contours.parts[p * 2]!;
  const r = contours.parts[p * 2 + 1]!;
  const set = contours.sets[k]!;
  const points = set.points;
  const side = k === 1 ? -1 : 1;
  const sides: number[] = [];
  for (let s = set.starts[r]!; s + 1 < set.starts[r + 1]!; s++) sides.push(s);
  const lengthOf = (s: number) =>
    Math.hypot(points[s * 2 + 2]! - points[s * 2]!, points[s * 2 + 3]! - points[s * 2 + 1]!);
  sides.sort((a, b) => lengthOf(b) - lengthOf(a));
  contours.index ??= new BlockIndex(contours);
  for (const s of sides) {
    const [au, av, bu, bv] = [
      points[s * 2]!,
      points[s * 2 + 1]!,
      points[s * 2 + 2]!,
      points[s * 2 + 3]!,
    ];
    const length = lengthOf(s) || 1;
    const u = (au + bu) / 2 - ((bv - av) / length) * NUDGE * side;
    const v = (av + bv) / 2 + ((bu - au) / length) * NUDGE * side;
    if (contours.index.region(u, v) === p) return [u, v];
  }
  return undefined;
}

/**
 * Rings and lines by the blocks of grid units their boxes cover, for the
 * pointer: the band region holding a point, or the nearest line.
 */
class BlockIndex {
  readonly #contours: Contours;
  readonly #columns: number;
  /** Per block, where its entries start in `#entries`; one more ends the last. */
  readonly #starts: Uint32Array;
  /** Per entry, the set and the ring or line in it. */
  readonly #entries: Int32Array;

  constructor(contours: Contours) {
    this.#contours = contours;
    const { grid, sets } = contours;
    const columns = Math.max(1, Math.ceil((grid.xs.length - 1) / BLOCK));
    const rows = Math.max(1, Math.ceil((grid.ys.length - 1) / BLOCK));
    this.#columns = columns;
    // Every ring of a band (its regions' holes too, not rings that cancel),
    // or every line, by block.
    const each = (visit: (set: number, ring: number, block: number) => void) => {
      sets.forEach((set, k) => {
        for (let r = 0; r < set.areas.length; r++) {
          if (contours.cancelled[k]![r]) continue;
          const [c0, c1] = [
            blockOf(set.boxes[r * 4]!, columns),
            blockOf(set.boxes[r * 4 + 2]!, columns),
          ];
          const [b0, b1] = [
            blockOf(set.boxes[r * 4 + 1]!, rows),
            blockOf(set.boxes[r * 4 + 3]!, rows),
          ];
          for (let b = b0; b <= b1; b++)
            for (let c = c0; c <= c1; c++) visit(k, r, b * columns + c);
        }
      });
    };
    const counts = new Uint32Array(columns * rows + 1);
    each((_k, _r, block) => counts[block + 1]!++);
    for (let b = 0; b < columns * rows; b++) counts[b + 1]! += counts[b]!;
    const entries = new Int32Array(counts[columns * rows]! * 2);
    const filled = counts.slice();
    each((k, r, block) => {
      const at = filled[block]!++;
      entries[at * 2] = k;
      entries[at * 2 + 1] = r;
    });
    this.#starts = counts;
    this.#entries = entries;
  }

  #block(u: number, v: number): number {
    const rows = (this.#starts.length - 1) / this.#columns;
    return blockOf(v, rows) * this.#columns + blockOf(u, this.#columns);
  }

  /**
   * The position of the band region holding (u, v): inside an odd number of
   * the band's rings, the region the smallest of its outer rings around the
   * point bounds; -1 outside the band.
   */
  region(u: number, v: number): number {
    const { sets } = this.#contours;
    const block = this.#block(u, v);
    let inside = 0;
    let best = -1;
    let smallest = Infinity;
    const { positions } = this.#contours;
    for (let e = this.#starts[block]!; e < this.#starts[block + 1]!; e++) {
      const k = this.#entries[e * 2]!;
      const r = this.#entries[e * 2 + 1]!;
      const set = sets[k]!;
      const box = set.boxes;
      if (u < box[r * 4]! || u > box[r * 4 + 2]! || v < box[r * 4 + 1]! || v > box[r * 4 + 3]!)
        continue;
      if (!contains(set, r, u, v)) continue;
      inside++;
      const area = Math.abs(set.areas[r]!);
      const position = positions[k]![r]!;
      if (position >= 0 && area < smallest) [best, smallest] = [position, area];
    }
    return inside % 2 === 1 ? best : -1;
  }

  /**
   * The line nearest the pixel (px, py) within `reach` pixels, among those
   * in the blocks within `span` grid units of (u, v): its position, its
   * distance, and the nearest point on it.
   */
  nearestLine(
    u: number,
    v: number,
    span: number,
    project: Project,
    px: number,
    py: number,
    reach: number,
  ): { position: number; distance: number; at: [number, number] } | undefined {
    const { sets } = this.#contours;
    const set = sets[0]!;
    const rows = (this.#starts.length - 1) / this.#columns;
    const reachable = Number.isFinite(span) ? span : 0;
    const [c0, c1] = [blockOf(u - reachable, this.#columns), blockOf(u + reachable, this.#columns)];
    const [b0, b1] = [blockOf(v - reachable, rows), blockOf(v + reachable, rows)];
    let best: { position: number; distance: number; at: [number, number] } | undefined;
    const seen = new Set<number>();
    const a = new Float32Array(2);
    const b = new Float32Array(2);
    for (let row = b0; row <= b1; row++)
      for (let c = c0; c <= c1; c++) {
        const block = row * this.#columns + c;
        for (let e = this.#starts[block]!; e < this.#starts[block + 1]!; e++) {
          const r = this.#entries[e * 2 + 1]!;
          if (seen.has(r)) continue;
          seen.add(r);
          for (let p = set.starts[r]!; p + 1 < set.starts[r + 1]!; p++) {
            project(set.points[p * 2]!, set.points[p * 2 + 1]!, a, 0);
            project(set.points[p * 2 + 2]!, set.points[p * 2 + 3]!, b, 0);
            const [qx, qy] = nearestOnSegment(a[0]!, a[1]!, b[0]!, b[1]!, px, py);
            const distance = Math.hypot(qx - px, qy - py);
            if (distance <= reach && distance < (best?.distance ?? Infinity))
              best = { position: r, distance, at: [qx, qy] };
          }
        }
      }
    return best;
  }
}

/** The block of `size` blocks holding grid unit `u`, clamped to them. */
function blockOf(u: number, size: number): number {
  return Math.max(0, Math.min(size - 1, Math.floor(u / BLOCK)));
}

/** Whether ring `r` of `set` holds (u, v), by the even-odd rule along a ray to +u. */
function contains(set: Traced, r: number, u: number, v: number): boolean {
  const p = set.points;
  let inside = false;
  for (let k = set.starts[r]!, end = set.starts[r + 1]! - 1; k < end; k++) {
    const [au, av, bu, bv] = [p[k * 2]!, p[k * 2 + 1]!, p[k * 2 + 2]!, p[k * 2 + 3]!];
    if (av > v !== bv > v && u < au + ((v - av) / (bv - av)) * (bu - au)) inside = !inside;
  }
  return inside;
}

/** The point of segment a–b nearest p. */
function nearestOnSegment(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  px: number,
  py: number,
): [number, number] {
  const [dx, dy] = [bx - ax, by - ay];
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return [ax + t * dx, ay + t * dy];
}

/**
 * Contours of a field sampled on a grid: lines where it crosses
 * thresholds, or bands filled between them.
 *
 * ```ts
 * contour(field, { x: "x", y: "y", color: "density" })
 * contour(field, { x: "x", y: "y", color: "density", thresholds: [0.01, 0.05, 0.1], variant: "bands", colors: viridis })
 * ```
 */
export function contour<S extends Schema>(
  table: Table<S>,
  options: ContourOptions<S>,
): ChartMark<Frozen<ContourSpec>> {
  const spec: ContourSpec = {
    type: "contour",
    ...definedFields(options, [
      "x",
      "y",
      "color",
      "variant",
      "colorMidpoint",
      "stroke",
      "strokeWidth",
      "fillOpacity",
      "label",
      "facet",
      "panel",
      "id",
    ]),
  };
  const { thresholds, colors, colorDomain } = options;
  if (thresholds !== undefined)
    spec.thresholds = typeof thresholds === "number" ? thresholds : [...thresholds];
  if (colors) spec.colors = [...colors];
  if (colorDomain) spec.colorDomain = [...colorDomain];
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new ContourMark(spec, table as unknown as Table);
}
