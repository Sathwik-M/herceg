// What lays a chart out in panels: a facet, which splits rows by category
// values, or subplots, whose marks name their panel. The model reads either
// through these types; their code loads only with a facet or panels.

import type { LayoutMark } from "../marks/layout-mark.ts";
import {
  type BandContext,
  type BandList,
  type Bands,
  type ChartMark,
  type Mark,
  type RowParts,
  usesY,
} from "../marks/mark.ts";
import { type BandPlaces, rowOf, type Series } from "../marks/series.ts";
import type { Rect, SceneText } from "../scene/scene.ts";
import type { AxisSpec, ChartSpec, ResolveSpec, ScaleResolution, XAxisSpec } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";

/** Where a chart's panels go: a grid of `columns` by `rows`, and the room headers take. */
export interface PanelGrid {
  columns: number;
  rows: number;
  /** Above every panel, for wrapped facets and titled subplots. */
  header: number;
  /** Above the top row and beside the last column, for a grid's columns and rows. */
  columnHeader: number;
  rowHeader: number;
  /** Rows' heights relative to each other; equal without them. */
  rowWeights?: readonly number[] | undefined;
  /** Columns' widths relative to each other; equal without them. */
  columnWeights?: readonly number[] | undefined;
  /**
   * With panels drawing layout marks, which have no axes, the panels that
   * show a shared x scale's labels: the lowest with axes of each column.
   * Without it, the lowest of each column.
   */
  lowest?: readonly boolean[] | undefined;
  /** Whether those labels go between rows, above panels drawing layout marks. */
  between?: boolean | undefined;
}

/** The panels of a scene: their keys, each one's marks and series, and every mark's across panels. */
export interface PanelSplit {
  keys: string[];
  /** What names each panel: its facet values, or a subplot's title. */
  values: string[][];
  /** Each facet field's values in order of first appearance: a grid's rows, then its columns. */
  dimensions: string[][];
  /** Per panel, every mark (in the chart's order) with its series there. */
  panels: MarkSeries[][];
  /** Per panel and mark, whether the mark draws there; every mark does, without it. */
  members?: boolean[][];
  /** Each mark's series in all panels; marks that repeat, once. */
  all: MarkSeries[];
  /**
   * Per panel, the layout mark it holds, if any: such a panel draws only
   * that mark, without axes.
   */
  items?: (PanelItem | undefined)[];
  /**
   * With categories resolved per panel along an axis, each panel's bands on
   * it: its group's (see PanelBands).
   */
  bands?: { x?: readonly BandList[]; y?: readonly BandList[] };
}

/** A layout mark a panel holds: the mark, its index among the chart's marks, and its rows there. */
export interface PanelItem {
  mark: LayoutMark;
  index: number;
  /** The rows of the mark's table the panel draws, ascending; all of them when undefined. */
  rows: Uint32Array | undefined;
}

/**
 * What preparing panels' series reads of the chart: its size, which the
 * panels must fit, the series its legend hid, which stacks count as zero,
 * its `resolve`, and its marks, of which layout marks have panels of their own.
 */
export interface PanelChart extends PanelRoom {
  readonly hidden: ReadonlySet<string>;
  readonly config: Pick<ChartSpec, "resolve"> & { readonly marks: readonly ChartMark[] };
}

/** A chart's size in CSS pixels, which its panels must fit. */
export interface PanelRoom {
  readonly width: number;
  readonly height: number;
}

/** What goes between rows of panels besides y labels, as the chart lays out its x axes. */
export interface RowSpace {
  /** Whether x labels go under every panel: x is resolved per panel or per row. */
  xBetween: boolean;
  /** Whether panels have x scales of their own, whose titles go under their own rows. */
  ownX: boolean;
  /** Whether any panel shows x labels. */
  showX: boolean;
  /** The room under a plot before the x labels' line of text. */
  xLabels: number;
  lineHeight: number;
  /** An x title's room. */
  xTitle: number;
}

