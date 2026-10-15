// What lays a chart out in panels: a facet, which splits rows by category
// values, or subplots, whose marks name their panel. The model reads either
// through these types; their code loads only with a facet or panels.

import type { AxisOptions, ChartAxisOptions } from "../guides/options.ts";
import type { Align } from "../layout/place.ts";
import type { Breaks } from "../lod/m4.ts";
import {
  copyTrace,
  type TraceBuffers,
  type TraceColumns,
  type TraceSource,
} from "../lod/point-view.ts";
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
import type { Rect } from "../scene/scene.ts";
import type { ChartSpec, InteractionSpec, ScaleScope, XAxisSpec } from "../spec/spec.ts";
import type { AxisType } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";
import {
  instanceType,
  mixedPanels,
  type ScaledConfig,
  type ScaleName,
  type Scopes,
} from "./scales.ts";

/**
 * A panel's title or header at its place: vertically centered on `y`,
 * starting at, centered on, or ending at `x`, turned `angle` degrees
 * clockwise about that point.
 */
export interface HeaderPlace {
  text: string;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  angle: 0 | 90;
}

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
  /** The least height the rows share (see `leastHeight`), which a navigator's strip leaves them. */
  least?: number | undefined;
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
  /** For a map: each layer's rows, as `rows` gives a mark's, and those it is fitted to (see `LayoutFrame`). */
  layerRows?: readonly (Uint32Array | undefined)[];
  fitRows?: readonly (Uint32Array | undefined)[];
}

/**
 * What preparing panels' series reads of the chart: its size, which the
 * panels must fit, the series its legend hid, which stacks count as zero,
 * its scales' scopes, and its marks, of which layout marks have panels of
 * their own.
 */
