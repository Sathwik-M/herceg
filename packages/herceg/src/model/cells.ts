// Where subplots go: the cells their layout gives them (layout/compile.ts),
// sized by the solver (layout/grid.ts) from what each panel needs beside
// its plot, then insets on their parents' plots (layout/insets.ts). Which
// panels label their axes follows from the layout too: panels lined up with
// others that share a scale label it on the outer edge only. Loaded with
// subplots only.

import { type CompiledLayout, type InsetNode, linedUp } from "../layout/compile.ts";
import { isShort, leastLength, solveAxis } from "../layout/grid.ts";
import { clearSpans, indicator, insetSpan, uncovered } from "../layout/insets.ts";
import { aligned } from "../layout/place.ts";
import type { Rect } from "../scene/scene.ts";
import { ChartError } from "../spec/errors.ts";
import type { Side } from "../spec/place.ts";
import { EDGE, GAP } from "./legend.ts";
import type { Keep, PanelGrid, PanelPlacement } from "./panel-layout.ts";

/** The least plot of a panel among others, in pixels across and down. */
const LEAST = { x: 48, y: 32 };

/** How far x labels may reach past a cell into the gap beside it: half of it, up to this. */
const REACH = 6;

/** Pixels between a legend beside a panel and what is beside it. */
const LEGEND_GAP = 4;

/** Room panels needed beside their plots along an axis, kept from one scene to the next. */
interface Kept {
  key: string;
  before: Float64Array;
  after: Float64Array;
}

/** A panel's cell and plot along an axis: a start and an end per panel. */
interface Spans {
  outer: Float64Array;
  plot: Float64Array;
}

/**
 * The placement of a layout's panels, kept across scenes: what panels needed
 * beside their plots, which stays the least they get while data streams.
 */