/**
 * The room between rows of `panels` placed as `grid` says. A wrapped
 * facet's panels each have a header with their value, and rows leave room
 * below for the x labels of panels above an empty cell. A grid of facets
 * has a column per value of its column field, headed once above the top
 * row, and a row per value of its row field, headed once beside the last
 * column. Rows leave room between them for the y labels at their ends, and
 * for x labels and titles between them: an x scale's own title, or the
 * shared one above a layout mark's panel.
 */
export function rowGap(grid: PanelGrid, panels: number, space: RowSpace): number {
  const { rows, columns, header, between } = grid;
  const { xBetween, ownX, showX, xLabels, lineHeight, xTitle } = space;
  if (rows <= 1) return 0;
  const title = ownX || between ? xTitle : 0;
  if ((xBetween || between) && showX)
    return xLabels + lineHeight + title + (header ? 8 : Math.ceil(lineHeight / 2) + 4);
  if (!header) return lineHeight + 10;
  const aboveEmpty = showX && panels % columns !== 0;
  return (aboveEmpty ? xLabels + lineHeight + title : Math.ceil(lineHeight / 2)) + 8;
}

/** Smallest plot side, in pixels, of a panel among several. */
const MIN_PANEL = 20;

/** Refuses `panels` in rows of `columns` that do not fit `room`, saying what to do: `remedy`. */
function tooSmall(panels: number, columns: number, room: PanelRoom, remedy: string): RangeError {
  const rows = Math.ceil(panels / columns);
  return new RangeError(
    `${panels} panels in ${rows} rows of ${columns} do not fit a ${room.width}×${room.height} chart; make it larger or ${remedy}`,
  );
}

/**
 * Throws when `panels` in `rows` and `columns` could never fit `room`, so
 * that panels are refused before they are listed.
 */
export function checkFit(
  { rows, columns }: { rows: number; columns: number },
  panels: number,
  room: PanelRoom,
  remedy: string,
): void {
  if (rows > room.height / MIN_PANEL || columns > room.width / MIN_PANEL)
    throw tooSmall(panels, columns, room, remedy);
}

/**
 * `free` pixels shared by `count` rows or columns of `panels` in rows of
 * `columns`, equally or by `weights` (scaled to the largest first, so huge
 * ones cannot overflow); throws when one of several panels would be less
 * than MIN_PANEL pixels a side.
 */
export function trackSizes(
  free: number,
  count: number,
  weights: readonly number[] | undefined,
  panels: number,
  columns: number,
  room: PanelRoom,
  remedy: string,
): number[] {
  const largest = weights ? Math.max(...weights) : 1;
  const share = (k: number) => (weights ? weights[k]! / largest : 1);
  let total = 0;
  for (let k = 0; k < count; k++) total += share(k);
  const sizes = Array.from({ length: count }, (_, k) => (free * share(k)) / total);
  if (panels > 1 && Math.min(...sizes) < MIN_PANEL) throw tooSmall(panels, columns, room, remedy);
  return sizes;
}

/** The chart options a layout checks; the x axis as panels read it, breaks aside. */
export type LayoutOptions = Pick<ChartSpec, "resolve" | "interaction" | "y" | "yRight"> & {
  x?: (AxisSpec & Pick<XAxisSpec, "seams">) | undefined;
  /** Layouts refuse a navigator, which the model then need not check. */
  navigator?: object | boolean | undefined;
};

/**
 * Splits a chart's series into panels, keeping what it can from one scene
 * to the next, and refuses panels the chart has no room for; `bands` are
 * the chart's band axes' bands, in order, and `context` what labels them
 * (and the zone of calendar bins).
 */
export interface PanelSplitter {
  split(
    base: readonly MarkSeries[],
    chart: PanelChart,
    bands: Bands,
    context: BandContext,
  ): PanelSplit;
}

