// What the model asks of the guide compiler, the code that plans guides
// beyond the default (ticks other than a count, pattern and function formats,
// the chart's `scales` and `guides`, legend layouts). The compiler loads with
// the charts that use it: a live chart imports it before drawing such a
// configuration, and static output (SVG, PDF, specs) brings it with it, so
// charts that use none of it carry none of it.

import { markupOf, n } from "../draw/markup.ts";
import {
  formatNumber,
  numberFormatter,
  numberTickLabels,
  timeFormatter,
  timeTickLabels,
} from "../format/format.ts";
import { fromWall, toWall } from "../format/zone.ts";
import { aligned } from "../layout/place.ts";
import {
  type MeasureText,
  textHalo,
  textHeight,
  textItem,
  textItems,
  textWidth,
} from "../layout/text.ts";
import { mapValue } from "../lod/m4.ts";
import { chooseInterval, timeTicks } from "../scale/time.ts";
import { strokeKey } from "../scene/grid.ts";
import { type AxisGuide, type Rect, tickLabelGap } from "../scene/scene.ts";
import { ChartError } from "../spec/errors.ts";
import type { Place } from "../spec/place.ts";
import { cssFont, dashPattern, insets } from "../style/style.ts";
import type { Theme } from "../theme.ts";
import { type AxisContext, type AxisPlan, planAxis } from "./axis.ts";
import type { MarkSeries } from "./inspect.ts";
import {
  type LegendContent,
  type LegendFlow,
  type LegendText,
  type MeasuredLegend,
  measureLegends,
} from "./legend.ts";
import type { ChartConfig, PanelPlans } from "./model.ts";
import type { ScaleName } from "./scales.ts";
import type { ChartStyles } from "./styles.ts";

/**
 * What the guide compiler and the feature compiler use of the chart's own
 * code, handed to them rather than imported: a module both the chart and a
 * compiler's chunk imported would move out of the chart's first chunk into
 * a chunk of its own (as esbuild splits code), which compresses worse.
 */
export const GUIDE_KIT = {
  formatNumber,
  numberFormatter,
  numberTickLabels,
  timeFormatter,
  timeTickLabels,
  toWall,
  fromWall,
  chooseInterval,
  timeTicks,
  planAxis,
  textItem,
  textItems,
  textWidth,
  textHeight,
  tickLabelGap,
  strokeKey,
  cssFont,
  dashPattern,
  insets,
  aligned,
  textHalo,
  measureLegends,
  n,
  markupOf,
  mapValue,
  ChartError,
};

export type GuideKit = typeof GUIDE_KIT;

/** Plans a configuration's guides (guides/compile.ts). */
export interface GuideCompiler {
  compile(config: ChartConfig): CompiledGuides;
}

/** A configuration's guides as the compiler planned them. */
export interface CompiledGuides {
  /** The configuration as the model reads it: each scale's listed axis on its default side read as its short form. */
  readonly config: ChartConfig;
  /**
   * `context`, the context of an axis of scale `scale`, with how its ticks
   * are planned and its values written where its settings ask for more
   * than a count and Intl options.
   */
  context(context: AxisContext, scale: ScaleName): AxisContext;
  /** The axes `guides` lists, where they change the default ones. */
  readonly axes?: CompiledAxes | undefined;
  /**
   * The chart's legends, measured, and where each goes, where legend
   * settings or `guides` ask for more than the automatic legend: `content`
   * is what the automatic legend would show, `flow` how a legend placed
   * somewhere flows by default, and `marks` every mark's series.
   */
  readonly legends?:
    | ((
        content: LegendContent,
        text: LegendText,
        flow: (place: Place) => LegendFlow,
        marks: readonly MarkSeries[],
        theme: Theme,
        chart: { readonly width: number; readonly height: number },
      ) => PlacedLegend[])
    | undefined;
}

/** A legend measured, with where it goes and its track's key. */
export interface PlacedLegend {
  key: string;
  place: Place;
  measured: MeasuredLegend | undefined;
  /** Sentences for the chart's description of what it draws that is not a button (entries that explain). */
  notes?: readonly string[] | undefined;
}

/**
 * Axes the guides list beyond the default ones, or drawn other than they
 * are: tick layers, tick marks and labels of their own, axes above the
 * plots and y axes on the right. The model keeps the room they ask for and
 * hands them each panel's default axes to change.
 */
export interface CompiledAxes {
  /** Pixels they take above the plots, and below the default x axes' labels. */
  across(state: AxesState): { top: number; bottom: number };
  /**
   * Where panel `i`'s x labels over `plan`, below and above it, every
   * layer's as drawn, begin and end along the plan's range; undefined
   * where it draws none.
   */
  ends(plan: AxisPlan, state: AxesState, i: number): [number, number] | undefined;
  /** Pixels they take beside the plots, beyond the default y axes', once y is planned. */
  beside(state: AxesState): { left: number; right: number };
  /** Panel `index`'s axes along `plot`: the default ones, `axes`, changed and added to. */
  panel(
    axes: readonly AxisGuide[],
    state: AxesState,
    index: number,
    plot: Rect,
    plans: PanelPlans,
  ): AxisGuide[];
  /**
   * Whether the room `across` kept fits the x axes as panel `i`'s x plan,
   * `planOf(i)`, labels them; if not, `across` keeps more for scenes of this
   * width, and the model lays the scene out again.
   */
  fits(state: AxesState, planOf: (i: number) => AxisPlan): boolean;
}

/** What the guides' axes read of a scene the model lays out. */
export interface AxesState {
  readonly measure: MeasureText;
  readonly styles: ChartStyles;
  /** What labels are drawn on, for their halos. */
  readonly surface: string;
  /** The chart's size. */
  readonly width: number;
  readonly height: number;
  /** Panels in a row, and whether panels have headers above them. */
  readonly columns: number;
  readonly headers: boolean;
  /** Which panels label x below them, and the left and right y beside them. */
  readonly labeled: Readonly<Record<ScaleName, readonly boolean[]>>;
  /** Which panels draw marks along the left y axis, shown or not. */
  readonly drawsY: readonly boolean[];
  /**
   * The plan of panel `panel`'s axis of `scale`: for x, one over `pixels`
   * (for room, before x is planned); for y, its own.
   */
  plan(scale: ScaleName, panel: number, pixels: number): AxisPlan | undefined;
}

/**
 * Whether a configuration uses what only the guide compiler plans: ticks
 * other than a number, formats other than Intl options, `scales`, `guides`,
 * and legend settings beyond its place and style.
 */
export function needsGuides(config: ChartConfig): boolean {
  const { x, y, yRight, legend, panels, scales } = config;
  return (
    !!(config.guides || scales?.x || scales?.y || scales?.yRight) ||
    [x, y, yRight, ...(panels?.list.flatMap((p) => [p.x, p.y, p.yRight]) ?? [])].some(
      (axis) =>
        axis &&
        (typeof axis.ticks === "object" ||
          [axis.ticks, axis.format, axis.tooltipFormat].some(
            (setting) =>
              typeof setting === "function" ||
              (setting as { number?: string })?.number !== undefined ||
              (setting as { time?: string })?.time !== undefined,
          )),
    ) ||
    (typeof legend === "object" &&
      Object.keys(legend).some((key) => key !== "place" && key !== "style"))
  );
}
