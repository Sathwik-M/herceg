// The range navigator: a strip under the plot drawing the chart's marks over
// the whole x domain, with a window showing the x range in view. A chart's
// `navigator` option holds a Navigator, made by `rangeNavigator`; charts
// without one never load this module. The strip is a panel of the scene but
// not one of the model's views, so tooltips, the keyboard, and viewports
// never see it, and every renderer draws it. In the browser, sliders over
// the strip (dom/navigator.ts) move the window; they load on demand.

import type { NumericArray } from "../data/column.ts";
import { escapeXml, n } from "../draw/markup.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { textDrawing } from "../draw/text.ts";
import { mapValue } from "../lod/m4.ts";
import { Polyline } from "../lod/polyline.ts";
import { isLayoutMark, tablesOf, viewOf } from "../marks/layout-mark.ts";
import type { Frame, Mark } from "../marks/mark.ts";
import { rowOf, type Series, visibleRange } from "../marks/series.ts";
import { unionExtent } from "../marks/trace.ts";
import type { PositionScale } from "../scale/scale.ts";
import type {
  Drawing,
  Geometry,
  Panel,
  PathShape,
  PointGeometry,
  Rect,
  ShapesGeometry,
  TextGeometry,
} from "../scene/scene.ts";
import type { NavigatorSpec } from "../spec/spec.ts";
import { surface, type Theme } from "../theme.ts";
import { type AxisContext, type AxisPlan, createScale, usableDomain } from "./axis.ts";
import type { InspectedMark, Inspector } from "./inspect.ts";
import type { ChartConfig } from "./model.ts";

/** The strip's height when the options give none, in CSS pixels. */
const HEIGHT = 40;
/** The least height the options may give. */
const MIN_HEIGHT = 16;
/** Room between the x axis' labels (or the plot) and the strip. */
const GAP = 10;
/** The least height a plot keeps beside a strip; charts shorter than that have none. */
const MIN_PLOT = 30;
/** Room under the strip. */
const BOTTOM = 2;
/** Room inside the strip above and below what it draws. */
const PAD = 3;
/** Marks the strip draws by default, and the only ones it can. */
const DRAWN = new Set(["line", "area", "point", "bar", "candlestick"]);
/** The scene's key for the strip's panel. */
export const NAVIGATOR_PANEL = "navigator";

/**
 * How the model plans the x axis of its first x scale (group 0) along a plot
 * `width` pixels wide over `domain`: rounded and given room for glyphs, as
 * an unzoomed axis is, when `auto`.
 */
export type XPlan = (width: number, group: 0, domain: [number, number], auto: boolean) => AxisPlan;

/** What the browser's sliders read of the strip the last scene drew. */
export interface DrawnStrip {
  /** The strip, in CSS pixels from the chart's top left corner. */
  plot: Rect;
  /** Maps values over the whole x domain (or a view reaching past it) to the strip. */
  rail: PositionScale;
  /** The x range the plot shows, ascending: the strip's window. */
  shown: readonly [number, number];
}

/** A chart's model, as the strip reads it. */
interface Owner {
  readonly config: ChartConfig;
  /** The last scene's panels: a new list for each scene. */
  panels(): readonly object[];
}

/**
 * Makes the sliders of a chart (dom/navigator.ts), which read its strip as
 * last drawn, undefined once it has none.
 */
export type MakeControls<C> = (
  chart: C,
  strip: () => DrawnStrip | undefined,
) => {
  dispose(): void;
};

/** The sliders of a mounted chart, and the code they wait for. */
export interface NavigatorControls {
  /** Pending until the sliders' code has loaded; it rejects if that failed. */
  readonly loading: Promise<void> | undefined;
  dispose(): undefined;
}

/** What a chart keeps for its strip between scenes. */
interface StripState {
  /** What the cached overview was drawn for, and the overview. */
  key: string;
  config: ChartConfig | undefined;
  theme: Theme | undefined;
  measure: Frame["measure"] | undefined;
  overview: Geometry[];
  labels: TextGeometry | undefined;
  grid: number[];
  /** Buffers the overview's marks draw into, by stage and series key, kept across scenes. */
  buffers: Map<string, Polyline | Float32Array | Float64Array | Uint8ClampedArray<ArrayBuffer>>;
  /** The strip the last scene that had one drew, and that scene's panels. */
  drawn: DrawnStrip | undefined;
  of: readonly object[] | undefined;
}