export interface PanelLayout {
  /** Rejects marks along axes, layout marks, and options the panels cannot draw. */
  check(marks: readonly Mark[], options: LayoutOptions, layouts?: readonly LayoutMark[]): void;
  /** Whether the panels split the mark's rows (see `Mark.series`), rather than draw it whole. */
  splits(mark: Mark): boolean;
  /** How panels share y when the chart's `resolve` does not say. */
  readonly yDefault: ScaleResolution;
  splitter(): PanelSplitter;
  /** How the panels share `axis`' scale under the chart's `resolve` (see `resolutionOf`). */
  resolution(axis: PanelAxis, resolve: ResolveSpec | undefined): ScaleResolution;
  grid(split: PanelSplit, lineHeight: number): PanelGrid;
  /**
   * The headers panel `index`, named by `values`, at `plot`, carries;
   * `aside` is the room right of it its right axis' labels take.
   */
  headers(
    index: number,
    values: readonly string[],
    row: number,
    column: number,
    plot: Rect,
    grid: PanelGrid,
    fit: (text: string, room: number) => string,
    aside: number,
  ): SceneText[];
  /** What to do when the panels do not fit, for the error saying so. */
  readonly remedy: string;
  /** See `rowGap`. */
  rowGap(grid: PanelGrid, panels: number, space: RowSpace): number;
  /** See `trackSizes`: the sizes of a grid's rows or columns, refusing panels too small. */
  tracks(
    free: number,
    count: number,
    weights: readonly number[] | undefined,
    panels: number,
    columns: number,
    room: PanelRoom,
  ): number[];
  /** Panel `index`'s `axis` settings: the chart's, with the panel's own. */
  panelAxis(axis: PanelAxis, index: number, chart: AxisSpec | undefined): AxisSpec | undefined;
  /**
   * The groups of panels sharing `axis`' scale (see `groups`), each with its
   * axis: the chart's settings `chart` with its first panel's own, and its
   * type, the chart's `chartType` or (subplots) its own marks'.
   */
  groups(
    resolution: ScaleResolution,
    split: PanelSplit,
    columns: number,
    axis: PanelAxis,
    chart: AxisSpec | undefined,
    chartType: AxisType,
  ): ScaleGroups;
  /** See `across`. */
  across(
    split: PanelSplit,
    groupOf: readonly number[],
    by: readonly number[],
  ): [number, MarkSeries[]][][];
  /** A sentence naming the panels, up to `max` of their labels. */
  describe(labels: readonly string[], max: number): string;
  /** See `annotations`. */
  annotations(
    views: readonly AnnotatedPanel[],
    marks: readonly Mark[],
    describe: DescribeAnnotation,
    panel?: string,
  ): string[];
}

/** A panel of the last scene as its annotations' summaries read it: its marks there. */
export interface AnnotatedPanel {
  key: string;
  label: string;
  inspector: { readonly marks: readonly MarkSeries[] };
}

/** A mark's sentences, as panel `panel` formats values (the first drawing it without), of `rows`. */
export type DescribeAnnotation = (mark: Mark, panel?: string, rows?: RowParts) => string | string[];

/** Panels' own annotations described, at most this many panels' in a chart's summary. */
const ANNOTATED = 20;

/**
 * Sentences describing annotations (marks with `describe`) in a chart's
 * panels. With `panel`, of what that panel alone draws: its rows of
 * annotations that facets split (`MarkSeries.rows`), and in subplots the
 * annotations naming it. Without, every annotation: what every panel draws
 * once, then what panels draw alone after their names, up to ANNOTATED panels.
 */