export class Cells {
  readonly #layout: CompiledLayout;
  /** Which panels have titles above them. */
  readonly #titled: readonly boolean[];
  #kept: { x?: Kept; y?: Kept } = {};
  #spans: { x?: Spans; y?: Spans } = {};
  /**
   * The last scene's legends beside panels, with their panels' indexes; the
   * room each panel's plot keeps above for them, below for its x labels,
   * and above for the axes the guides list there.
   */
  #beside: {
    index: number;
    side: Side;
    align: "start" | "center" | "end";
    offset: number;
    width: number;
    height: number;
  }[] = [];
  #lifts = new Float64Array(0);
  #under: readonly number[] = [];
  #over: readonly number[] = [];
  /** The widths `span` gave legends of panels this scene, by panel (see `again`). */
  #handed: [index: number, width: number][] = [];
  /** By panel, the widths the last scene's legends beside panels wrapped at, which its plots held. */
  #widths = new Map<number, number>();
  /** With insets, the last scene's panels' keys and boxes in the order they are drawn (see `coveredAt`). */
  #painted: readonly { key: string; cover: Rect | undefined }[] = [];

  constructor(layout: CompiledLayout, titled: readonly boolean[]) {
    this.#layout = layout;
    this.#titled = titled;
  }

  /** The placement of one scene's panels, their titles `grid.header` tall. */
  placement(grid: PanelGrid): PanelPlacement {
    const layout = this.#layout;
    this.#handed = [];
    // What earlier scenes kept, for a scene laid out again (see `again`),
    // and whether this one starts anew (at another size).
    const kept = { ...this.#kept };
    let reset = false;
    const count = layout.order.length;
    // What each panel needs beside its plot across, as the last horizontal placing found.
    let before = new Float64Array(count);
    let after = new Float64Array(count);
    // Of that, what legends beside the panels take, at the room's outer edge.
    let legends = { left: new Float64Array(count), right: new Float64Array(count) };
    const labels = (
      along: "x" | "y",
      after: boolean,
      groupOf: readonly number[],
      eligible: readonly boolean[],
      repeat: "outer" | "all" | undefined,
    ) => {
      const beyond = after ? 1 : -1;
      return eligible.map(
        (shows, i) =>
          shows &&
          (repeat === "all" ||
            !groupOf.some(
              (g, j) =>
                j !== i &&
                g === groupOf[i] &&
                eligible[j] &&
                linedUp(layout, i, j, along) === beyond,
            )),
      );
    };
    return {
      labels: (along, after, groupOf, eligible, repeat) =>
        labels(along, after, groupOf, eligible, repeat),

      vertical: (v) => {
        // Above a plot, its title, or the reach of its y labels' boxes past
        // the top tick (of any labels in an inset's box, which holds them),
        // and the axes the guides list above it.
        const reach = (i: number) =>
          layout.places[i]!.inset ? v.yReachIn[i]! : v.axes[i] ? v.yReach : 0;
        const above = Float64Array.from(
          layout.order,
          (_, i) => Math.max(this.#titled[i] ? grid.header : 0, reach(i)) + v.over[i]!,
        );
        const below = Float64Array.from(layout.order, (_, i) => Math.max(v.under[i]!, reach(i)));
        // Legends above and below a panel take room there, beyond the axes
        // there, its title staying above them.
        this.#under = v.under;
        this.#over = v.over;
        this.#beside = v.head.beside.map(({ panel, place, measured }) => {
          const index = layout.order.indexOf(panel);
          if (index < 0)
            throw new ChartError({
              code: "unknown-reference",
              message: `chart legend place.panel: no panel "${panel}"; name one of ${layout.order.map((key) => `"${key}"`).join(", ")}`,
            });
          return {
            index,
            side: place.side,
            align: place.align ?? "start",
            offset: place.offset ?? 0,
            width: measured.width,
            height: measured.height,
          };
        });
        this.#lifts = new Float64Array(count);
        for (const { index, side, height, offset } of this.#beside) {
          if (side === "top") this.#lifts[index]! += height + LEGEND_GAP + offset;
          if (side === "bottom") below[index]! += height + LEGEND_GAP + offset;
        }
        for (let i = 0; i < count; i++) above[i]! += this.#lifts[i]!;
        // A plot is at least as tall as the legends beside it.
        const tall = new Float64Array(count).fill(LEAST.y);
        for (const { index, side, height } of this.#beside)
          if (side === "left" || side === "right") tall[index] = Math.max(tall[index]!, height);
        const bottom = v.height - v.head.lift - (v.head.auto ? 2 : 0);
        const least = leastLength(layout, "y", { before: above, after: below, least: tall });
        const strip = v.navigator ? v.navigator.room(bottom - v.top, least) : 0;
        const { plot } = this.#place(
          "y",
          v.top,
          bottom - strip,
          above,
          below,
          v.keep,
          v.height,
          tall,
        );
        const ys: number[] = [];
        const hs: number[] = [];
        for (let i = 0; i < count; i++) {
          ys[i] = plot[2 * i]!;
          hs[i] = Math.max(1, plot[2 * i + 1]! - plot[2 * i]!);
        }
        return { ys, hs, top: Math.min(...ys), strip };
      },

      horizontal: (h) => {
        const { head } = h;
        reset = h.keep === "reset";
        const edgeRoom = Math.floor(h.width / 4);
        const [left, right] = h.sides;
        const title = (side: typeof left, i: number) => (side.titled.includes(i) ? side.title : 0);
        // Beside a plot, its y labels and titles, and what the guides' axes add there.
        before = Float64Array.from(layout.order, (_, i) =>
          left.labeled[i] ? left.reach[i]! + title(left, i) + (h.beside?.left ?? 0) : 0,
        );
        after = Float64Array.from(
          layout.order,
          (_, i) =>
            (right.labeled[i] ? right.reach[i]! + title(right, i) : 0) +
              (right.labeled[i] || h.beside?.after[i] ? (h.beside?.right ?? 0) : 0) ||
            (head.auto ? 12 - EDGE : 0),
        );
        // Legends beside a panel take room there, beyond its y labels and titles.
        legends = { left: new Float64Array(count), right: new Float64Array(count) };
        for (const { index, side, width, offset } of this.#beside) {
          if (side === "left") legends.left[index]! += width + 2 * LEGEND_GAP + offset;
          if (side === "right") legends.right[index]! += width + 2 * LEGEND_GAP + offset;
        }
        for (let i = 0; i < count; i++) {
          before[i]! += legends.left[i]!;
          after[i]! += legends.right[i]!;
        }
        const start = head.left + (head.auto ? EDGE : 0);
        const end = h.width - head.right - (head.auto ? EDGE : 0);
        const xs: number[] = [];
        const ws: number[] = [];
        let spans: Spans;
        const place = () => {
          spans = this.#place("x", start, end, before, after, h.keep, h.width);
          for (let i = 0; i < count; i++) {
            xs[i] = spans.plot[2 * i]!;
            ws[i] = Math.max(10, spans.plot[2 * i + 1]! - spans.plot[2 * i]!);
          }
          h.plan(Math.min(...xs), ws);
        };
        place();
        // A panel whose first or last x label reaches past its cell (by more
        // than half the gap between cells, or into the chart's edge) needs
        // that much more room beside its plot, up to a quarter of the chart;
        // an inset's labels stay in its box, which is refused when too small.
        for (let pass = 0; pass < 10 && h.widens && h.keep !== "frozen"; pass++) {
          let grew = false;
          const left0 = Math.min(...xs);
          for (let i = 0; i < count; i++) {
            const ends = h.ends(i, ws[i]!);
            if (!ends) continue;
            const inset = !!layout.places[i]!.inset;
            const most = inset ? Infinity : edgeRoom;
            const reach = (end: boolean) =>
              inset
                ? 0
                : this.edge(i, end)
                  ? head.auto
                    ? EDGE - 2
                    : 0
                  : Math.min(REACH, this.#gutter(i, end) / 2);
            const lo = spans!.outer[2 * i]! - reach(false);
            const hi = spans!.outer[2 * i + 1]! + reach(true);
            const shift = xs[i]! - left0;
            if (ends[0] + shift < lo - 0.5 && before[i]! < most) {
              before[i] = Math.min(most, before[i]! + Math.ceil(lo - ends[0] - shift));
              grew = true;
            }
            if (ends[1] + shift > hi + 0.5 && after[i]! < most) {
              after[i] = Math.min(most, after[i]! + Math.ceil(ends[1] + shift - hi));
              grew = true;
            }
          }
          if (!grew) break;
          place();
        }
        return { xs, ws, left: Math.min(...xs) };
      },

      edge: (i, end) => this.edge(i, end),

      span: (panel, start, end, fresh) => {
        // What the last scene of the layout as it is wrapped at; anew, a
        // guess no narrower than the plot will be (its cell, or the chart
        // for an inset), so that the legend is no taller than it will be.
        const i = panel === undefined ? 0 : layout.order.indexOf(panel);
        const kept = fresh ? undefined : this.#widths.get(i);
        const guess = this.#estimate(start, end);
        const width = kept ?? (guess[2 * i + 1]! - guess[2 * i]! || end - start);
        this.#handed.push([i, width]);
        return width;
      },

      again: () => {
        const { plot } = this.#spans.x!;
        const handed = this.#handed;
        this.#handed = [];
        // A legend wider than its plot wraps again at the plot's width; one
        // narrower stays as it is, as margins do while the layout stays.
        const actual = (i: number) => plot[2 * i + 1]! - plot[2 * i]!;
        const over = handed.some(([i, width]) => width > actual(i) + 1);
        this.#widths = new Map(
          handed.map(([i, width]) => [i, over ? Math.min(width, actual(i)) : width]),
        );
        // Laid out again, the room this scene's first try kept goes: back to
        // what earlier scenes kept, or none for a scene starting anew.
        if (over) this.#kept = reset ? {} : kept;
        return over;
      },

      beside: (k, plot) => {
        const { index, side, align, offset, width, height } = this.#beside[k]!;
        const across = side === "top" || side === "bottom";
        // Each further from the plot than the legends of its side before it,
        // and where its `align` says along the plot.
        let nearer = 0;
        for (const other of this.#beside.slice(0, k))
          if (other.index === index && other.side === side)
            nearer += (across ? other.height : other.width) + LEGEND_GAP + other.offset;
        const share = align === "start" ? 0 : align === "center" ? 0.5 : 1;
        const x = plot.x + share * (plot.width - width);
        const y = plot.y + share * (plot.height - height);
        const bottom = plot.y + plot.height + this.#under[index]!;
        if (side === "top")
          return { x, y: plot.y - this.#over[index]! - LEGEND_GAP - offset - height - nearer };
        if (side === "bottom") return { x, y: bottom + LEGEND_GAP + offset + nearer };
        if (side === "left") return { x: plot.x - before[index]! + LEGEND_GAP + nearer, y };
        return { x: plot.x + plot.width + after[index]! - LEGEND_GAP - width - nearer, y };
      },

      finish: (panels, views, theme, ratio) => {
        if (!layout.places.some(({ inset }) => inset)) return undefined;
        this.#apart();
        const viewOf = (i: number) => views.find(({ key }) => key === layout.order[i]);
        const scalesOf = (i: number) => {
          const frame = viewOf(i)?.inspector.frame;
          return frame && { x: frame.x, y: frame.y };
        };
        layout.places.forEach((place, i) => {
          const panel = panels[i]!;
          const view = viewOf(i);
          if (place.inset) {
            // An inset has a border of its own over what it covers.
            panel.cover = this.#box(i);
            panel.frame ??= {
              fill: undefined,
              stroke: theme.style.axisLine.stroke,
              strokeWidth: 1,
            };
            if (view) view.cover = panel.cover;
          }
          // The insets drawn over its plot: its own (insets stay inside their
          // parents' plots, so no other panel's reach it).
          const { plot } = panel;
          const boxes = layout.places.flatMap((other, j) =>
            other.parent === i ? [this.#box(j)] : [],
          );
          if (boxes.length > 0) {
            const visible = uncovered(plot, boxes);
            panel.visible = visible;
            if (view) view.visible = visible;
            // Its grid lines where their strokes, on pixels, keep clear of the boxes.
            const { grid } = panel;
            // A line of one pixel is a device pixel wide on a canvas, and
            // snapped to a device pixel's center, moves by up to one.
            const half = ({ strokeWidth } = theme.style.grid) =>
              (strokeWidth === 1 ? Math.max(1, 1 / ratio) : strokeWidth) / 2 +
              1 / Math.min(1, ratio);
            panel.grid = {
              ...grid,
              ySpans: grid.y.map((y) => clearSpans(visible, plot, "y", y, half(grid.yPaint))),
              xSpans: grid.x.map((x) => clearSpans(visible, plot, "x", x, half(grid.xPaint))),
            };
          }
          for (const [j, other] of layout.places.entries()) {
            const node = other.inset;
            if (other.parent !== i || !node?.spec.indicator) continue;
            const shown = indicator(
              node.spec,
              node.path,
              layout.order[j]!,
              scalesOf(i),
              scalesOf(j),
              this.#box(j),
              theme,
            );
            if (shown) panel.marks.push(shown);
          }
        });
        // Panels in cells together, the navigator's strip among them, then each inset over them.
        const layers = [
          panels.filter((panel) => !panel.cover),
          ...panels.filter((p) => p.cover).map((p) => [p]),
        ];
        this.#painted = layers.flat().map(({ key, cover }) => ({ key, cover }));
        return layers;
      },

      yTitle: (i, plot, right, size) => ({
        // At the outer edge of the room the panel keeps beside its plot, inside its legends there.
        x: right
          ? plot.x + plot.width + after[i]! - legends.right[i]! - size / 2
          : plot.x - before[i]! + legends.left[i]! + size / 2,
        span: [plot.y + plot.height, plot.y],
      }),

      xTitle: (_i, plot, titling) => {
        // Under each labeled panel's own labels.
        if (!titling.own) return undefined;
        const along = aligned(titling.align ?? "center", plot.x, plot.width);
        return {
          text: titling.own,
          x: along.at,
          anchor: along.anchor,
          y: plot.y + plot.height + titling.labels + titling.size / 2 + GAP,
        };
      },

      cells: (xGroupOf, withAxes, yGroupOf, drawsY, start, end) => {
        // By axis: where it goes, of the panels it is not hidden in.
        const kept = new Map<object, boolean[]>();
        let guess: Float64Array | undefined;
        const place = (
          axis: { repeat: "outer" | "all" | undefined; off?: readonly boolean[] | undefined },
          along: "x" | "y",
        ) => {
          let found = kept.get(axis);
          if (!found) {
            const [groupOf, eligible] = along === "x" ? [xGroupOf, withAxes] : [yGroupOf(), drawsY];
            const shown = eligible.map((drawn, j) => drawn && !axis.off?.[j]);
            found = labels(along, along === "y", groupOf, shown, axis.repeat);
            kept.set(axis, found);
          }
          return found;
        };
        return {
          top: (i, axis) => place(axis, "x")[i]!,
          last: (i, axis) => place(axis, "y")[i]!,
          width: (i) => {
            guess ??= this.#estimate(start, end);
            return guess[2 * i + 1]! - guess[2 * i]!;
          },
          within: (i) => {
            const down = this.#spans.y?.outer;
            return layout.places[i]?.inset && down ? [down[2 * i]!, down[2 * i + 1]!] : undefined;
          },
        };
      },
    };
  }

  /** Whether panel `key` of the last scene is under an inset at a point (see `PanelLayout.coveredAt`). */
  coveredAt(key: string, x: number, y: number): boolean {
    const painted = this.#painted;
    const at = painted.findIndex((panel) => panel.key === key);
    return painted.some(
      ({ cover }, k) =>
        k > at &&
        cover !== undefined &&
        x >= cover.x &&
        x <= cover.x + cover.width &&
        y >= cover.y &&
        y <= cover.y + cover.height,
    );
  }

  /**
   * Refuses insets whose boxes overlap but for one inside the other: an
   * inset covers its parent's data only, so insets side by side keep apart.
   */
  #apart(): void {
    const { places, order } = this.#layout;
    const within = (i: number, j: number): boolean => {
      for (let p = places[i]!.parent; p !== undefined; p = places[p]!.parent)
        if (p === j) return true;
      return false;
    };
    for (let i = 0; i < places.length; i++)
      for (let j = i + 1; j < places.length; j++) {
        if (!places[i]!.inset || !places[j]!.inset || within(i, j) || within(j, i)) continue;
        const [a, b] = [this.#box(i), this.#box(j)];
        if (
          Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x) > 1e-6 &&
          Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) > 1e-6
        )
          throw new ChartError({
            code: "layout-failed",
            phase: "layout",
            path: places[j]!.inset!.path,
            panel: order[j],
            message: `${places[j]!.inset!.path}: inset "${order[j]}" overlaps inset "${order[i]}"; place them apart, or one inside the other`,
          });
      }
  }

  /** Panel `i`'s cell (an inset's box) as the last scene placed it. */
  #box(i: number): Rect {
    const x = this.#spans.x!.outer;
    const y = this.#spans.y!.outer;
    return {
      x: x[2 * i]!,
      y: y[2 * i]!,
      width: x[2 * i + 1]! - x[2 * i]!,
      height: y[2 * i + 1]! - y[2 * i]!,
    };
  }

  /** The room above panel `i`'s plot the last scene's legends there took, under its title. */
  lift(i: number): number {
    return this.#lifts[i] ?? 0;
  }

  /** Whether panel `i`'s cell starts (or with `end`, ends) where the layout does along x. */
  edge(i: number, end: boolean): boolean {
    const chain = this.#layout.places[i]!.chain;
    return (
      chain.length > 0 &&
      chain.every((f) => (end ? f.column1 === f.grid.columns.length : f.column0 === 0))
    );
  }

  /**
   * The gap between panel `i`'s cell and the next one before it (or with
   * `end`, after it): of the innermost grid where its cell has a neighbor
   * on that side.
   */
  #gutter(i: number, end: boolean): number {
    const chain = this.#layout.places[i]!.chain;
    for (let k = chain.length - 1; k >= 0; k--) {
      const f = chain[k]!;
      if (end ? f.column1 < f.grid.columns.length : f.column0 > 0) return f.grid.columnGap;
    }
    return 0;
  }

  /** Each panel's plot across from `start` to `end`, needing no room beside it: a first guess. */
  #estimate(start: number, end: number): Float64Array {
    const none = new Float64Array(this.#layout.order.length);
    const solved = solveAxis(this.#layout, "x", start, end, {
      before: none,
      after: none,
      least: 0,
    });
    return isShort(solved) ? new Float64Array(2 * none.length) : solved.plot;
  }

  /**
   * Places every panel's cell and plot along `axis` between `start` and
   * `end`, each panel needing `before` and `after` its plot: grids by the
   * solver, then insets on their parents' plots. With `keep` "grow", what
   * panels needed in the last scene of this layout stays the least they
   * get, so that plots do not move as labels change while data streams;
   * "frozen" places them as the last scene did. Insets placed on the chart
   * take its `size` along the axis. Throws when they cannot fit.
   */
  #place(
    axis: "x" | "y",
    start: number,
    end: number,
    before: Float64Array,
    after: Float64Array,
    keep: Keep,
    size: number,
    least: number | Float64Array = LEAST[axis],
  ): Spans {
    const layout = this.#layout;
    const key = `${start} ${end}`;
    const kept = this.#kept[axis];
    if (keep === "frozen" && kept && this.#spans[axis]) return this.#spans[axis];
    if (keep !== "reset" && kept?.key === key)
      for (let i = 0; i < before.length; i++) {
        before[i] = Math.max(before[i]!, kept.before[i]!);
        after[i] = Math.max(after[i]!, kept.after[i]!);
      }
    const solved = solveAxis(layout, axis, start, end, { before, after, least });
    const word =
      axis === "x" ? ["width", "wider", "column", "across"] : ["height", "taller", "row", "down"];
    if (isShort(solved)) {
      const { fixed } = solved;
      throw new ChartError({
        code: "layout-failed",
        phase: "layout",
        ...(fixed && { panel: layout.order[fixed.panel] }),
        message: fixed
          ? `layout: panel "${layout.order[fixed.panel]}" needs a plot of ${Math.ceil(fixed.needed)} px ${word[3]}, and its ${word[2]} gives it ${Math.floor(fixed.size)} px; make the ${word[2]} larger`
          : `layout: needs at least ${Math.ceil(solved.needed)} px of ${word[0]} for its panels' plots, titles, and axes, and has ${Math.floor(end - start)} px; make the chart ${word[1]}, or use fewer fixed tracks, minimum sizes, or guides`,
      });
    }
    for (const [i, place] of layout.places.entries()) {
      const node = place.inset;
      if (!node) continue;
      const p = place.parent!;
      const span = insetSpan(
        node.spec,
        axis,
        solved.plot[2 * p]!,
        solved.plot[2 * p + 1]!,
        0,
        size,
        node.path,
      );
      // Over its parent's data only: what else the parent and other panels
      // draw (axes, titles, legends, the pointer's marks) stays clear of it.
      if (span[0] < solved.plot[2 * p]! - 1e-6 || span[1] > solved.plot[2 * p + 1]! + 1e-6)
        throw new ChartError({
          code: "layout-failed",
          phase: "layout",
          path: node.path,
          panel: layout.order[i],
          message: `${node.path}: inset "${layout.order[i]}" reaches outside its parent's plot ${word[3]}; place it inside the plot, or make it smaller`,
        });
      [solved.outer[2 * i], solved.outer[2 * i + 1]] = span;
      solved.plot[2 * i] = span[0] + before[i]!;
      solved.plot[2 * i + 1] = span[1] - after[i]!;
      const shortest = typeof least === "number" ? least : least[i]!;
      if (solved.plot[2 * i + 1]! - solved.plot[2 * i]! < shortest - 0.5)
        throw insetShort(
          node,
          layout.order[i]!,
          word[3]!,
          span[1] - span[0],
          before[i]! + after[i]! + shortest,
        );
    }
    this.#kept[axis] = { key, before: before.slice(), after: after.slice() };
    this.#spans[axis] = solved;
    return solved;
  }
}

/** An inset too small for its plot and guides. */
function insetShort(
  node: InsetNode,
  id: string,
  across: string,
  size: number,
  needed: number,
): ChartError {
  return new ChartError({
    code: "layout-failed",
    phase: "layout",
    path: node.path,
    panel: id,
    message: `${node.path}: inset "${id}" needs ${Math.ceil(needed)} px ${across} for its plot, title, and axes, and has ${Math.floor(size)} px; make it larger or hide its axes`,
  });
}