/** Each chart's strip, by the model drawing it. */
const states = new WeakMap<object, StripState>();

/**
 * A range navigator for a chart's `navigator` option: a strip under the plot
 * drawing the chart's marks over the whole x domain, with a window showing
 * the x range in view. Dragging the window pans, dragging its edges zooms,
 * dragging elsewhere in the strip shows the range dragged over, and a double
 * click shows everything; the window's edges and the window itself are
 * sliders for the keyboard.
 *
 * ```ts
 * createChart(element, {
 *   marks: [line(prices, { x: "time", y: "close", id: "close" })],
 *   navigator: rangeNavigator({ height: 48 }),
 * });
 * ```
 */
export function rangeNavigator(options: NavigatorSpec = {}): Navigator {
  return new Navigator(options);
}

export class Navigator {
  /** The strip's height, at most a third of what the plot and the strip share. */
  readonly height: number;
  /** The ids of the marks the strip draws; undefined for every mark it can draw. */
  readonly marks: readonly string[] | undefined;
  readonly #spec: NavigatorSpec;

  constructor(options: NavigatorSpec = {}) {
    const { height = HEIGHT, marks } = options;
    if (!(typeof height === "number" && Number.isFinite(height) && height >= MIN_HEIGHT))
      throw new RangeError(
        `A navigator's height must be at least ${MIN_HEIGHT} pixels, not ${String(height)}`,
      );
    if (marks !== undefined) {
      if (!Array.isArray(marks) || marks.some((id) => typeof id !== "string"))
        throw new TypeError("A navigator's marks must be a list of mark ids");
      const repeated = marks.find((id, i) => marks.indexOf(id) !== i);
      if (repeated !== undefined)
        throw new TypeError(`A navigator lists the mark "${repeated}" twice`);
    }
    this.height = height;
    this.marks = marks && Object.freeze([...marks]);
    this.#spec = {
      ...(options.height !== undefined && { height }),
      ...(this.marks && { marks: this.marks }),
    };
  }

  /** The options as a spec holds them; adapters compare and serialize by them. */
  toJSON(): NavigatorSpec {
    return JSON.parse(JSON.stringify(this.#spec));
  }

  /**
   * Refuses what the strip cannot draw along: facets and panels (whose
   * checks refuse navigators, so the model asks only one of them), layout
   * marks, category x axes, marks placed along y, and named marks the chart
   * lacks or the strip cannot draw.
   */
  check(marks: readonly Mark[], options: ChartConfig): void {
    if (options.marks.some(isLayoutMark))
      throw new Error("Charts of a layout mark have no x axis for a navigator");
    for (const mark of marks) {
      const { type } = mark.spec;
      if (mark.channelKind("x") === "category")
        throw new Error(`A navigator needs a number or time x axis; a ${type} mark has categories`);
      if (mark.tooltip === "y")
        throw new Error(`A navigator moves along x; a ${type} mark placed along y cannot have one`);
    }
    for (const id of this.marks ?? []) {
      const mark = marks.find((m) => m.spec.id === id);
      if (!mark) throw new Error(`The navigator draws the mark "${id}", which the chart lacks`);
      if (!drawable(mark))
        throw new Error(
          `A navigator draws line, area, point, bar, and candlestick marks, not the ${mark.spec.type} mark "${id}"`,
        );
    }
  }

  /**
   * The room the strip takes at the bottom of a chart whose plot and strip
   * share `available` pixels of height: at most a third of them, and none
   * when the plot would keep less than MIN_PLOT pixels.
   */
  room(available: number): number {
    const height = Math.max(MIN_HEIGHT, Math.min(this.height, Math.floor(available / 3)));
    const room = GAP + height + BOTTOM;
    return available - room >= MIN_PLOT ? room : 0;
  }

  /**
   * The strip's panel for a scene of the chart `owner`, at the bottom of the
   * `room` pixels it took (see `room`): its marks and frame are those of
   * `inspector`, the chart's one panel; `plan` plans x over a domain as the
   * plot's axis is planned, along the plot's width, and `context` is the
   * plot's x axis.
   */
  panel(
    owner: Owner & { readonly height: number },
    inspector: Inspector,
    plan: XPlan,
    context: AxisContext,
    room: number,
  ): Panel {
    let state = states.get(owner);
    if (!state) {
      state = {
        key: "",
        config: undefined,
        theme: undefined,
        measure: undefined,
        overview: [],
        labels: undefined,
        grid: [],
        buffers: new Map(),
        drawn: undefined,
        of: undefined,
      };
      states.set(owner, state);
    }
    const { frame } = inspector;
    const { plot, theme } = frame;
    const height = room - GAP - BOTTOM;
    const strip: Rect = {
      x: plot.x,
      y: owner.height - BOTTOM - height,
      width: plot.width,
      height,
    };
    const shown = ascending(frame.x.domain);
    const { rail, labeled } = railPlan(
      inspector.marks,
      (domain, auto) => plan(plot.width, 0, domain, auto),
      context,
      shown,
    );
    const { scale } = rail;
    const drawn = this.#drawnMarks(inspector.marks);
    const key = JSON.stringify([
      labeled,
      scale.type,
      scale.domain,
      scale.range,
      strip,
      frame.pixelRatio,
      frame.y.type,
      inspector.rightFrame?.y.type,
      [...frame.hidden],
      drawn.flatMap(({ mark }) => [
        ...tablesOf(mark).map((table) => table.version),
        viewOf(mark)?.revision ?? -1,
      ]),
    ]);
    const same =
      key === state.key &&
      state.config === owner.config &&
      state.theme === theme &&
      state.measure === frame.measure;
    if (!same) {
      state.key = key;
      state.config = owner.config;
      state.theme = theme;
      state.measure = frame.measure;
      state.overview = overview(
        drawn,
        frame,
        inspector.rightFrame?.y,
        scale,
        strip,
        owner.config,
        context,
        state.buffers,
      );
      ({ grid: state.grid, labels: state.labels } = labeled
        ? stripTicks(rail, strip, frame)
        : { grid: [], labels: undefined });
    }
    state.drawn = { plot: strip, rail: scale, shown };
    state.of = owner.panels();
    const marks: Geometry[] = [...state.overview, frameShapes(strip, scale, shown, theme)];
    if (state.labels) marks.push(state.labels);
    return { key: NAVIGATOR_PANEL, plot: strip, grid: { x: state.grid, y: [] }, axes: [], marks };
  }

  /** The marks the strip draws, with their series in the plot. */
  #drawnMarks(marks: readonly InspectedMark[]): InspectedMark[] {
    const ids = this.marks;
    return marks.filter(({ mark }) =>
      ids ? ids.includes(mark.spec.id as string) : drawable(mark),
    );
  }

  /**
   * The sliders over the strip of a mounted chart, `chart`, whose model is
   * `owner`: made by the module `load` loads, which the browser runtime
   * gives, as this module reaches no DOM. `current`, the chart's sliders so
   * far, are kept, so that focus stays on them as options change.
   */
  mount<C>(
    current: NavigatorControls | undefined,
    load: () => Promise<{ controls: MakeControls<C> }>,
    chart: C,
    owner: Owner,
  ): NavigatorControls {
    if (current) return current;
    // A scene without a strip (the chart too short for one) leaves none.
    const strip = () => {
      const state = states.get(owner);
      return owner.config.navigator && state?.of === owner.panels() ? state.drawn : undefined;
    };
    let made: { dispose(): void } | undefined;
    let disposed = false;
    const handle: { loading: Promise<void> | undefined; dispose(): undefined } = {
      loading: undefined,
      // The strip's overview goes too, as the model's buffers do when the
      // chart is destroyed.
      dispose() {
        disposed = true;
        made?.dispose();
        states.delete(owner);
        return undefined;
      },
    };
    handle.loading = load()
      .then(({ controls }) => {
        if (!disposed) made = controls(chart, strip);
      })
      .finally(() => {
        handle.loading = undefined;
      });
    return handle;
  }
}