export function annotations(
  views: readonly AnnotatedPanel[],
  marks: readonly Mark[],
  describe: DescribeAnnotation,
  subplots: boolean,
  panel?: string,
): string[] {
  const alone = new Set<Mark>();
  const own = ({ key, inspector }: AnnotatedPanel) =>
    inspector.marks.flatMap(({ mark, rows }) => {
      if (!mark.describe || !(rows || (subplots && mark.spec.panel === key))) return [];
      alone.add(mark);
      return describe(mark, key, rows);
    });
  if (panel !== undefined) {
    const view = views.find(({ key }) => key === panel);
    return view ? own(view) : [];
  }
  const named = views.flatMap((view) => {
    const sentences = own(view);
    return sentences.length > 0 ? [`${view.label}: ${sentences.join(" ")}`] : [];
  });
  if (named.length > ANNOTATED)
    named.splice(ANNOTATED, Infinity, `Annotations in ${named.length - ANNOTATED} more panels.`);
  return [...marks.flatMap((mark) => (alone.has(mark) ? [] : describe(mark))), ...named];
}

/** A panel's axes: x, and the left and right y. */
export type PanelAxis = "x" | "y" | "yRight";

/**
 * How panels share `axis`' scale under `resolve`: x shared by default, y as
 * the layout's `yDefault` says, and the right y as the left.
 */
export function resolutionOf(
  axis: PanelAxis,
  resolve: ResolveSpec | undefined,
  yDefault: ScaleResolution,
): ScaleResolution {
  if (axis === "x") return resolve?.x ?? "shared";
  const y = resolve?.y ?? yDefault;
  return axis === "y" ? y : (resolve?.yRight ?? y);
}

/**
 * The y axes a panel drawing `marks` has, as the model gives them: the
 * right one when a mark with `axis: "right"` places values along y, and the
 * left one unless every mark that does is on the right.
 */
export function yAxesOf(marks: readonly Mark[]): { left: boolean; right: boolean } {
  let [left, right] = [false, false];
  for (const mark of marks) {
    if (!usesY(mark)) continue;
    if (mark.spec.axis === "right") right = true;
    else left = true;
  }
  return { left: left || !right, right };
}

/** Whether a mark is on the side of y axis `axis`: every mark is along x. */
export function onAxis(mark: Mark, axis: PanelAxis): boolean {
  return axis === "x" || (mark.spec.axis === "right") === (axis === "yRight");
}

/** Groups of panels sharing a scale, with each group's axis: its settings and type. */
export interface ScaleGroups extends PanelGroups {
  axes: { type: AxisType; spec: AxisSpec | undefined }[];
}

/** Panels sharing a scale: each panel's group, and each group's marks and name. */
export interface PanelGroups {
  groupOf: number[];
  /**
   * Each group's first panel with axes, whose settings its axis takes (its
   * first panel when none has, all drawing layout marks).
   */
  first: number[];
  drawn: MarkSeries[][];
  /**
   * Its panels' keys, so a group whose panels change is another group; on
   * an axis of their own categories, and the number of those, as a group
   * whose categories change places other categories at its band indices.
   */
  keys: string[];
}

/**
 * The groups of a split's panels that share a scale along `axis` under
 * `resolution` (each panel alone, or the panels of a row or of a column, in
 * rows of `columns`): each panel's group, and what each group's panels draw
 * on that axis' side. A right axis' group takes its settings from its first
 * panel drawing a mark on it.
 */
export function groups(
  resolution: ScaleResolution,
  split: PanelSplit,
  columns: number,
  axis: PanelAxis,
): PanelGroups {
  const groupOf = groupsOf(resolution, split.panels.length, columns);
  const drawn = drawnBy(split, groupOf, axis) as MarkSeries[][];
  const members: (string | number)[][] = drawn.map(() => []);
  const first = drawn.map(() => -1);
  const right = axis === "yRight";
  groupOf.forEach((g, i) => {
    members[g]!.push(split.keys[i]!);
    if (first[g]! >= 0 || split.items?.[i]) return;
    // A y group's settings are its first panel's that has the axis.
    if (axis !== "x") {
      const drawn = split.panels[i]!.flatMap(({ mark }, m) => (drawsAt(split, i, m) ? mark : []));
      if (!yAxesOf(drawn)[right ? "right" : "left"]) return;
    }
    first[g] = i;
  });
  // Categories are on the left axis only.
  const lists = right ? undefined : split.bands?.[axis];
  return {
    groupOf,
    first: first.map((at, g) => (at < 0 ? groupOf.indexOf(g) : at)),
    drawn,
    keys: members.map((keys, g) =>
      JSON.stringify(lists ? [...keys, numbers.get(lists[groupOf.indexOf(g)]!)!] : keys),
    ),
  };
}

