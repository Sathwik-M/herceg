// Where a facet's panels go: a uniform grid of `columns` by `rows`, panel i
// at row floor(i / columns) and column i % columns, rows sharing the height
// left for plots and columns the width (equally, or by weights), with one
// gap between rows and one between columns. The model places a chart of one
// panel itself, and subplots go where their layout puts them
// (model/panels.ts); this loads with facets.

import { aligned } from "../layout/place.ts";
import { EDGE, GAP } from "./legend.ts";
import {
  columnGap,
  type PanelGrid,
  type PanelPlacement,
  rowGap,
  trackSizes,
} from "./panel-layout.ts";

/** The placement of `count` panels in `grid`, refusing panels too small with `remedy` saying what to do. */
export function uniformPlacement(grid: PanelGrid, count: number, remedy: string): PanelPlacement {
  const { columns, rows, header, columnHeader, rowHeader } = grid;
  const rowOf = (i: number) => Math.floor(i / columns);
  // What placing the panels found, for their titles.
  let rowHeights: number[] = [];
  let between = 0;
  let widths: number[] = [];
  let offsets: number[] = [];
  let left = 0;
  let top = 0;
  // Where the lowest row's x titles go: above what the chart keeps under everything.
  let bottom = 0;
  return {
    labels(along, after, _groupOf, eligible, repeat, own) {
      // x labels under the lowest panel with axes of each column; y labels
      // beside each row's first panel on the left, its last on the right;
      // with `repeat` "all", beside every panel.
      return eligible.map(
        (shows, i) =>
          shows &&
          (own ||
            repeat === "all" ||
            (along === "x"
              ? (grid.lowest?.[i] ?? i + columns >= count)
              : after
                ? i % columns === columns - 1 || i === count - 1
                : i % columns === 0)),
      );
    },

    vertical(v) {
      top = v.top;
      // Rows of panels leave room between them for what goes there (see
      // `rowGap`), and for both rows' y label boxes reaching into it, past
      // what goes between them (x labels too, then the next row's boxes).
      // Axes the guides list above the plots take room over the first row,
      // and between rows when the panels under them draw them too.
      let first = 0;
      let later = 0;
      v.over.forEach((room, i) => {
        if (rowOf(i) === 0) first = Math.max(first, room);
        else later = Math.max(later, room);
      });
      between = Math.max(rowGap(grid, count, v.space) + v.yOver, 2 * v.yReach - header) + later;
      // Rows share the height left for plots equally, or by the grid's
      // weights, and a navigator's strip goes under the x axis when they
      // leave room for it.
      let free =
        v.height - top - first - v.below - columnHeader - (rows - 1) * between - rows * header;
      const strip = v.navigator ? v.navigator.room(free, grid.least) : 0;
      free -= strip;
      bottom = v.height - v.head.lift - strip - (v.head.auto ? 2 : 0);
      rowHeights = trackSizes(free, rows, grid.rowWeights, count, columns, v.room, remedy).map(
        (h) => Math.max(10, h),
      );
      const plotTop = top + first + columnHeader + header;
      const ys: number[] = [];
      const hs: number[] = [];
      for (let i = 0; i < count; i++) {
        const row = rowOf(i);
        let offset = 0;
        for (let r = 0; r < row; r++) offset += rowHeights[r]! + header + between;
        ys[i] = plotTop + offset;
        hs[i] = rowHeights[row]!;
      }
      return { ys, hs, top: plotTop, strip };
    },

    horizontal(h) {
      const { width, head, kept, keep, beside } = h;
      const edgeRoom = Math.floor(width / 4);
      const [leftSide, rightSide] = h.sides;
      const sameLayout = keep !== "reset";
      const frozen = keep === "frozen";
      // The widest label starts at the chart's edge inset, in line with the title.
      left =
        head.left +
        leftSide.room +
        (leftSide.room && leftSide.title) +
        (head.auto ? EDGE : 0) +
        (beside?.left ?? 0);
      if (frozen) left = kept.left;
      else if (sameLayout) left = Math.max(left, kept.left);
      // The right labels decide the right margin, with a grid's row headers
      // and the right title beyond them.
      const rightRoom = rightSide.room + (beside?.right ?? 0);
      let right =
        head.right +
        (rightRoom || rowHeader
          ? rightRoom + (rowHeader && rowHeader + GAP) + rightSide.title + (head.auto ? EDGE : 0)
          : head.auto
            ? 12
            : 0);
      if (frozen) right = kept.right;
      else if (sameLayout) right = Math.max(right, kept.right);
      // Between columns: the right labels and titles of the panels before,
      // and the left ones of those after, when panels label their own.
      const room = (side: typeof leftSide, after: boolean) =>
        side.own ? columnGap(side.labeled, after, columns, side.room, 0) : 0;
      // Axes the guides list on the right of panels before the last of a row.
      const inner = beside?.after.some((drawn, i) => drawn && i % columns !== columns - 1);
      const labelRoom = room(leftSide, false) + room(rightSide, true) + (inner ? beside!.right : 0);
      let gapAcross = columns > 1 ? Math.max(16, labelRoom, sameLayout ? kept.columnGap : 0) : 0;
      if (frozen) gapAcross = kept.columnGap;
      const weighted = grid.columnWeights !== undefined;
      const xs: number[] = [];
      const ws: number[] = [];
      const layoutColumns = () => {
        const free = width - left - right - (columns - 1) * gapAcross;
        widths = trackSizes(free, columns, grid.columnWeights, count, columns, h.room, remedy).map(
          (w) => Math.max(10, w),
        );
        // Where each column starts, from `left`; equal columns a whole step apart.
        offsets = widths.map((_, c) => (weighted ? 0 : c * (widths[0]! + gapAcross)));
        for (let c = 1; weighted && c < columns; c++)
          offsets[c] = offsets[c - 1]! + widths[c - 1]! + gapAcross;
        for (let i = 0; i < count; i++) {
          xs[i] = left + offsets[i % columns]!;
          ws[i] = widths[i % columns]!;
        }
        h.plan(left, ws);
      };
      layoutColumns();
      // Widen until the labels fit or the limits are reached: the margins if
      // the first or last label would be clipped, and the gap between columns
      // if labels at the edges of neighboring panels would meet, by up to a
      // quarter of the width each, so that labels that cannot fit do not
      // squeeze the plots away. Whatever still needs more after a few passes
      // goes straight to its limit, so the margins kept for the next scene
      // are ones that scene keeps too.
      for (let pass = 0; pass < 10 && h.widens && !frozen; pass++) {
        // How far labeled panels' labels pass the chart's sides, and reach
        // past their panels' sides into the gaps between columns.
        let overflowLeft = 0;
        let overflowRight = 0;
        let spillLeft = 0;
        let spillRight = 0;
        let labeled = false;
        for (let i = 0; i < count; i++) {
          const column = i % columns;
          const end = h.ends(i, widths[column]!);
          if (!end) continue;
          labeled = true;
          const [firstStart, lastEnd] = end;
          if (column > 0) spillLeft = Math.max(spillLeft, left - firstStart);
          else overflowLeft = Math.max(overflowLeft, head.left + (head.auto ? 2 : 0) - firstStart);
          if (column < columns - 1)
            spillRight = Math.max(spillRight, lastEnd - (left + widths[column]!));
          else
            overflowRight = Math.max(
              overflowRight,
              lastEnd + offsets[column]! - (width - head.right - (head.auto ? 2 : 0)),
            );
        }
        if (!labeled) break;
        const spill = spillRight + spillLeft;
        const widen = (current: number, need: number) =>
          need <= current
            ? current
            : Math.max(current, pass < 3 ? Math.min(need, edgeRoom) : edgeRoom);
        const nextLeft = overflowLeft > 0.5 ? widen(left, left + Math.ceil(overflowLeft)) : left;
        const nextRight =
          overflowRight > 0.5 ? widen(right, right + Math.ceil(overflowRight)) : right;
        // Panels with their own y labels need room for those and the x
        // labels that reach past the panel before them.
        const nextGap = columns > 1 ? widen(gapAcross, Math.ceil(spill) + (labelRoom || 8)) : 0;
        if (nextLeft === left && nextRight === right && nextGap === gapAcross) break;
        left = nextLeft;
        right = nextRight;
        gapAcross = nextGap;
        layoutColumns();
      }
      return { xs, ws, left, kept: { left, right, columnGap: gapAcross } };
    },

    edge(i, end) {
      const column = i % columns;
      return end ? column === columns - 1 : column === 0;
    },

    yTitle(_i, _plot, right, size, chart) {
      // Once for the chart: at its edge, centered along the grid.
      const edge = size / 2 + (chart.auto ? 2 : 0);
      const bottom = top + rowHeights.reduce((sum, h) => sum + h, 0);
      return {
        x: right ? chart.width - chart.right - edge : chart.left + edge,
        span: [bottom + rows * header + (rows - 1) * between, top],
      };
    },

    xTitle(i, plot, titling) {
      // Each x scale's title goes once, under the last panel labeled with
      // it: centered under the grid when every panel shares x, else under
      // its panel's column, or for a row's scale under all the row's panels.
      const { text } = titling;
      if (!text) return undefined;
      const rowEnd = Math.min(count, (rowOf(i) + 1) * columns) - 1;
      const end = left + offsets[rowEnd % columns]! + widths[rowEnd % columns]!;
      const gridEnd = left + offsets[columns - 1]! + widths[columns - 1]!;
      const [from, to] =
        titling.scope !== "chart"
          ? titling.scope === "row"
            ? [left, end]
            : [plot.x, plot.x + plot.width]
          : [left, gridEnd];
      const along = aligned(titling.align ?? "center", from, to - from);
      return {
        text,
        x: along.at,
        anchor: along.anchor,
        y:
          rowOf(i) === rows - 1
            ? bottom - titling.size / 2
            : plot.y + plot.height + titling.labels + titling.size / 2 + GAP,
      };
    },
  };
}
