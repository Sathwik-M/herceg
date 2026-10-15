// Axes the chart's guides list. Each scale's axis on its default side (x
// below the plots, y on their left, yRight on their right) takes the place
// of the automatic one: its settings are read as the short form's, which
// the model plans as it always has. Axes on other sides (x above the plots,
// y on their right) are drawn beside them. Any listed axis may have tick
// layers of its own (minor ticks, a row of day boundaries), tick marks
// pointing in or out, a line, and labels turned or kept apart.

import type { MeasureText } from "../layout/text.ts";
import type { AxisPlan } from "../model/axis.ts";
import type { AxesState, CompiledAxes, GuideKit } from "../model/guides.ts";
import type { ChartConfig } from "../model/model.ts";
import type { ScaleName } from "../model/scales.ts";
import type { AxisGuide, AxisTick, GuideItem, Rect, TextItem } from "../scene/scene.ts";
import type { Side } from "../spec/place.ts";
import type {
  AxisStyles,
  StrokeStyle,
  TextStyle,
  TickLabelsSpec,
  TickMarkSpec,
} from "../spec/spec.ts";
import type { StrokePaint, TextPaint } from "../style/style.ts";
import type { AxisGuideOptions, ChartAxisOptions, Format, Ticks } from "./options.ts";
import { type Read, restroke, restyle } from "./paints.ts";
import { countOf, tickPlanner } from "./ticks.ts";

/** The side each scale's automatic axis is on. */
const HOME: Record<ScaleName, Side> = { x: "bottom", y: "left", yRight: "right" };
/** The default x axes' tick marks' length, which their labels' room keeps (axis-guide.ts). */
export const TICK = 5;
/** Pixels between rows of labels. */
const ROW_GAP = 2;
/** Pixels between labels and a title, as the default axes keep. */
const GAP = 6;
/** Pixels kept between labels that must not touch. */
const PAD = 4;
/** Pixels from a y axis' line to its labels, as the default axes draw them. */
const Y_GAP = 8;

/** A layer of an axis' ticks, resolved. */
export interface Layer {
  id: string;
  /** Where it is set, for messages. */
  path: string;
  ticks: Ticks | undefined;
  format: Format | undefined;
  /**
   * Whether its ticks are the model's plan of the scale: the major layer of
   * the axis on its default side, or with none there, of the first listed.
   */
  planned: boolean;
  tick: Required<TickMarkSpec> | false;
  labels: (TickLabelsSpec & { row: number }) | false;
  style: { tick?: StrokeStyle; tickLabel?: TextStyle } | undefined;
}

/** An axis the guides list, resolved against the short form. */
export interface ListedAxis {
  key: string;
  /** Where it is listed, for messages. */
  path: string;
  scale: ScaleName;
  side: Side;
  /** On its scale's default side, where the model's plan gives its major ticks. */
  home: boolean;
  /** Whether it runs across the chart (an x axis), its labels in rows, or along y; and above the plots. */
  across: boolean;
  above: boolean;
  /** Whether it is drawn: axes on the default side are shown as the short form's `show` says. */
  show: boolean;
  /** Titles of axes elsewhere; the model writes those on the default side. */
  title: string | undefined;
  /** For an axis moved off the default side: each subplot's own title of the scale, over `title`. */
  titles?: readonly (string | undefined)[];
  /** Subplots whose own settings hide the scale's axis, which axes elsewhere leave out too. */
  off?: readonly boolean[];
  line: boolean;
  layers: Layer[];
  style: AxisStyles | undefined;
  /** Whether it draws as the automatic axis does, so the model's stands as it is. */
  plain: boolean;
  /** For a y axis on the right: whether the panels of each row share y, so the last one's axis is theirs. */
  rows: boolean;
}

/**
 * The axes `config.guides` lists, and the short forms as the model reads
 * them: each scale's settings with those of its listed axis on its default
 * side, or with the automatic axis hidden when the scale's axes are all
 * elsewhere. Undefined when the guides list no axes.
 */