/**
 * Marks the strip can draw: lines, areas, vertical bars, and candlesticks,
 * drawn along x, and points with number or time y values.
 */
function drawable(mark: Mark): boolean {
  const { type } = mark.spec;
  if (type === "point") return mark.channelKind("y") !== "category";
  return DRAWN.has(type) && mark.tooltip === "x";
}

function ascending(domain: readonly [number, number]): [number, number] {
  return domain[0] <= domain[1] ? [domain[0], domain[1]] : [domain[1], domain[0]];
}

/**
 * The strip's x axis: the x domain of every mark, unzoomed, planned as the
 * plot's axis is when it shows everything, and widened to hold a view that
 * reaches past it; and whether it has values to label, as the plot's axis
 * has only with data or a configured domain.
 */
function railPlan(
  marks: readonly InspectedMark[],
  plan: (domain: [number, number], auto: boolean) => AxisPlan,
  context: AxisContext,
  shown: readonly [number, number],
): { rail: AxisPlan; labeled: boolean } {
  const { type, spec, breaks } = context;
  const log = type === "log";
  // As the model finds an unzoomed x domain: no mark is placed along y, so
  // every series counts, and zero only when the axis asks for it.
  let data = unionExtent(marks.map(({ mark, series }) => mark.xExtent(series, log, breaks)));
  if (spec?.zero && !log) data = unionExtent([data, [0, 0]]);
  let domain = usableDomain(spec?.domain ?? data, type);
  if (breaks) domain = breaks.showing(domain, spec?.domain !== undefined);
  const full = plan(domain, spec?.domain === undefined);
  const labeled = data !== undefined || spec?.domain !== undefined;
  const [lo, hi] = ascending(full.scale.domain);
  if (shown[0] >= lo && shown[1] <= hi) return { rail: full, labeled };
  const reach: [number, number] = [Math.min(lo, shown[0]), Math.max(hi, shown[1])];
  const reversed = full.scale.domain[0] > full.scale.domain[1];
  return { rail: plan(reversed ? [reach[1], reach[0]] : reach, false), labeled };
}