/** The group of each of `count` panels in rows of `columns` that share a scale under `resolution`. */
export function groupsOf(resolution: ScaleResolution, count: number, columns: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    resolution === "independent"
      ? i
      : resolution === "rows"
        ? Math.floor(i / columns)
        : resolution === "columns"
          ? i % columns
          : 0,
  );
}

/**
 * Splits each group of `groupOf` by the groups of `by` its panels are in
 * (y scales by x scales): per group, each such `by` group with what the
 * panels in both draw.
 */
export function across(
  split: PanelSplit,
  groupOf: readonly number[],
  by: readonly number[],
): [number, MarkSeries[]][][] {
  // The pairs of groups that have panels, numbered as they first appear.
  const numbers = new Map<string, number>();
  const pairs: [number, number][] = [];
  const pairOf = groupOf.map((g, i) => {
    const key = `${g} ${by[i]}`;
    let at = numbers.get(key);
    if (at === undefined) {
      at = pairs.length;
      numbers.set(key, at);
      pairs.push([g, by[i]!]);
    }
    return at;
  });
  const drawn = drawnBy(split, pairOf);
  const parts: [number, MarkSeries[]][][] = [];
  pairs.forEach(([g, h], k) => {
    const group = parts[g] ?? [];
    group.push([h, drawn[k]!]);
    parts[g] = group;
  });
  return parts;
}

/**
 * What the panels of each group draw, for panels grouped by `groupOf`: the
 * marks drawn in any of them, in the chart's order, with their series
 * there (and annotations' rows, each panel's a part); undefined for a group
 * without panels.
 */
function drawnBy(
  split: PanelSplit,
  groupOf: readonly number[],
  axis: PanelAxis = "x",
): (MarkSeries[] | undefined)[] {
  const drawn: ((MarkSeries & { rows?: Uint32Array[] }) | undefined)[][] = [];
  split.panels.forEach((marks, i) => {
    const at = groupOf[i]!;
    drawn[at] ??= marks.map(() => undefined);
    const group = drawn[at];
    marks.forEach(({ mark, series, rows }, m) => {
      if (!drawsAt(split, i, m) || !onAxis(mark, axis)) return;
      group[m] ??= rows ? { mark, series: [], rows: [] } : { mark, series: [] };
      const entry = group[m];
      // A mark with no rows in a panel adds nothing to its group, not even
      // the zero a bar stands on; a mark repeated in every panel, once.
      for (const s of series) if (s.length > 0 && !entry.series.includes(s)) entry.series.push(s);
      if (rows) entry.rows?.push(...rows);
    });
  });
  return Array.from(drawn, (group) => group?.filter((entry) => entry !== undefined));
}

/** Whether panel `i` of a split draws its mark `m` (subplots draw only the marks naming them). */
function drawsAt(split: PanelSplit, i: number, m: number): boolean {
  return !split.members || split.members[i]![m]!;
}

/**
 * The panels of `split`, in rows of `columns`, that label a shared x axis
 * when panels draw layout marks, which have no axes: the lowest of each
 * column with axes; and whether such a panel is above a layout mark's.
 */
export function lowestWithAxes(
  split: PanelSplit,
  columns: number,
): Pick<PanelGrid, "lowest" | "between"> {
  const { items } = split;
  if (!items) return {};
  const lowest = items.map(() => false);
  const seen = new Set<number>();
  let between = false;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i] || seen.has(i % columns)) continue;
    seen.add(i % columns);
    lowest[i] = true;
    if (i + columns < items.length) between = true;
  }
  return { lowest, between };
}