export interface PanelChart extends PanelRoom {
  readonly hidden: ReadonlySet<string>;
  readonly config: ScaledConfig & { readonly marks: readonly ChartMark[] };
  /** The layout marks drawing in panels, as `PanelLayout.check` gave them. */
  readonly layouts: readonly LayoutMark[];
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
    `chart size: ${panels} panels in ${rows} rows of ${columns} do not fit a ${room.width}×${room.height} chart; make it larger or ${remedy}`,
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
 * The shares of `count` rows or columns, equal or by `weights` (scaled to
 * the largest first, so huge ones cannot overflow), and their sum.
 */
function sharesOf(
  count: number,
  weights: readonly number[] | undefined,
): { shares: number[]; total: number } {
  const largest = weights ? Math.max(...weights) : 1;
  const shares = Array.from({ length: count }, (_, k) => (weights ? weights[k]! / largest : 1));
  let total = 0;
  for (const share of shares) total += share;
  return { shares, total };
}

/**
 * The least whole height `rows` of `panels`, equal or weighted by
 * `weights`, share without `trackSizes` refusing them: each row of several
 * panels MIN_PANEL pixels tall at least.
 */
export function leastHeight(
  rows: number,
  weights: readonly number[] | undefined,
  panels: number,
): number {
  if (panels <= 1) return 0;
  const { shares, total } = sharesOf(rows, weights);
  const smallest = Math.min(...shares);
  const least = Math.ceil((MIN_PANEL * total) / smallest);
  // A hair more where trackSizes, dividing it again, rounds under.
  return (least * smallest) / total < MIN_PANEL ? Math.ceil(least * (1 + 1e-9)) : least;
}

/**
 * `free` pixels shared by `count` rows or columns of `panels` in rows of
 * `columns`, equally or by `weights` (see `sharesOf`); throws when one of
 * several panels would be less than MIN_PANEL pixels a side.
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
  const { shares, total } = sharesOf(count, weights);
  const sizes = shares.map((share) => (free * share) / total);
  if (panels > 1 && Math.min(...sizes) < MIN_PANEL) throw tooSmall(panels, columns, room, remedy);
  return sizes;
}

/** The chart options a layout checks; the x axis as panels read it, breaks aside. */
export type LayoutOptions = Pick<ChartSpec, "interaction"> & {
  x?: (ChartAxisOptions & Pick<XAxisSpec, "seams">) | undefined;
  y?: ChartAxisOptions | undefined;
  yRight?: ChartAxisOptions | undefined;
};

/** The chart options a layout checks, and those its layout marks are drawn with (a map's projection). */
export type LayoutConfig = LayoutOptions &
  Pick<ChartSpec, "projection"> & { readonly marks: readonly ChartMark[] };

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
  /**
   * Rejects marks along axes, layout marks, and options the panels cannot
   * draw; returns the layout marks that draw in panels (a map's layers joined).
   */
  check(
    marks: readonly Mark[],
    config: LayoutConfig,
    layouts?: readonly LayoutMark[],
  ): LayoutMark[];
  /** Whether the panels split the mark's rows (see `Mark.series`), rather than draw it whole. */
  splits(mark: Mark): boolean;
  /**
   * Which panels share each position scale, as the chart's scales' settings
   * say (see `scopesOf`): by default y's scope is each panel in subplots,
   * the whole chart in facets.
   */
  scopes(config: ScaledConfig): Scopes;
  /** In subplots, the error for numbers sharing scale `scale` with another mark's categories (see `mixedPanels`). */
  mixed?(numbers: Mark, categories: Mark, scale: ScaleName): Error;
  splitter(): PanelSplitter;
  grid(split: PanelSplit, lineHeight: number): PanelGrid;
  /**
   * The headers panel `index`, named by `values`, at `plot`, carries;
   * `aside` is the room right of it its right axis' labels take, and
   * `align` where in its span each header goes (unset: its natural place).
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
    align: Align | undefined,
  ): HeaderPlace[];
  /** What to do when the panels do not fit, for the error saying so. */
  readonly remedy: string;
  /** Room between columns for y labels and titles inside the grid. */
  columnGap(
    labeled: readonly boolean[],
    right: boolean,
    columns: number,
    room: number,
    title: number,
  ): number;
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
  panelAxis(
    axis: PanelAxis,
    index: number,
    chart: AxisOptions | undefined,
  ): AxisOptions | undefined;
  /**
   * The instances of `axis`' scale under `scope` (see `groups`), each with its
   * axis: the chart's settings `chart` (with, in subplots, its first panel's
   * own), and its type, from the marks its panels draw (see `instanceType`).
   */
  groups(
    scope: ScaleScope,
    split: PanelSplit,
    columns: number,
    axis: PanelAxis,
    chart: AxisOptions | undefined,
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
  axes: { type: AxisType; spec: AxisOptions | undefined }[];
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
 * `scope` (each panel alone, or the panels of a row or of a column, in
 * rows of `columns`): each panel's group, and what each group's panels draw
 * on that axis' side. A right axis' group takes its settings from its first
 * panel drawing a mark on it.
 */
export function groups(
  scope: ScaleScope,
  split: PanelSplit,
  columns: number,
  axis: PanelAxis,
): PanelGroups {
  const groupOf = groupsOf(scope, split.panels.length, columns);
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

/**
 * `found` with each instance's axis: its settings (`specOf` the group) and
 * the type the marks its panels draw on it give (see `instanceType`), where
 * `panelOf` names the panel a subplot's mark draws in, for errors. An
 * instance whose marks place no field along it is a band scale where other
 * instances of the scale are, so a panel beside panels of categories shows
 * no numbers of its own.
 */
export function typedGroups(
  found: PanelGroups,
  axis: PanelAxis,
  specOf: (group: number) => AxisOptions | undefined,
  panelOf?: (mark: Mark) => string | undefined,
): ScaleGroups {
  const channel = axis === "x" ? "x" : "y";
  const marksOf = found.drawn.map((drawn) => drawn.map(({ mark }) => mark));
  const banded = marksOf.some((marks) =>
    marks.some((mark) => mark.channelKind(channel) === "category"),
  );
  const axes = marksOf.map((marks, g) => {
    const spec = specOf(g);
    const unplaced = marks.every((mark) => mark.channelKind(channel) === undefined);
    const type =
      banded && unplaced
        ? "band"
        : instanceType(marks, spec?.type, {
            scale: axis,
            mixed:
              panelOf && ((numbers, categories) => mixedPanels(numbers, categories, axis, panelOf)),
          });
    return { type, spec };
  });
  return { ...found, axes };
}

/** The instance of a scale each of `count` panels in rows of `columns` draws with under `scope`. */
export function groupsOf(scope: ScaleScope, count: number, columns: number): number[] {
  return Array.from({ length: count }, (_, i) =>
    scope === "panel"
      ? i
      : scope === "row"
        ? Math.floor(i / columns)
        : scope === "column"
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

/** Layout marks that can split rows into facet panels. */
const IN_PANELS = new Set([
  ...["pie", "treemap", "sunburst", "gauge", "funnel", "radar", "sankey"],
  ...["graph", "geoshape", "geopoint"],
]);

/** Refuses layout marks panels cannot draw yet. */
export function checkLayouts(layouts: readonly LayoutMark[], subplots = false): void {
  for (const { spec } of layouts)
    if (
      !IN_PANELS.has(spec.type) &&
      !(subplots && ["point3d", "line3d", "surface"].includes(spec.type))
    )
      throw new Error(
        `${spec.type} facet: 3D marks cannot split into facets; use separate marks in subplots`,
      );
}

/**
 * What of `interaction` moves the view along y (and, with `brushes`,
 * brushes along it), which panels of some layouts cannot do yet: its path
 * under `interaction` and what it does there, or undefined for nothing.
 * Presets and the chart's own bindings alike.
 */
export function alongY(
  interaction: InteractionSpec = {},
  brushes = false,
): [path: string, does: string] | undefined {
  const y = (axes: unknown) => typeof axes === "string" && axes.includes("y");
  const { zoom, pan, brush, bindings = [] } = interaction;
  if (y(zoom)) return ["zoom", "zoom"];
  if (y(pan)) return ["pan", "pan"];
  if (brushes && brush && brush !== "x") return ["brush", "brush"];
  for (const [i, { action }] of bindings.entries()) {
    const moves = (action.type === "pan" || action.type === "zoom") && y(action.axes);
    // A brush that zooms moves the view along what it brushes.
    const brushesY = action.type === "brush" && (action.shape ?? "x") !== "x";
    if (moves || (brushesY && (brushes || (action.zoom && action.shape !== "lasso"))))
      return [`bindings[${i}].action`, action.type];
  }
  return undefined;
}

/**
 * Refuses what panels with categories of their own (a scope other than
 * "chart" on a category axis) cannot do yet: sync (a band index means
 * another category in each panel), and brush along a y axis of such
 * categories. Every mark banding an axis reads its positions through the
 * panels' places (see PanelBands).
 */
export function checkBands(marks: readonly Mark[], options: LayoutOptions, scopes: Scopes): void {
  for (const axis of ["x", "y"] as const) {
    if (scopes[axis] === "chart" || !marks.some((mark) => mark.channelKind(axis) === "category"))
      continue;
    const { brush, sync } = options.interaction ?? {};
    if (sync)
      throw new Error(
        `chart interaction.sync: panels with categories of their own (${axis}.scope "${scopes[axis]}") cannot sync yet; drop sync`,
      );
    if (axis === "y" && brush !== undefined && brush !== "x")
      throw new Error(
        'chart interaction.brush: panels with y categories of their own brush along x only; use "x"',
      );
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
 * Categories resolved per panel (a scope other than "chart" on a band
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
   * the axes whose categories they resolve apart (by `scopes`), if any, from
   * the chart's `bands`.
   */
  place(
    split: PanelSplit,
    columns: number,
    bands: Bands,
    scopes: Scopes,
    context: BandContext,
  ): void {
    const axes = (["x", "y"] as const).flatMap((axis) => {
      const chart = bands[axis];
      if (chart && scopes[axis] !== "chart")
        return [{ axis, ...this.#placeAxis(split, columns, chart, scopes[axis], axis, context) }];
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
   * The groups of `split`'s panels along `axis` under `scope`, and each
   * group's bands from the chart's `chart`; sets the panels' band lists.
   */
  #placeAxis(
    split: PanelSplit,
    columns: number,
    chart: BandList,
    scope: ScaleScope,
    axis: "x" | "y",
    context: BandContext,
  ): { groupOf: number[]; groups: GroupBands[] } {
    const count = chart.keys.length;
    let index: Map<string, number> | undefined;
    if (this.#seen.length < count) this.#seen = new Uint8Array(count);
    const groupOf = groupsOf(scope, split.panels.length, columns);
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

  trace(s: TraceSource, buffers: TraceBuffers, breaks?: Breaks): TraceColumns {
    return copyTrace(s, buffers, this, breaks);
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

/** Gaps are needed only where a panel labels a y axis inside the grid. */
export function columnGap(
  labeled: readonly boolean[],
  right: boolean,
  columns: number,
  room: number,
  title: number,
): number {
  const inner = labeled.some(
    (shows, i) =>
      shows && (right ? i % columns < columns - 1 && i !== labeled.length - 1 : i % columns > 0),
  );
  return room && inner ? room + (right ? 0 : 8) + title : 0;
}