export function listedAxes(
  config: ChartConfig,
): { read: Partial<Record<ScaleName, ChartAxisOptions>>; axes: ListedAxis[] } | undefined {
  const guides = config.guides ?? [];
  if (!guides.some((guide) => guide.type === "axis")) return undefined;
  const read: Partial<Record<ScaleName, ChartAxisOptions>> = {};
  const axes: ListedAxis[] = [];
  const right = config.marks.some((mark) => mark.spec.axis === "right");
  const yScope = config.y?.scope ?? (config.panels ? "panel" : "chart");
  const rows = yScope === "chart" || yScope === "row";
  for (const scale of ["x", "y", "yRight"] as const) {
    const short = config[scale];
    const sides = new Set<Side>();
    let home: AxisGuideOptions | undefined;
    let first: AxisGuideOptions | undefined;
    guides.forEach((guide, i) => {
      if (guide.type !== "axis" || guide.scale !== scale) return;
      const side = guide.place?.side ?? HOME[scale];
      const path = `chart guides[${i}].place.side`;
      const along =
        scale === "x"
          ? side === "top" || side === "bottom"
          : side === "right" || (scale === "y" && side === "left");
      if (!along)
        throw new Error(
          `${path}: ${scale} axes go ${scale === "x" ? 'on the "top" or the "bottom"' : scale === "y" ? 'on the "left" or the "right"' : 'on the "right"'}; received "${side}"`,
        );
      if (sides.has(side))
        throw new Error(
          `${path}: scale ${scale} has an axis on the ${side} already; give this one ${scale === "x" ? (side === "top" ? '"bottom"' : '"top"') : side === "left" ? '"right"' : '"left"'}`,
        );
      if (scale === "y" && side === "right" && right)
        throw new Error(
          `${path}: marks with axis: "right" put yRight's axis on the right; keep y's on the left`,
        );
      sides.add(side);
      first ??= guide;
      if (side === HOME[scale]) home = guide;
      axes.push({ ...resolve(guide, scale, side, short, `chart guides[${i}]`), rows });
    });
    if (sides.size === 0) continue;
    // Grid lines follow the axis on the default side, or without one, the
    // first listed: the hidden automatic axis plans its ticks as that one's,
    // and that one draws the ticks it planned.
    const owner = home ?? first!;
    if (!home) {
      // A subplot showing the automatic axis would bring it back beside the moved one.
      const shown = config.panels?.list.findIndex((panel) => panel[scale]?.show === true) ?? -1;
      if (shown >= 0)
        throw new Error(
          `chart panels[${shown}].${scale}.show: the guides list ${scale}'s axes elsewhere, which hides its axis on the ${HOME[scale]}; drop show, or list an axis on the ${HOME[scale]}`,
        );
      // The axis moved off the default side takes the scale's titles with it.
      const moved = axes.find((axis) => axis.scale === scale)!;
      moved.layers[0]!.planned = true;
      moved.title ??= short?.title;
      const own = config.panels?.list.map((panel) => panel[scale]?.title);
      if (own?.some((title) => title !== undefined)) moved.titles = own;
    }
    // Axes elsewhere leave out the subplots that hide the scale's axis.
    const off = config.panels?.list.map((panel) => panel[scale]?.show === false);
    if (off?.includes(true))
      for (const axis of axes) if (axis.scale === scale && !axis.home) axis.off = off;
    const style = home?.style
      ? mergeStyles(short?.style, home.style)
      : owner.style?.grid
        ? { ...short?.style, grid: { ...short?.style?.grid, ...owner.style.grid } }
        : short?.style;
    read[scale] = {
      ...short,
      show: home ? (home.show ?? short?.show ?? true) : false,
      ...(home?.title !== undefined && { title: home.title }),
      ...(owner.ticks !== undefined && { ticks: owner.ticks }),
      ...(owner.format !== undefined && { format: owner.format }),
      ...(owner.grid !== undefined && { grid: owner.grid }),
      ...(style && { style }),
    };
  }
  return { read, axes };
}

function resolve(
  guide: AxisGuideOptions,
  scale: ScaleName,
  side: Side,
  short: ChartAxisOptions | undefined,
  path: string,
): Omit<ListedAxis, "rows"> {
  const home = side === HOME[scale];
  const across = scale === "x";
  const layers = resolveLayers(
    { ...guide, ticks: guide.ticks ?? short?.ticks, format: guide.format ?? short?.format },
    { across, home, path, name: `${scale} axis`, tick: across ? TICK : 3 },
  );
  return {
    // Ids and generated keys apart: a guide's id cannot take another's key.
    key: guide.id !== undefined ? `id|${guide.id}` : `${scale}|${side}`,
    path,
    scale,
    side,
    home,
    across,
    above: side === "top",
    show: guide.show ?? short?.show ?? true,
    title: home ? undefined : guide.title,
    line: guide.line ?? across,
    layers,
    // Over the paints the model resolved for the scale's axis in each panel,
    // which take the chart's and subplots' styles already.
    style: home ? undefined : guide.style,
    plain:
      home &&
      guide.tick === undefined &&
      guide.labels === undefined &&
      guide.line === undefined &&
      layers.length === 1,
  };
}

/**
 * The layers of an axis (or a colorbar) with `settings`: its own ticks,
 * "major" (planned by the model on an axis' default side, `home`), then
 * those it lists. Axes along x draw tick marks by default, as long as the
 * default axes'; others as `tick` says for their layers only.
 */
export function resolveLayers(
  settings: {
    ticks?: Ticks | undefined;
    format?: Format | undefined;
    tick?: TickMarkSpec | false | undefined;
    labels?: TickLabelsSpec | false | undefined;
    layers?: AxisGuideOptions["layers"] | undefined;
  },
  {
    across,
    home,
    path,
    name,
    tick: minor,
    major = across && { direction: "out", length: TICK },
  }: {
    across: boolean;
    home: boolean;
    path: string;
    name: string;
    tick: number;
    major?: TickMarkSpec | false;
  },
): Layer[] {
  const tick = (spec: TickMarkSpec | false | undefined, fallback: TickMarkSpec | false) => {
    const given = spec ?? fallback;
    return given && { direction: given.direction ?? "out", length: given.length ?? TICK };
  };
  const labels = (spec: TickLabelsSpec | false | undefined, where: string) => {
    if (spec === false) return false;
    const row = spec?.row ?? 0;
    if (
      !across &&
      (row > 0 ||
        spec?.rotation !== undefined ||
        spec?.collision === "stagger" ||
        spec?.collision === "wrap")
    )
      throw new Error(
        `${where}: rows, turned labels, staggering, and wrapping are for labels side by side; drop them from this ${name}`,
      );
    const rotation = spec?.rotation;
    for (const turn of typeof rotation === "object" ? rotation.candidates : [rotation ?? 0])
      if (!(turn >= -90 && turn <= 90))
        throw new Error(
          `${where}.rotation: ${turn} degrees is beyond a quarter turn; give degrees from -90 (reading up) to 90 (reading down)`,
        );
    if (spec?.collision === "wrap" && spec.rotation !== undefined)
      throw new Error(
        `${where}.collision: "wrap" breaks labels that lie flat; drop rotation, or keep turned labels apart with "hide" or "stagger"`,
      );
    return { ...spec, row };
  };
  return [
    {
      id: "major",
      path,
      ticks: settings.ticks,
      format: settings.format,
      planned: home,
      tick: tick(settings.tick, major),
      labels: labels(settings.labels, `${path}.labels`),
      style: undefined,
    },
    ...(settings.layers ?? []).map(
      (layer, k): Layer => ({
        id: layer.id,
        path: `${path}.layers[${k}]`,
        ticks: layer.ticks,
        format: layer.format,
        planned: false,
        tick: tick(layer.tick, { direction: "out", length: minor }),
        labels: labels(layer.labels, `${path}.layers[${k}].labels`),
        style: layer.style,
      }),
    ),
  ];
}

