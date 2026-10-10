// The chart handle applications hold: what `createChart` returns and the
// framework adapters expose. Engine state stays behind it; panels and axes
// come out as read-only snapshots of the last frame drawn.

import type { DrillRoot } from "../marks/tree-data.ts";
import type { DrawnPanel, Inspection, TooltipMode, Viewport } from "../model/model.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { PlotRect } from "../scene/scene.ts";
import type { CameraSpec } from "../spec/spec.ts";
import type { Camera } from "../three/camera.ts";
import type { Selection } from "./brushed.ts";
import type { ChartUpdate } from "./chart.ts";
import type { ChartEvents, ChartListener, PanelTarget } from "./events.ts";

/** A panel's axis: x, the left y axis, or the right one. */
export type Axis = "x" | "y" | "yRight";

/** An axis of a panel; `panel` is needed in charts of several panels. */
export interface AxisTarget extends PanelTarget {
  axis: Axis;
}

/** A panel's axis as the last frame drew it. */
export interface AxisInfo {
  readonly type: "linear" | "log" | "time" | "band";
  /**
   * The values shown, from the start of `range` to its end: epoch ms on
   * time axes; on category axes, band indices from -0.5 to the last band's
   * index plus 0.5.
   */
  readonly domain: readonly [number, number];
  /** Where `domain` lies, in CSS pixels from the top left corner of `chart.root`. */
  readonly range: readonly [number, number];
  /** Category axes: the categories, in band index order. */
  readonly categories?: readonly string[] | undefined;
  /** Category axes: each band's width in pixels; 0 on other axes. */
  readonly bandwidth: number;
  /**
   * Names the scale the axis shows: panels whose axis has the same group
   * share its domain (and on x, its viewport), though each maps it to
   * pixels of its own. Opaque.
   */
  readonly group: string;
  /**
   * Whether `setViewport` zooms the axis: not on category axes, nor on y
   * axes of panels that have y scales of their own.
   */
  readonly canSetViewport: boolean;
}

/** A panel as the last frame drew it. */
export interface PanelInfo {
  /** "" without facets or subplots; else as in `PanelTarget`. */
  readonly key: string;
  /** What names the panel for people: its facet values, or its subplot's title or id; "" without. */
  readonly label: string;
  /** The area inside the axes, in CSS pixels from the top left corner of `chart.root`. */
  readonly plot: PlotRect;
  /** Charts of a layout mark (a pie, a map, a 3D chart) have no axes. */
  readonly x?: AxisInfo | undefined;
  readonly y?: AxisInfo | undefined;
  /** Only in charts with marks on the right axis. */
  readonly yRight?: AxisInfo | undefined;
}