/**
 * The marks drawn small over the whole x domain into the strip: lines,
 * areas, bars, and candlesticks as they draw themselves (lines and areas
 * reduced to a few points per pixel column), points as a sample of one per
 * pixel. Buffers come from `buffers`, apart from the plot's.
 */
function overview(
  drawn: readonly InspectedMark[],
  frame: Frame,
  yRight: PositionScale | undefined,
  rail: PositionScale,
  strip: Rect,
  config: ChartConfig,
  context: AxisContext,
  buffers: StripState["buffers"],
): Geometry[] {
  const used = new Set<string>();
  const pooled = <T>(key: string, make: () => T, fits: (value: T) => boolean = () => true): T => {
    used.add(key);
    let value = buffers.get(key) as T | undefined;
    if (value === undefined || !fits(value)) {
      value = make();
      buffers.set(key, value as never);
    }
    return value;
  };
  const sized = <T extends { length: number }>(make: (length: number) => T) => {
    return (seriesKey: string, stage: string, length: number): T =>
      pooled(
        `${stage}|${seriesKey}`,
        () => make(Math.max(16, Math.ceil(length * 1.5))),
        (buffer) => buffer.length >= length,
      );
  };
  const theme: Theme = { ...frame.theme, lineWidth: 1, barRadius: 0 };
  const side = (right: boolean): Frame => ({
    ...frame,
    x: rail,
    y: yScale(
      drawn.filter(({ mark }) => (mark.spec.axis === "right") === right),
      (right ? yRight : frame.y)?.type ?? "linear",
      frame.hidden,
      rail,
      strip,
      right ? config.yRight : config.y,
      context,
    ),
    plot: strip,
    theme,
    clouds: false,
    keyed: false,
    polyline: (key, stage) => pooled(`${stage}|${key}`, () => new Polyline()),
    floats: sized((length) => new Float32Array(length)),
    doubles: sized((length) => new Float64Array(length)),
    bytes: sized((length) => new Uint8ClampedArray(length)),
  });
  const left = side(false);
  const right = drawn.some(({ mark }) => mark.spec.axis === "right") ? side(true) : left;
  const out = drawn.flatMap(({ mark, series, index }) => {
    const at = mark.spec.axis === "right" ? right : left;
    return mark.spec.type === "point"
      ? samplePoints(series, at)
      : mark.geometry(series, at, mark.spec.id ?? index);
  });
  for (const key of buffers.keys()) if (!used.has(key)) buffers.delete(key);
  return out;
}

/**
 * The strip's y scale for the marks on one side: their extent over the whole
 * x domain, or the axis' configured domain, from zero when it or a mark asks.
 */
function yScale(
  marks: readonly InspectedMark[],
  plotType: PositionScale["type"],
  hidden: ReadonlySet<string>,
  rail: PositionScale,
  strip: Rect,
  spec: ChartConfig["y"],
  x: AxisContext,
): PositionScale {
  const type = plotType === "log" || plotType === "time" ? plotType : "linear";
  const log = type === "log";
  const [x0, x1] = ascending(rail.domain);
  let stands = false;
  const data = unionExtent(
    marks.map(({ mark, series }) => {
      const visible = series.filter((s) => !hidden.has(s.key));
      if (mark.zero === "y" && visible.length > 0) stands = true;
      return mark.yExtent(visible, x0, x1, log, x.breaks);
    }),
  );
  const zero = (spec?.zero ?? stands) && !log && data;
  const domain = spec?.domain ?? (zero ? unionExtent([data, [0, 0]]) : data);
  const context: AxisContext = { type, spec, zone: x.zone, locale: x.locale };
  return createScale(context, usableDomain(domain, type), [
    strip.y + strip.height - PAD,
    strip.y + PAD,
  ]);
}