/** Styles by role, `own`'s properties over `base`'s. */
function mergeStyles(
  base: AxisStyles | undefined,
  own: AxisStyles | undefined,
): AxisStyles | undefined {
  if (!base || !own) return own ?? base;
  const out: Record<string, object> = { ...base };
  for (const [role, style] of Object.entries(own))
    out[role] = { ...(base as Record<string, object>)[role], ...style };
  return out as AxisStyles;
}

/** A layer planned for one panel: where its ticks are and what they say, and how its labels are drawn. */
export interface Placed {
  layer: Layer;
  ticks: AxisTick[];
  angle: number;
  /** Lanes its labels take in turn: two when staggered; and each tick's lane. */
  lanes: number;
  lane: readonly number[];
  /** Along y, where each tick's label is drawn, inside the chart. */
  at: readonly number[] | undefined;
  label: TextPaint;
  tick: StrokePaint;
}

/** The compiled axes of `listed`, planned and drawn with the chart's code `kit`. */
export function compiledAxes(kit: GuideKit, listed: readonly ListedAxis[]): CompiledAxes {
  const elsewhere = listed.filter((axis) => !axis.home && axis.show);
  const changed = (scale: string) =>
    listed.find((axis) => axis.scale === scale && axis.home && !axis.plain);
  // Room above and below the plots is kept before x is planned, from a plan
  // over a column's share of the width. Where the panels' own plans need
  // more (turned labels choosing a steeper angle in narrower plots), the
  // room grows for scenes of this width, as margins do, and the model lays
  // the scene out again.
  let kept = { width: Number.NaN, top: 0, bottom: 0 };
  let reserved = { top: 0, bottom: 0 };
  return {
    across(state) {
      if (kept.width !== state.width) kept = { width: state.width, top: 0, bottom: 0 };
      let top = 0;
      let bottom = 0;
      const home = changed("x");
      state.labeled.x.forEach((shows, i) => {
        if (shows && home)
          bottom = Math.max(
            bottom,
            extraDepth(
              kit,
              home,
              state,
              placedLayers(kit, home, state, i, provisional(state, home, i)),
            ),
          );
      });
      for (const axis of elsewhere) {
        if (axis.side !== "top") continue;
        if (state.headers)
          throw new Error(
            `${axis.path}.place.side: an x axis above the plots needs panels without titles or headers; place it on the "bottom"`,
          );
        for (let i = 0; i < state.labeled.x.length; i++)
          if (drawsIn(axis, state, i))
            top = Math.max(
              top,
              depthOf(
                kit,
                axis,
                state,
                i,
                placedLayers(kit, axis, state, i, provisional(state, axis, i)),
              ),
            );
      }
      reserved = { top: Math.max(top, kept.top), bottom: Math.max(bottom, kept.bottom) };
      return reserved;
    },
    beside(state) {
      let left = 0;
      let right = 0;
      for (const scale of ["y", "yRight"] as const) {
        const home = changed(scale);
        if (!home) continue;
        // Ticks pointing out, and labels of other layers wider than the model's.
        let reach = 0;
        state.labeled[scale].forEach((shows, i) => {
          if (shows) reach = Math.max(reach, widerBy(kit, home, state, i));
        });
        if (scale === "y") left = outward(home.layers) + reach;
        else right = outward(home.layers) + reach;
      }
      for (const axis of elsewhere) {
        if (axis.side !== "right") continue;
        if (state.columns > 1 && !axis.rows)
          throw new Error(
            `${axis.path}.place.side: a y axis on the right stands beside each row's last panel, so the panels of a row must share y; give y scope "row" or "chart", or keep the axis on the left`,
          );
        state.drawsY.forEach((_, i) => {
          if (drawsIn(axis, state, i)) right = Math.max(right, breadth(kit, axis, state, i));
        });
      }
      return { left, right };
    },
    ends(plan, state, i) {
      const { measure } = state;
      let lo = Infinity;
      let hi = -Infinity;
      const add = (tick: AxisTick, paint: TextPaint, angle: number, run: Run) => {
        if (!tick.label) return;
        const [from, to] = extent(tick, paint, angle, run, measure);
        lo = Math.min(lo, from);
        hi = Math.max(hi, to);
      };
      const home = changed("x");
      if (state.labeled.x[i]) {
        if (home)
          for (const placed of placedLayers(kit, home, state, i, plan))
            for (const tick of placed.ticks) add(tick, placed.label, placed.angle, "below");
        else {
          // The default axis' labels, centered on their ticks.
          const paint = state.styles.axisText("tickLabel", "x", i);
          plan.ticks.forEach((t, k) => {
            add({ position: plan.scale.map(t), label: plan.labels[k] ?? "" }, paint, 0, "below");
          });
        }
      }
      for (const axis of elsewhere)
        if (axis.side === "top" && drawsIn(axis, state, i))
          for (const placed of placedLayers(kit, axis, state, i, plan))
            for (const tick of placed.ticks) add(tick, placed.label, placed.angle, "above");
      return lo > hi ? undefined : [lo, hi];
    },
    fits(state, planOf) {
      let top = 0;
      let bottom = 0;
      const home = changed("x");
      state.labeled.x.forEach((shows, i) => {
        if (shows && home)
          bottom = Math.max(
            bottom,
            extraDepth(kit, home, state, placedLayers(kit, home, state, i, planOf(i))),
          );
      });
      for (const axis of elsewhere)
        if (axis.side === "top")
          for (let i = 0; i < state.labeled.x.length; i++)
            if (drawsIn(axis, state, i))
              top = Math.max(
                top,
                depthOf(kit, axis, state, i, placedLayers(kit, axis, state, i, planOf(i))),
              );
      if (top <= reserved.top + 0.5 && bottom <= reserved.bottom + 0.5) return true;
      kept = {
        width: kept.width,
        top: Math.max(kept.top, Math.ceil(top)),
        bottom: Math.max(kept.bottom, Math.ceil(bottom)),
      };
      return false;
    },
    panel(axes, state, index, plot, plans) {
      const out = axes.map((guide) => {
        const axis = changed(guide.scale);
        return axis
          ? rebuild(
              kit,
              guide,
              axis,
              placedLayers(kit, axis, state, index, plans[axis.scale]),
              state,
              index,
            )
          : guide;
      });
      for (const axis of elsewhere) {
        const plan = plans[axis.scale];
        if (!plan) continue;
        if (drawsIn(axis, state, index))
          out.push(
            beyond(kit, axis, placedLayers(kit, axis, state, index, plan), state, index, plot),
          );
      }
      return out;
    },
  };
}