/** An entry of the chart's legend, which hides and shows what it names by key. */
export interface LegendEntry {
  /** A series' key, or a layout mark's item's (a pie slice's), as inspections name them. */
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export interface InspectOptions extends PanelTarget {
  /** How to find the data; by default the chart's tooltip mode. */
  mode?: TooltipMode;
}

/**
 * A chart mounted in an element. Panels, pixel mapping, legend entries, and
 * inspections describe the last frame drawn: changes are drawn on the next
 * animation frame, or at once with `render()`. Pixels are CSS pixels from
 * the top left corner of `root`.
 */
export interface Chart {
  /** The chart's element, inside the container it was mounted in. */
  readonly root: HTMLDivElement;
  /** Replaces options (see `ChartUpdate`). Unspecified keys keep their current values. */
  update(options: ChartUpdate): void;
  /**
   * Zooms: each axis given (`x`, `y`, `yRight`) shows a range (epoch ms on
   * time axes), or with null its configured domain or its data; axes left
   * out keep their view. A pair is an x range, and null resets every axis.
   * Maps use projected plane units, networks layout units (y increases downwards);
   * node radii stay in pixels.
   * In charts whose panels have x scales of their own, an x range needs the
   * `panel` whose scale shows it, and null without one resets every scale;
   * y ranges are the chart's, whatever the panel.
   */
  setViewport(
    view: Partial<Viewport> | readonly [number, number] | null,
    target?: PanelTarget,
  ): void;
  /**
   * What the chart shows: the x range of the x scale every panel shares
   * (or, in charts whose panels have x scales of their own, of `panel`'s),
   * and the y ranges, each null when that axis is not zoomed.
   */
  getViewport(target?: PanelTarget): Viewport;
  /** What is brushed (x and y ranges, epoch ms for time axes, and a lasso's outline), or null. */
  readonly selection: Selection | null;
  /**
   * The keys of the panels the selection belongs to, or null without one:
   * every panel's, unless panels have x scales of their own (see `select`).
   */
  readonly selectionPanels: readonly string[] | null;
  /**
   * Sets or clears (null) the selection, as if the user had brushed it in
   * `panel`; an x range alone may be given as a pair. In charts whose panels
   * have x scales of their own, a selection needs the panel it is in, and
   * belongs to the panels sharing its x scale. With `rowSelection`, it
   * writes the rows it covers, unless `rows` is false: a selection another
   * view made and wrote, shown here too.
   */
  select(
    selection: Selection | readonly [number, number] | null,
    target?: PanelTarget & { rows?: boolean },
  ): void;
  /** Where a 3D chart is seen from (a copy); undefined for other charts. */
  readonly camera: Camera | undefined;
  /**
   * Turns a 3D chart's camera: the settings given replace the current ones;
   * null goes back to the configured camera. A `camera` event follows on
   * the next frame.
   */
  setCamera(camera: CameraSpec | null): void;
  /**
   * The node a treemap or sunburst is drilled into (null for the whole
   * tree) and the path to it from the top level; undefined for other charts.
   */
  readonly drillRoot: DrillRoot | undefined;
  /**
   * Drills a treemap or sunburst into a node, named by its item key (as
   * inspections, the legend, and `drill` events give it) or by its names
   * from the top level down, or with null back out to the whole tree, as
   * clicks do with `interaction.zoom`. A `drill` event follows when the root
   * changed. Throws for a node the tree does not have, and for other charts.
   */
  setDrillRoot(node: string | readonly string[] | null): void;
  /**
   * Moves a network's node, keyed as its items are, to a place in the
   * network's layout units (as `itemMove` events report them; links settle
   * about 30 units long), or with null back to where the layout puts it.
   * Nodes stay where they are put until the network's data changes, including
   * outside the current view; navigation does not clamp or change their positions. An
   * `itemMove` event follows when the node moved. Throws for a key of no
   * node drawn, and for other charts.
   */
  setItemPosition(key: string, position: { x: number; y: number } | null): void;
  /** The panels of the last frame, in reading order. */
  getPanels(): readonly PanelInfo[];
  /**
   * Where a value is on an axis, in pixels: numbers, epoch ms on time
   * axes, fractional band indices on category axes. Values beyond the
   * domain map beyond the plot. Undefined for an axis the panel lacks, and
   * for values it cannot show: not finite, not positive on log axes, or
   * left out by a time axis' breaks. Charts of several panels need `panel`.
   */
  toPixel(value: number, target: AxisTarget): number | undefined;
  /**
   * The value at a pixel of an axis: on category axes a fractional band
   * index (round it for the band), and at the seam of a time axis' break
   * the first time shown after the break. Undefined for an axis the panel lacks.
   */
  fromPixel(pixel: number, target: AxisTarget): number | undefined;
  /**
   * A value as the axis' tooltips write it: on category axes, the category
   * at the band index. Undefined for an axis the panel lacks, a value that
   * is not finite, and an index past the categories.
   */
  formatValue(value: number, target: AxisTarget): string | undefined;
  /**
   * The data at a pixel, as the tooltip would show it: in the panel under
   * the pixel, or in `panel` (nothing outside its plot). Moves no cursor,
   * shows no tooltip, and emits no event.
   */
  inspect(x: number, y: number, options?: InspectOptions): Inspection | undefined;
  /**
   * The entries the legend lists in the last frame, also when the chart
   * shows no legend: series, or a layout mark's items.
   */
  getLegend(): readonly LegendEntry[];
  /** The keys of the series and items hidden, as the legend hides them. */
  getHiddenKeys(): readonly string[];
  /**
   * Hides the series and items keyed `keys`, and shows the others. Keys of
   * series not drawn now stay hidden for when they are. A mark's keys go
   * with its identity, its `id` or else its index in `marks`: an update
   * without the mark drops them, and a mark that takes its index keeps them.
   */
  setHiddenKeys(keys: readonly string[]): void;
  /** Shows or hides series or items by key, as their legend entries do. */
  setVisibility(keys: string | readonly string[], visible: boolean): void;
  /**
   * Calls `listener` on every `type` event until the returned function is
   * called.
   *
   * ```ts
   * chart.on("select", ({ x }) => x && other.setViewport(x));
   * ```
   */
  on<K extends keyof ChartEvents>(type: K, listener: ChartListener<K>): () => void;
  /**
   * Pending while the chart loads code it needs: its GPU painter for large
   * point series, which it draws once loaded, its `animation` of views and
   * values, without which they change at once, its crosshair labels, what
   * reads tooltip fields and draws `renderTooltip`'s content, or what turns
   * a 3D chart. Undefined when nothing is pending.
   */
  readonly loading: Promise<void> | undefined;
  /**
   * Draws pending changes now, at the container's current size, instead of
   * on the next frame. It always draws, so a `render` listener calling it
   * hears of another frame.
   */
  render(): void;
  /**
   * Standalone SVG of the current state, for export: pending changes are
   * drawn first (and reported with a `render` event once the export has
   * the frame), and nothing is drawn when nothing is pending, so `render`
   * listeners may export.
   */
  toSVG(): string;
  /**
   * PNG of the current state, as `toSVG` exports it, at `scale` times the
   * chart's size in CSS pixels (2 by default); a transparent background
   * stays transparent. Loads its encoder the first time. For a PDF of the
   * current state, see `renderToPDF` in herceg/pdf.
   */
  toPNG(options?: { scale?: number }): Promise<Blob>;
  destroy(): void;
}

/** A snapshot of a panel of the last scene. */
export function panelInfo(panel: DrawnPanel): PanelInfo {
  const { key, label, plot, x, y, yGroup, yRight, yRightGroup } = panel;
  return {
    key,
    label,
    plot: { ...plot },
    x: axisInfo(x, panel.xGroup, x.type !== "band"),
    // The chart has one viewport of each y axis when every panel shares its scale.
    y: axisInfo(y, yGroup, yGroup === "" && y.type !== "band"),
    yRight: yRight && axisInfo(yRight, yRightGroup, yRightGroup === ""),
  };
}

function axisInfo(scale: PositionScale, group: string, canSetViewport: boolean): AxisInfo {
  return {
    type: scale.type,
    domain: [...scale.domain],
    range: [...scale.range],
    // Category lists are kept while they are unchanged, never changed in place.
    categories: scale.categories,
    bandwidth: Math.abs(scale.bandwidth ?? 0),
    group,
    canSetViewport,
  };
}