/**
 * Points as a sample: of the points falling in each CSS pixel of the strip,
 * the first, so the strip draws at most as many points as it has pixels.
 */
function samplePoints(series: readonly Series[], frame: Frame): PointGeometry[] {
  const { plot, x, y } = frame;
  const columns = Math.ceil(plot.width);
  const rows = Math.ceil(plot.height);
  const xMap = x.mapping();
  const yMap = y.mapping();
  const [x0, x1] = ascending(x.domain);
  const [y0, y1] = ascending(y.domain);
  const right = plot.x + plot.width;
  const bottom = plot.y + plot.height;
  const out: PointGeometry[] = [];
  for (const s of series) {
    if (frame.hidden.has(s.key)) continue;
    const [start, end] = s.sorted ? visibleRange(s, x0, x1) : [0, s.length];
    const occupied = frame.bytes(s.key, "occupied", columns * rows);
    occupied.fill(0, 0, columns * rows);
    const coords = frame.floats(s.key, "point", Math.min(end - start, columns * rows) * 2);
    let count = 0;
    for (let k = start; k < end; k++) {
      const row = rowOf(s, k);
      const vx = (s.x as NumericArray)[row]!;
      const vy = s.y[row]!;
      if (!placeable(vx, xMap.log) || !placeable(vy, yMap.log) || x.breaks?.hides(vx)) continue;
      // Points in the domains are in the strip, those on its ends in its
      // last pixels, though rounding may map them a hair past.
      if (!(vx >= x0 && vx <= x1 && vy >= y0 && vy <= y1)) continue;
      const px = Math.min(right, Math.max(plot.x, mapValue(xMap, vx)));
      const py = Math.min(bottom, Math.max(plot.y, mapValue(yMap, vy)));
      const column = Math.min(columns - 1, Math.floor(px - plot.x));
      const line = Math.min(rows - 1, Math.floor(py - plot.y));
      const cell = line * columns + column;
      if (occupied[cell]) continue;
      occupied[cell] = 1;
      coords[count * 2] = px;
      coords[count * 2 + 1] = py;
      count++;
    }
    out.push({
      kind: "point",
      draw: sampleDrawing,
      key: s.key,
      fill: s.color,
      fillOpacity: 1,
      opaque: true,
      // As sampleDrawing draws them, for PDF, which draws points itself:
      // squares 1.5 pixels wide, as wide as symbols of this radius.
      radius: 1.5 / Math.sqrt(Math.PI),
      symbol: "square",
      coords,
      count,
    });
  }
  return out;
}

/**
 * Path data of the sampled points, a small square each, kept for the
 * geometry: the strip draws one overview while the window moves.
 */
const samplePaths = new WeakMap<PointGeometry, string>();

function samplePath(mark: PointGeometry): string {
  let d = samplePaths.get(mark);
  if (d === undefined) {
    d = "";
    const c = mark.coords;
    for (let i = 0; i < mark.count; i++)
      d += `M${n(c[i * 2]! - 0.75)} ${n(c[i * 2 + 1]! - 0.75)}h1.5v1.5h-1.5z`;
    samplePaths.set(mark, d);
  }
  return d;
}

/**
 * The strip's sampled points, as squares of 1.5 pixels: smaller code than
 * the point drawing's symbols, which charts drawing lines would otherwise
 * carry for their navigator. PDF draws them as the points they are.
 */
const sampleDrawing: Drawing<PointGeometry> = {
  size: (mark) => mark.count,
  elements: (mark) => [{ tag: "path", attributes: { d: samplePath(mark), fill: mark.fill } }],
  svg: (mark) => `<path d="${samplePath(mark)}" fill="${escapeXml(mark.fill)}"/>`,
  canvas(context, mark) {
    context.fillStyle = mark.fill;
    const c = mark.coords;
    for (let i = 0; i < mark.count; i++)
      context.fillRect(c[i * 2]! - 0.75, c[i * 2 + 1]! - 0.75, 1.5, 1.5);
  },
};