/**
 * Whether panel `i` draws `axis`, an axis elsewhere: an x axis above each
 * panel of the first row, a y axis beside the last panel of each row that
 * draws along y, unless the panel's own settings hide the scale's axis.
 */
function drawsIn(axis: ListedAxis, state: AxesState, i: number): boolean {
  if (axis.off?.[i]) return false;
  return axis.side === "top"
    ? i < state.columns && i < state.labeled.x.length
    : !!state.drawsY[i] && lastInRow(state, i);
}

/** Whether panel `i` is the last of its row, where y axes on the right go. */
function lastInRow(state: AxesState, i: number): boolean {
  return i % state.columns === state.columns - 1 || i === state.drawsY.length - 1;
}

/** How far tick marks reach out from the axis line. */
export function outward(layers: readonly Layer[]): number {
  let reach = 0;
  for (const { tick } of layers)
    if (tick)
      reach = Math.max(
        reach,
        tick.direction === "out" ? tick.length : tick.direction === "cross" ? tick.length / 2 : 0,
      );
  return reach;
}

/** The x plan an axis' room is measured with before x is planned: over a column's share of the width. */
function provisional(state: AxesState, axis: ListedAxis, i: number): AxisPlan | undefined {
  return state.plan(axis.scale, i, state.width / state.columns);
}

/** Panel `i`'s layers of `axis` over `plan`: each one's ticks and labels, as its collision policy keeps them. */
function placedLayers(
  kit: GuideKit,
  axis: ListedAxis,
  state: AxesState,
  i: number,
  plan: AxisPlan | undefined,
): Placed[] {
  const { styles } = state;
  const at = `${axis.path}.style`;
  const base = {
    label: restyle(
      kit,
      styles.read,
      styles.axisText("tickLabel", axis.scale, i),
      axis.style?.tickLabel,
      `${at}.tickLabel`,
    ),
    tick: restroke(
      kit,
      styles.read,
      styles.axisStroke("tick", axis.scale, i),
      axis.style?.tick,
      `${at}.tick`,
    ),
  };
  return layered(kit, axis, base, styles.read, state.measure, plan, state.height);
}

/**
 * The layers of an axis (or a colorbar's) over `plan`, their labels and
 * tick marks drawn with `base`'s paints under their own styles.
 */
export function layered(
  kit: GuideKit,
  axis: { layers: readonly Layer[]; scale: string; across: boolean; above: boolean },
  base: { label: TextPaint; tick: StrokePaint },
  read: Read,
  measure: MeasureText,
  plan: AxisPlan | undefined,
  /** The chart's height labels along y stay inside; undefined to leave them at their ticks. */
  height: number | undefined,
): Placed[] {
  const run: Run = axis.across ? (axis.above ? "above" : "below") : "along";
  const placed = axis.layers.map((layer): Placed => {
    const at = `${layer.path}.style`;
    const label = restyle(kit, read, base.label, layer.style?.tickLabel, `${at}.tickLabel`);
    const tick = restroke(kit, read, base.tick, layer.style?.tick, `${at}.tick`);
    let ticks: AxisTick[] = [];
    if (plan) {
      // A category axis' own layer labels its categories, on any side.
      const categories = !plan.context && layer.id === "major";
      const own = layer.planned || categories ? plan : planLayer(kit, layer, axis, plan);
      const labels = layer.labels;
      // Turned or kept-apart labels of a category axis choose among all its categories.
      const all =
        categories && labels && (labels.rotation !== undefined || labels.collision !== undefined);
      ticks = all
        ? (plan.scale.categories ?? []).map((name, k) => ({
            position: plan.scale.map(k),
            label: name,
          }))
        : own.ticks.map((t, k) => ({ position: own.scale.map(t), label: own.labels[k] ?? "" }));
    }
    let angle = 0;
    let lanes = 1;
    let lane: number[] = [];
    let labelAt: number[] | undefined;
    const labels = layer.labels;
    if (labels) {
      // Labels that may turn are written on one line.
      if (labels.rotation !== undefined)
        ticks = ticks.map((t) =>
          t.label.includes("\n") ? { ...t, label: t.label.replaceAll("\n", " ") } : t,
        );
      angle = angleOf(labels, ticks, label, measure, run);
      const collision = labels.collision ?? "show";
      if (collision === "wrap") ticks = wrapped(ticks, label, measure);
      if (collision === "stagger") lanes = 2;
      // Labels along y stay inside the chart, where the plot's ends leave
      // no room for a layer's taller ones: they meet where they are drawn.
      if (run === "along" && height !== undefined)
        labelAt = ticks.map(({ position, label: text }) => {
          const half = boxOf(text, label, measure).height / 2;
          return Math.min(Math.max(position, half), height - half);
        });
      if (collision === "hide" || collision === "stagger") {
        const drawnAt = labelAt;
        const shown = drawnAt ? ticks.map((t, k) => ({ ...t, position: drawnAt[k]! })) : ticks;
        const result = kept(shown, label, measure, angle, lanes, run);
        ticks = ticks.map((t, k) => ({ ...t, label: result.ticks[k]!.label }));
        lane = result.lane;
      }
    }
    return { layer, ticks, angle, lanes, lane, at: labelAt, label, tick };
  });
  return prioritized(placed, measure, run);
}