/** Layout marks that can draw in a panel; maps, networks, and 3D charts have charts to themselves. */
const IN_PANELS = new Set(["pie", "treemap", "sunburst", "gauge", "funnel", "radar", "sankey"]);

/** Refuses layout marks panels cannot draw yet. */
export function checkLayouts(layouts: readonly LayoutMark[]): void {
  for (const { spec } of layouts)
    if (!IN_PANELS.has(spec.type))
      throw new Error(`Charts of a ${spec.type} mark cannot have facets or panels yet`);
}

/**
 * Refuses options for an x axis in a chart whose panels all draw layout
 * marks, the first of `type`: they have no axes.
 */
export function refuseAxes(type: string, options: LayoutOptions): void {
  const { zoom, brush, sync } = options.interaction ?? {};
  if (zoom || brush || sync || options.x?.seams)
    throw new Error(
      `Charts of a ${type} mark have no x axis to zoom, brush, sync, or mark seams on`,
    );
}

/**
 * Refuses what panels with categories of their own (`resolve` other than
 * "shared" on a category axis) cannot do yet: sync (a band index means
 * another category in each panel), and brush along a y axis of such
 * categories. Every mark banding an axis reads its positions through the
 * panels' places (see PanelBands).
 */
export function checkBands(
  marks: readonly Mark[],
  options: LayoutOptions,
  yDefault: ScaleResolution,
): void {
  for (const axis of ["x", "y"] as const) {
    const resolution = options.resolve?.[axis] ?? (axis === "x" ? "shared" : yDefault);
    if (resolution === "shared" || !marks.some((mark) => mark.channelKind(axis) === "category"))
      continue;
    const { brush, sync } = options.interaction ?? {};
    if (sync)
      throw new Error(
        `Charts whose panels have categories of their own (resolve.${axis}) cannot be synced yet`,
      );
    if (axis === "y" && brush !== undefined && brush !== "x")
      throw new Error("Charts whose panels have y categories of their own can brush along x only");
  }
}

/** Band lists of groups of panels, numbered: a list of other keys has another number. */
const numbers = new WeakMap<BandList, number>();
let numbered = 0;

/** A group's bands: the chart bands its panels hold, and where each is among them. */
interface GroupBands {
  /** The chart's bands they were taken from. */
  chart: BandList;
  /** The chart bands the group's panels hold, ascending. */
  held: Int32Array;
  list: BandList;
  /** Undefined when they are the chart's first bands, each at its own place. */
  places: BandPlaces | undefined;
}

/**
 * Categories resolved per panel (`resolve` other than "shared" on a band
 * axis): each group of panels sharing the axis gets the chart's bands that
 * the rows its panels draw hold, in the chart's order, and every series
 * banding that axis reads its rows' chart band indices through their
 * places there (`Series.places`), so no panel copies or remaps a table's
 * rows. Marks drawn whole (facet repeats, subplots) count all their rows in
 * every panel they draw in. Both axes may be resolved apart (heatmaps,
 * points over two category fields). A chart keeps one, so groups keep
 * their bands while they are unchanged.
 */