function placeable(value: number, log: boolean): boolean {
  return Number.isFinite(value) && (!log || value > 0);
}

/** Room between one of the strip's labels and the next tick, in pixels. */
const LABEL_ROOM = 16;

/**
 * The strip's ticks and their labels: every tick, or every second, third,
 * ..., so that each label fits well before the next tick kept, each just
 * right of its grid line near the top; the last is left out when it would
 * pass the end.
 */
function stripTicks(
  rail: AxisPlan,
  strip: Rect,
  frame: Frame,
): { grid: number[]; labels: TextGeometry | undefined } {
  const { theme, measure } = frame;
  const font = `${theme.fontSize}px ${theme.font}`;
  // In screen order, which reversed axes run against.
  const ticks = rail.ticks
    .map((tick, i) => ({ at: rail.scale.map(tick), label: rail.labels[i]! }))
    .filter(({ at }) => at >= strip.x && at <= strip.x + strip.width)
    .sort((a, b) => a.at - b.at)
    .map((tick) => ({ ...tick, width: measure(tick.label, font) }));
  let every = 1;
  const fits = (k: number) =>
    ticks.every(
      ({ at, width }, i) =>
        i % k !== 0 || i + k >= ticks.length || at + width + LABEL_ROOM <= ticks[i + k]!.at,
    );
  while (every < ticks.length && !fits(every)) every++;
  const kept = ticks.filter((_, i) => i % every === 0);
  const grid = kept.map(({ at }) => at);
  const shown = kept.filter(({ at, width }) => at + 4 + width + 2 <= strip.x + strip.width);
  // Labels sit in the strip's top, and a strip too short for its text has none.
  const half = Math.ceil(theme.fontSize * 0.6);
  if (shown.length === 0 || strip.height < 2 * half + 4) return { grid, labels: undefined };
  const y = strip.y + half + 2;
  return {
    grid,
    labels: {
      kind: "text",
      draw: textDrawing,
      key: "navigator-labels",
      fill: theme.muted,
      anchor: "start",
      halo: true,
      coords: Float32Array.from(shown.flatMap(({ at }) => [at + 4, y])),
      labels: shown.map(({ label }) => label),
      count: shown.length,
    },
  };
}

/**
 * The strip's frame, the parts outside the window faded, the window's
 * outline, and a grip at each of its edges.
 */
function frameShapes(
  strip: Rect,
  rail: PositionScale,
  shown: readonly [number, number],
  theme: Theme,
): ShapesGeometry {
  const { x, y, width, height } = strip;
  const right = x + width;
  const ends = [rail.map(shown[0]), rail.map(shown[1])].map((px) =>
    Math.min(right, Math.max(x, px)),
  );
  const from = Math.min(...ends);
  const to = Math.max(...ends);
  const back = surface(theme);
  const rect = (x0: number, x1: number, y0 = y, y1 = y + height) =>
    `M${n(x0)} ${n(y0)}H${n(x1)}V${n(y1)}H${n(x0)}Z`;
  const path = (d: string, fill: string, stroke?: string, opacity = 1): PathShape => ({
    d,
    fill,
    stroke,
    strokeWidth: stroke ? 1 : 0,
    opacity,
    dash: undefined,
  });
  const shapes: PathShape[] = [
    path(rect(x + 0.5, right - 0.5, y + 0.5, y + height - 0.5), "none", theme.grid),
  ];
  if (from > x) shapes.push(path(rect(x, from), back, undefined, 0.6));
  if (to < right) shapes.push(path(rect(to, right), back, undefined, 0.6));
  shapes.push(path(rect(from + 0.5, to - 0.5, y + 0.5, y + height - 0.5), "none", theme.axis));
  // Grips: a small bar at each edge, kept inside the strip.
  const grip = Math.min(18, Math.round(height * 0.5));
  const top = y + Math.round((height - grip) / 2);
  for (const edge of [from, to]) {
    const at = Math.min(right - 4, Math.max(x + 4, Math.round(edge)));
    shapes.push(path(rect(at - 3.5, at + 3.5, top + 0.5, top + grip - 0.5), back, theme.axis));
  }
  return {
    kind: "shapes",
    draw: shapesDrawing,
    key: "navigator-frame",
    shapes,
    font: `${theme.fontSize}px ${theme.font}`,
    fontSize: theme.fontSize,
  };
}