/** How an axis' labels lie: side by side below or above the plots, or one above another along y. */
type Run = "below" | "above" | "along";

/**
 * The layers with labels that overlap a label of a layer of higher
 * priority in their row left out, as a day's date at midnight in place of
 * the hour there.
 */
function prioritized(layers: Placed[], measure: MeasureText, run: Run): Placed[] {
  const rank = (placed: Placed) => (placed.layer.labels ? (placed.layer.labels.priority ?? 0) : 0);
  return layers.map((placed) => {
    const { labels } = placed.layer;
    if (!labels) return placed;
    const above = layers.filter(
      (other) =>
        other.layer.labels && other.layer.labels.row === labels.row && rank(other) > rank(placed),
    );
    if (above.length === 0) return placed;
    // Each label's extent along the axis, where it is drawn, in its own
    // layer's paint and turn.
    const extentOf = (tick: AxisTick, k: number, of: Placed) =>
      extent(of.at ? { ...tick, position: of.at[k]! } : tick, of.label, of.angle, run, measure);
    const ticks = placed.ticks.map((tick, k) => {
      if (!tick.label) return tick;
      const [lo, hi] = extentOf(tick, k, placed);
      const meets = above.some((other) =>
        other.ticks.some((kept, j) => {
          if (!kept.label) return false;
          const [from, to] = extentOf(kept, j, other);
          return lo < to + PAD && from < hi + PAD;
        }),
      );
      return meets ? { ...tick, label: "" } : tick;
    });
    return { ...placed, ticks };
  });
}

/** Where a label reaches along its axis: its box's extent, as it turns from its tick. */
export function extent(
  tick: AxisTick,
  paint: TextPaint,
  angle: number,
  run: Run,
  measure: MeasureText,
): [number, number] {
  const { width, height } = boxOf(tick.label, paint, measure);
  const at = tick.position;
  if (run === "along") return [at - height / 2, at + height / 2];
  const { anchor, cos, sin } = turned(angle, run === "above");
  const along = width * cos;
  const across = (height / 2) * sin;
  const from = anchor === "middle" ? along / 2 : anchor === "end" ? along : 0;
  const to = anchor === "middle" ? along / 2 : anchor === "start" ? along : 0;
  return [at - from - across, at + to + across];
}

/** A label's box: its lines of text and, with a background, the box's padding. */
function boxOf(
  label: string,
  paint: TextPaint,
  measure: MeasureText,
): { width: number; height: number } {
  const [top, right, bottom, left] = paint.background ? paint.padding : [0, 0, 0, 0];
  const lines = label.split("\n");
  return {
    width: Math.max(...lines.map((line) => measure(line, paint.css))) + left + right,
    height: lines.length * paint.lineHeight + top + bottom,
  };
}

/** A layer's own plan over the scale of the axis' plan `plan`: about its own count of ticks, or the axis'. */
function planLayer(kit: GuideKit, layer: Layer, axis: { scale: string }, plan: AxisPlan): AxisPlan {
  const context = plan.context;
  if (!context || plan.within === undefined || plan.count === undefined)
    throw new Error(
      `${layer.path}: a category axis labels its categories in one layer; drop the ${axis.scale} axis' layers`,
    );
  const planner = tickPlanner(
    kit,
    layer.ticks,
    layer.format,
    context,
    axis.scale,
    { ticks: `${layer.path}.ticks`, format: `${layer.path}.format` },
    layer.labels ? layer.labels.duplicates : "hide",
  );
  return kit.planAxis(
    { ...context, plan: planner },
    plan.scale.domain as [number, number],
    plan.scale.range as [number, number],
    countOf(layer.ticks) ?? plan.count,
    plan.within,
  );
}

/**
 * How a label turned `angle` degrees clockwise is anchored at its tick on
 * an axis along x: running away from the plot, below it or (`above`) above.
 */
export function turned(
  angle: number,
  above = false,
): { anchor: TextItem["anchor"]; cos: number; sin: number } {
  const turn = (angle * Math.PI) / 180;
  const away = above ? -angle : angle;
  return {
    anchor: away > 0 ? "start" : away < 0 ? "end" : "middle",
    cos: Math.abs(Math.cos(turn)),
    sin: Math.abs(Math.sin(turn)),
  };
}