export class PanelBands {
  /**
   * Each axis' groups' bands as of the last split, by their panels' keys: a
   * group of other panels is another.
   */
  readonly #groups = { x: new Map<string, GroupBands>(), y: new Map<string, GroupBands>() };
  /**
   * Per axis, the chart bands rows hold, by the rows (or the whole column)
   * and their band indices: a heatmap's rows are banded along both.
   */
  readonly #held = {
    x: new WeakMap<object, { bands: Series["x"]; held: Int32Array }>(),
    y: new WeakMap<object, { bands: Series["x"]; held: Int32Array }>(),
  };
  /** A flag per chart band, cleared after each use. */
  #seen = new Uint8Array(0);

  /**
   * Gives `split`'s panels, in rows of `columns`, their groups' bands along
   * the axes whose categories they resolve apart, if any, from the chart's
   * `bands`; `yDefault` is how they share y unless the chart's `resolve` says.
   */
  place(
    split: PanelSplit,
    columns: number,
    bands: Bands,
    resolve: ResolveSpec | undefined,
    yDefault: ScaleResolution,
    context: BandContext,
  ): void {
    const resolution = { x: resolve?.x ?? "shared", y: resolve?.y ?? yDefault };
    const axes = (["x", "y"] as const).flatMap((axis) => {
      const chart = bands[axis];
      if (chart && resolution[axis] !== "shared")
        return [
          { axis, ...this.#placeAxis(split, columns, chart, resolution[axis], axis, context) },
        ];
      this.#groups[axis].clear();
      return [];
    });
    // Series share a copy per pair of groups, as they share the groups'
    // places. Their chart band indices may ascend where their places do not
    // reach the panel's domain, so they are searched as unsorted.
    const copies = new Map<string, Map<Series, Series>>();
    split.panels = split.panels.map((marks, p) => {
      marks.forEach(({ mark }, m) => {
        if (mark.resolveBands && split.members?.[p]?.[m] !== false)
          mark.resolveBands({
            x: split.bands?.x?.[p] ?? bands.x,
            y: split.bands?.y?.[p] ?? bands.y,
          });
      });
      const at = axes.map(({ groupOf, groups }) => groups[groupOf[p]!]!.places);
      if (at.every((places) => !places)) return marks;
      const pair = axes.map(({ groupOf }) => groupOf[p]).join();
      const copied = copies.get(pair) ?? new Map<Series, Series>();
      copies.set(pair, copied);
      return marks.map((entry) => {
        const { mark, series } = entry;
        // Only the axes a mark bands: its other positions are values.
        const own = axes.flatMap(({ axis }, i) =>
          at[i] && mark.channelKind(axis) === "category" ? [[axis, at[i]] as const] : [],
        );
        if (own.length === 0) return entry;
        const places = Object.fromEntries(own);
        return {
          ...entry,
          series: series.map((s) => {
            let copy = copied.get(s);
            if (!copy) {
              copy = { ...s, places, sorted: false };
              copied.set(s, copy);
            }
            return copy;
          }),
        };
      });
    });
  }

  /**
   * The groups of `split`'s panels along `axis` under `resolution`, and each
   * group's bands from the chart's `chart`; sets the panels' band lists.
   */
  #placeAxis(
    split: PanelSplit,
    columns: number,
    chart: BandList,
    resolution: ScaleResolution,
    axis: "x" | "y",
    context: BandContext,
  ): { groupOf: number[]; groups: GroupBands[] } {
    const count = chart.keys.length;
    let index: Map<string, number> | undefined;
    if (this.#seen.length < count) this.#seen = new Uint8Array(count);
    const groupOf = groupsOf(resolution, split.panels.length, columns);
    const panelsOf: number[][] = [];
    groupOf.forEach((g, p) => {
      panelsOf[g] ??= [];
      panelsOf[g].push(p);
    });
    const last = this.#groups[axis];
    const kept = new Map<string, GroupBands>();
    const groups = panelsOf.map((panels) => {
      const found: number[] = [];
      for (const p of panels)
        split.panels[p]!.forEach(({ mark, series }, m) => {
          if (split.members?.[p]?.[m] === false || mark.channelKind(axis) !== "category") return;
          // Whole-table marks without series contribute their bands directly.
          if (series.length === 0 && mark.resolveBands) {
            const keys = mark.bands?.(axis, context)?.keys;
            if (keys?.length) index ??= new Map(chart.keys.map((key, i) => [key, i]));
            for (const key of keys ?? []) {
              const band = index!.get(key);
              if (band !== undefined) found.push(band);
            }
          }
          for (const s of series)
            for (const band of this.#rowBands(s, axis, count)) found.push(band);
        });
      const members = JSON.stringify(panels.map((p) => split.keys[p]));
      const group = this.#group(last.get(members), chart, this.#distinct(found).sort());
      kept.set(members, group);
      return group;
    });
    this.#groups[axis] = kept;
    split.bands = { ...split.bands, [axis]: groupOf.map((g) => groups[g]!.list) };
    return { groupOf, groups };
  }

  /** A group's bands for `held`, keeping its `last` ones, or their list, while they are the same. */
  #group(last: GroupBands | undefined, chart: BandList, held: Int32Array): GroupBands {
    if (last?.chart === chart && same(last.held, held)) return last;
    const keys = Array.from(held, (band) => chart.keys[band]!);
    const labels = Array.from(held, (band) => chart.labels[band]!);
    // Bands at their own places need none (as when every panel holds all of them).
    const places = held.every((band, place) => band === place) ? undefined : new Places(held);
    const sameKeys = last !== undefined && same(last.list.keys, keys);
    if (sameKeys && same(last.list.labels, labels)) return { chart, held, list: last.list, places };
    // Frozen: axes share the labels with the chart's panels, which show them to applications.
    const list = { keys, labels: Object.freeze(labels) };
    // Labels alone changing (another locale) leaves the bands the same.
    numbers.set(list, sameKeys ? numbers.get(last.list)! : ++numbered);
    return { chart, held, list, places };
  }

  /**
   * The chart bands the rows of `s` hold, found once per rows and band
   * indices: facets split a table's rows once per version, and series drawn
   * whole read whole columns.
   */
  #rowBands(s: Series, axis: "x" | "y", count: number): Int32Array {
    const bands = s[axis];
    const key = s.rows ?? bands;
    const cached = this.#held[axis].get(key);
    if (cached?.bands === bands) return cached.held;
    const seen = this.#seen;
    const found: number[] = [];
    for (let k = 0; k < s.length; k++) {
      const band = bands[rowOf(s, k)]!;
      if (band < 0 || band >= count || seen[band]) continue;
      seen[band] = 1;
      found.push(band);
    }
    for (const band of found) seen[band] = 0;
    const held = Int32Array.from(found);
    this.#held[axis].set(key, { bands, held });
    return held;
  }

  /** The distinct bands of `bands`, in order of first appearance. */
  #distinct(bands: readonly number[]): Int32Array {
    const seen = this.#seen;
    const out: number[] = [];
    for (const band of bands) {
      if (seen[band]) continue;
      seen[band] = 1;
      out.push(band);
    }
    for (const band of out) seen[band] = 0;
    return Int32Array.from(out);
  }
}