/** The angle labels are drawn at: their rotation, or the first candidate at which neighbors do not overlap. */
function angleOf(
  labels: TickLabelsSpec,
  ticks: readonly AxisTick[],
  paint: TextPaint,
  measure: MeasureText,
  run: Run,
): number {
  const rotation = labels.rotation;
  if (typeof rotation !== "object") return rotation ?? 0;
  // Neighbors are the labels drawn: blank ticks between them keep no room.
  const shown = ticks.filter((tick) => tick.label);
  for (const angle of rotation.candidates) {
    let fits = true;
    for (let k = 1; k < shown.length && fits; k++)
      fits = !overlaps(shown[k - 1]!, shown[k]!, paint, measure, angle, run);
    if (fits) return angle;
  }
  return rotation.candidates.at(-1)!;
}

/**
 * Whether two labels at the same angle overlap: on an axis along x, their
 * boxes compared along the labels' direction and across it; along y, their
 * lines one above the other.
 */
function overlaps(
  first: AxisTick,
  second: AxisTick,
  paint: TextPaint,
  measure: MeasureText,
  angle: number,
  run: Run,
): boolean {
  if (!first.label || !second.label) return false;
  // In pixel order, `a` before `b`, as reversed axes have them otherwise.
  const [a, b] = first.position <= second.position ? [first, second] : [second, first];
  const d = b.position - a.position;
  // Labels in boxes take their padding too.
  const { width: wa, height: tall } = boxOf(a.label, paint, measure);
  const wb = boxOf(b.label, paint, measure);
  // One above the other, blocks meet within half of each one's height.
  if (run === "along") return d < (tall + wb.height) / 2;
  const { anchor, cos, sin } = turned(angle, run === "above");
  if (d * sin >= Math.max(tall, wb.height)) return false;
  const reach = anchor === "middle" ? (wa + wb.width) / 2 : anchor === "start" ? wa : wb.width;
  return d * cos < reach + PAD;
}

/**
 * Labels as "hide" and "stagger" keep them: every n-th, for the least n at
 * which those kept, on `lanes` lanes taken in turn, no longer overlap; and
 * the lane of each tick's label.
 */
function kept(
  ticks: AxisTick[],
  paint: TextPaint,
  measure: MeasureText,
  angle: number,
  lanes: number,
  run: Run,
): { ticks: AxisTick[]; lane: number[] } {
  for (let every = 1; every <= ticks.length; every++) {
    const shown = ticks.filter((tick, k) => tick.label && k % every === 0);
    let fits = true;
    for (let k = lanes; k < shown.length && fits; k++)
      fits = !overlaps(shown[k - lanes]!, shown[k]!, paint, measure, angle, run);
    if (fits) {
      let n = 0;
      const lane = ticks.map((tick, k) => (tick.label && k % every === 0 ? n++ % lanes : 0));
      return {
        ticks: ticks.map((tick, k) => (k % every === 0 ? tick : { ...tick, label: "" })),
        lane,
      };
    }
  }
  return { ticks, lane: [] };
}