/**
 * Groups whose bands span at most this many chart bands, or this many times
 * as many as they hold, look places up in an array over the span.
 */
const SPAN = 4096;
const SPREAD = 8;

/**
 * Where chart bands are among the ascending ones a group holds: by an
 * array over the chart bands from its first to its last, when that is
 * short or they are close together (as in data sorted by panel), else by a
 * binary search of those it holds, so many panels of few categories each
 * keep nothing as long as the chart's band list per panel.
 */
class Places implements BandPlaces {
  readonly #held: Int32Array;
  readonly #first: number;
  readonly #span: Int32Array | undefined;

  constructor(held: Int32Array) {
    this.#held = held;
    this.#first = held[0] ?? 0;
    const length = held.length && held[held.length - 1]! - this.#first + 1;
    if (length > Math.max(SPAN, held.length * SPREAD)) return;
    const span = new Int32Array(length).fill(-1);
    held.forEach((band, place) => {
      span[band - this.#first] = place;
    });
    this.#span = span;
  }

  at(band: number): number {
    if (this.#span) return this.#span[band - this.#first] ?? -1;
    const held = this.#held;
    let lo = 0;
    let hi = held.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (held[mid]! < band) lo = mid + 1;
      else hi = mid;
    }
    return held[lo] === band ? lo : -1;
  }

  band(place: number): number {
    return this.#held[place] ?? -1;
  }
}

function same<T>(a: ArrayLike<T>, b: ArrayLike<T>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