/** Labels broken at spaces into lines that fit between their neighbors, three lines at most. */
function wrapped(ticks: AxisTick[], paint: TextPaint, measure: MeasureText): AxisTick[] {
  return ticks.map((tick, k) => {
    const near = [ticks[k - 1], ticks[k + 1]].filter((other) => other !== undefined);
    const room = Math.min(...near.map((other) => Math.abs(other.position - tick.position))) - PAD;
    if (!(room > 0) || measure(tick.label, paint.css) <= room) return tick;
    const lines: string[] = [];
    for (const word of tick.label.split(" ")) {
      const last = lines.at(-1);
      if (
        last !== undefined &&
        (lines.length >= 3 || measure(`${last} ${word}`, paint.css) <= room)
      )
        lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    return { ...tick, label: lines.join("\n") };
  });
}

/** How tall a layer's row of labels is: a line (or a wrapped label's lines), or turned labels' extent. */
function laneDepth(kit: GuideKit, { ticks, angle, label }: Placed, measure: MeasureText): number {
  const height = kit.textHeight(label);
  if (!angle) {
    const lines = Math.max(1, ...ticks.map((tick) => tick.label.split("\n").length));
    return height + (lines - 1) * label.lineHeight;
  }
  const { cos, sin } = turned(angle);
  let widest = 0;
  for (const { label: text } of ticks)
    widest = Math.max(widest, kit.textWidth(text, label, measure));
  return widest * sin + height * cos;
}

/** Each row's depth: the deepest of the layers labeled in it, their lanes included. */
export function rowDepths(
  kit: GuideKit,
  layers: readonly Placed[],
  measure: MeasureText,
): number[] {
  const rows: number[] = [];
  for (const placed of layers) {
    const { labels } = placed.layer;
    if (!labels) continue;
    const lane = laneDepth(kit, placed, measure);
    const depth = lane * placed.lanes + (placed.lanes - 1) * ROW_GAP;
    rows[labels.row] = Math.max(rows[labels.row] ?? 0, depth);
  }
  return Array.from(rows, (row) => row ?? 0);
}

/** Pixels an x axis' ticks and rows of labels, `layers` placed in panel `i`, take out from the line. */
function depthOf(
  kit: GuideKit,
  axis: ListedAxis,
  state: AxesState,
  i: number,
  layers: readonly Placed[],
): number {
  const rows = rowDepths(kit, layers, state.measure);
  const labels = rows.reduce((sum, row) => sum + row + ROW_GAP, -ROW_GAP);
  const title = titleOf(axis, i) ? kit.textHeight(titlePaint(kit, axis, state, i)) + GAP : 0;
  // As drawn: labels clear the line by the gap and the ticks longer than the default axes'.
  const reach = Math.max(0, outward(axis.layers) - TICK);
  return kit.tickLabelGap(layers[0]!.label.size) + reach + Math.max(0, labels) + title;
}

/** Pixels the x axis on the default side, `layers` placed, takes beyond what the model keeps for one line of labels. */
function extraDepth(
  kit: GuideKit,
  axis: ListedAxis,
  state: AxesState,
  layers: readonly Placed[],
): number {
  const rows = rowDepths(kit, layers, state.measure);
  const labels = rows.reduce((sum, row) => sum + row + ROW_GAP, -ROW_GAP);
  const line = kit.textHeight(layers[0]!.label);
  return Math.max(0, outward(axis.layers) - TICK) + Math.max(0, labels - line);
}

/** The widest of `layers`' labels. */
export function widest(kit: GuideKit, layers: readonly Placed[], measure: MeasureText): number {
  let most = 0;
  for (const { ticks, label } of layers)
    for (const tick of ticks) most = Math.max(most, kit.textWidth(tick.label, label, measure));
  return most;
}

/** Pixels a y axis on the right takes beside its plot: ticks, labels, and title. */
function breadth(kit: GuideKit, axis: ListedAxis, state: AxesState, i: number): number {
  const layers = placedLayers(kit, axis, state, i, state.plan(axis.scale, i, 0));
  const title = titleOf(axis, i) ? kit.textHeight(titlePaint(kit, axis, state, i)) + GAP : 0;
  return (
    outward(axis.layers) + Y_GAP + Math.ceil(widest(kit, layers, state.measure)) + GAP + 2 + title
  );
}

/** How much wider than the major layer's labels, which the model keeps room for, a y axis' other layers' are. */
function widerBy(kit: GuideKit, axis: ListedAxis, state: AxesState, i: number): number {
  const [major, ...others] = placedLayers(kit, axis, state, i, state.plan(axis.scale, i, 0));
  if (others.length === 0) return 0;
  const { measure } = state;
  return Math.max(0, Math.ceil(widest(kit, others, measure) - widest(kit, [major!], measure)));
}

/** Panel `i`'s default axis `guide` drawn as the listed axis `axis` asks, its layers placed. */
function rebuild(
  kit: GuideKit,
  guide: AxisGuide,
  axis: ListedAxis,
  layers: Placed[],
  state: AxesState,
  i: number,
): AxisGuide {
  // The major layer shows what the default axis shows: none where the panel has nothing to label.
  if (guide.ticks.length === 0) layers[0]!.ticks = [];
  // The model resolves line paints for x axes only, which draw lines by default.
  const line = axis.line && state.styles.axisStroke("axisLine", axis.scale, i);
  const items = drawn(kit, guide, layers, line, state.measure, state);
  if (guide.title)
    items.push(
      titleItem(kit, guide.side, guide.title, guide.paints.title, guide.surface, state.measure),
    );
  return { ...guide, ticks: layers[0]!.ticks, items, layers: axis.layers.map(({ id }) => id) };
}

/** The title of an axis elsewhere in panel `i`: a subplot's own, or the axis'. */
function titleOf(axis: ListedAxis, i: number): string | undefined {
  return axis.titles?.[i] ?? axis.title;
}

/** How an axis elsewhere writes its title in panel `i`: the scale's axis title paint, and its own style. */
function titlePaint(kit: GuideKit, axis: ListedAxis, state: AxesState, i: number): TextPaint {
  return restyle(
    kit,
    state.styles.read,
    state.styles.axisText("axisTitle", axis.scale, i),
    axis.style?.axisTitle,
    `${axis.path}.style.axisTitle`,
  );
}

/** Panel `i`'s listed axis `axis` on a side of `plot` other than its scale's default one, its layers placed. */
function beyond(
  kit: GuideKit,
  axis: ListedAxis,
  layers: Placed[],
  state: AxesState,
  i: number,
  plot: Rect,
): AxisGuide {
  const { styles, surface, measure } = state;
  const above = axis.side === "top";
  const paints = {
    line: restroke(
      kit,
      styles.read,
      styles.axisStroke("axisLine", axis.scale, i),
      axis.style?.axisLine,
      `${axis.path}.style.axisLine`,
    ),
    tick: layers[0]!.tick,
    label: layers[0]!.label,
    title: titlePaint(kit, axis, state, i),
  };
  const placement = {
    side: axis.side,
    edge: above ? plot.y : plot.x + plot.width,
    start: above ? plot.x : plot.y + plot.height,
    end: above ? plot.x + plot.width : plot.y,
    tickLength: outward(axis.layers),
    gap: above ? kit.tickLabelGap(paints.label.size) : Y_GAP,
    surface,
    paints,
  };
  const items = drawn(kit, placement, layers, axis.line && paints.line, measure, state);
  let title: AxisGuide["title"];
  const text = titleOf(axis, i);
  if (text) {
    // Beyond the labels: the axis' room less half the title's line.
    const room = above ? depthOf(kit, axis, state, i, layers) : breadth(kit, axis, state, i);
    const half = kit.textHeight(paints.title) / 2;
    // Along the plot as its style aligns it: left to right above, top to bottom on the right.
    const along = kit.aligned(
      paints.title.align ?? "center",
      above ? plot.x : plot.y,
      above ? plot.width : plot.height,
    );
    title = above
      ? { text, x: along.at, y: placement.edge - room + half, anchor: along.anchor }
      : { text, x: placement.edge + room - half, y: along.at, anchor: along.anchor };
    items.push(titleItem(kit, axis.side, title, paints.title, surface, measure));
  }
  return {
    kind: "axis",
    key: `${axis.key}|${i}`,
    scale: axis.scale,
    ...placement,
    ticks: layers[0]!.ticks,
    title,
    items,
    layers: axis.layers.map(({ id }) => id),
  };
}

/**
 * Where a label centered at `x` goes: there, or for rows beyond the first,
 * whose labels' room the margins do not keep, moved inside the chart.
 */
function inside(
  x: number,
  label: string,
  paint: TextPaint,
  measure: MeasureText,
  row: number,
  width: number,
): number {
  if (row === 0) return x;
  const half = Math.max(...label.split("\n").map((line) => measure(line, paint.css))) / 2;
  return Math.min(Math.max(x, half + 2), width - half - 2);
}

/** An axis' title: across an axis along x, turned beside one along y. */
function titleItem(
  kit: GuideKit,
  side: Side,
  title: NonNullable<AxisGuide["title"]>,
  paint: TextPaint,
  surface: string,
  measure: MeasureText,
): TextItem {
  const angle = side === "left" ? -90 : side === "right" ? 90 : 0;
  return kit.textItem(
    title.text,
    { x: title.x, y: title.y, anchor: title.anchor ?? "middle", baseline: "middle", angle },
    paint,
    surface,
    measure,
  );
}

/**
 * The items of an axis at `placement`: its line, each layer's tick marks
 * (one stroke for those that look alike, each position once, as long as
 * the longest there), and labels in rows outward from the line.
 */
export function drawn(
  kit: GuideKit,
  placement: Pick<AxisGuide, "side" | "edge" | "start" | "end" | "gap" | "surface">,
  layers: readonly Placed[],
  line: StrokePaint | false,
  measure: MeasureText,
  { width }: { readonly width: number },
): GuideItem[] {
  const { side } = placement;
  const across = side === "top" || side === "bottom";
  const out = side === "bottom" || side === "right" ? 1 : -1;
  // Lines fall on pixel centers, so 1-pixel lines are crisp.
  const edge = Math.round(placement.edge) + 0.5;
  const point = (along: number, from: number) => (across ? [along, from] : [from, along]);
  const strokes = new Map<
    string,
    { paint: StrokePaint; coords: number[]; at: Map<number, number[]> }
  >();
  const strokeOf = (paint: StrokePaint) => {
    const key = kit.strokeKey(paint);
    let found = strokes.get(key);
    if (!found) {
      found = { paint, coords: [], at: new Map() };
      strokes.set(key, found);
    }
    return found;
  };
  if (line)
    strokeOf(line).coords.push(...point(placement.start, edge), ...point(placement.end, edge));
  for (const { layer, ticks, tick: paint } of layers) {
    const tick = layer.tick;
    if (!tick) continue;
    const { length, direction } = tick;
    const reach =
      direction === "out"
        ? [0, length]
        : direction === "in"
          ? [-length, 0]
          : [-length / 2, length / 2];
    const { at } = strokeOf(paint);
    for (const { position } of ticks) {
      const where = Math.round(position) + 0.5;
      const before = at.get(where);
      if (before) at.set(where, [Math.min(before[0]!, reach[0]!), Math.max(before[1]!, reach[1]!)]);
      else at.set(where, reach);
    }
  }
  const items: GuideItem[] = [];
  for (const { paint, coords, at } of strokes.values()) {
    for (const [where, [from, to]] of at)
      coords.push(...point(where, edge + out * from!), ...point(where, edge + out * to!));
    if (coords.length > 0) items.push({ type: "segments", coords, paint });
  }
  // Labels clear the outward ticks longer than the default axes keep room for.
  const reach = outward(layers.map(({ layer }) => layer));
  const rows = rowDepths(kit, layers, measure);
  for (const placed of layers) {
    const { layer, ticks, angle, lane: lanes, label: paint } = placed;
    const labels = layer.labels;
    if (!labels) continue;
    let away = placement.gap + (across ? Math.max(0, reach - TICK) : reach);
    for (let row = 0; row < labels.row; row++) away += (rows[row] ?? 0) + ROW_GAP;
    const lane = laneDepth(kit, placed, measure) + ROW_GAP;
    const { anchor, cos } = turned(angle, side === "top");
    ticks.forEach(({ position, label }, k) => {
      if (!label) return;
      const distance = away + (lanes[k] ?? 0) * lane;
      let at: Parameters<GuideKit["textItem"]>[1];
      if (!across) {
        // As the default y axes place labels: from the axis' line as given,
        // inside the chart (see `layered`).
        at = {
          x: placement.edge + out * distance,
          // The first of a label's lines, the block centered where it is drawn.
          y: (placed.at?.[k] ?? position) - ((label.split("\n").length - 1) * paint.lineHeight) / 2,
          anchor: side === "left" ? "end" : "start",
          baseline: "middle",
          angle: 0,
        };
      } else if (angle)
        at = {
          x: position,
          y: edge + out * (distance + (kit.textHeight(paint) / 2) * cos),
          anchor,
          baseline: "middle",
          angle,
        };
      else
        at =
          side === "bottom"
            ? {
                x: inside(position, label, paint, measure, labels.row, width),
                y: edge + distance,
                anchor: "middle",
                baseline: "hanging",
                angle: 0,
              }
            : {
                x: inside(position, label, paint, measure, labels.row, width),
                // The first line, of as many as the label has, whose block
                // (and box) ends where labels below it begin.
                y:
                  edge -
                  distance -
                  kit.textHeight(paint) / 2 -
                  (label.split("\n").length - 1) * paint.lineHeight,
                anchor: "middle",
                baseline: "middle",
                angle: 0,
              };
      items.push(...kit.textItems(label, at, paint, placement.surface, measure));
    });
  }
  return items;
}
