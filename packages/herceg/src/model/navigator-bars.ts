import { rectDrawing } from "../draw/rect.ts";
import type { BarMark } from "../marks/bar.ts";
import type { Frame, MarkKey } from "../marks/mark.ts";
import { rowOf, type Series } from "../marks/series.ts";
import type { RectGeometry, TextGeometry } from "../scene/scene.ts";

/**
 * Dense bars as one envelope per intersected CSS column and side of zero.
 * Placement determines coverage; the extreme bar supplies the color. Stacks
 * keep every segment at the position reaching the extreme, rather than
 * adding maxima from different positions. Ties keep the first series/row.
 */
export function overviewBars(
  mark: BarMark,
  series: readonly Series[],
  frame: Frame,
  key: MarkKey,
): (RectGeometry | TextGeometry)[] {
  const visible = series.filter((s) => !frame.hidden.has(s.key));
  const ranges = visible.map((s) => mark.range(s, frame));
  const columns = Math.ceil(frame.plot.width);
  if (ranges.reduce((n, [start, end]) => n + end - start, 0) < columns * 2)
    return mark.geometry(series, frame);

  const { x, y, plot } = frame;
  const { width, offset } = mark.placement(visible, x, frame);
  // Keep only a bounded prefix of exact rectangles while determining density.
  // A missing-heavy source is walked once, without table-sized output buffers.
  const exact = visible.map(() => [] as number[]);
  const rows = visible.map(() => [] as number[]);
  const threshold = columns * 2;
  let drawable = 0;
  const winners = frame.doubles(String(key), "bar-overview", columns * 2 * 4);
  winners.fill(0, 0, columns * 2 * 4);
  const zero = y.type === "log" ? y.range[0] : y.map(0);
  // Match full geometry's float coordinates, including clipped edges.
  const pixelWidth = Math.fround(width);
  const rightEdge = plot.x + plot.width;
  const bottomEdge = plot.y + plot.height;
  for (let i = 0; i < visible.length; i++) {
    const s = visible[i]!;
    const [start, end] = ranges[i]!;
    const displacement = offset(s);
    for (let k = start; k < end; k++) {
      const row = rowOf(s, k);
      // The strip only accepts vertical bars. Reject missing tips before
      // calling placement logic, especially for mostly missing columns.
      if (!Number.isFinite(s.y[row]!)) continue;
      const ends = mark.ends(s, row, x, y);
      if (!ends) continue;
      const { center, tip, root, at } = ends;
      const left = Math.fround(center + displacement);
      const top = Math.fround(Math.min(tip, root));
      const height = Math.fround(Math.abs(tip - root));
      if (!intersects(left, top, pixelWidth, height, plot.x, plot.y, rightEdge, bottomEdge))
        continue;
      const first = Math.max(0, Math.floor(left - plot.x));
      const last = Math.min(columns, Math.ceil(left + pixelWidth - plot.x));
      if (drawable < threshold) {
        exact[i]!.push(left, top, pixelWidth, height);
        rows[i]!.push(row);
      }
      drawable++;
      const side = tip < zero ? 0 : 1;
      const distance = Math.abs(tip - zero);
      for (let column = first; column < last; column++) {
        const slot = (column * 2 + side) * 4;
        if (distance > winners[slot]!) {
          winners[slot] = distance;
          winners[slot + 1] = at;
          winners[slot + 2] = i;
          winners[slot + 3] = row;
        }
      }
    }
  }
  if (drawable < threshold) {
    // Labels and corner metadata use the full mark's authoring logic, over
    // just the retained rows rather than another walk of the source table.
    if (mark.spec.labels || frame.theme.style.bar.radius > 0 || frame.keyed) {
      return mark.geometry(
        visible.map((s, i) => ({
          ...s,
          whole: s.whole ?? s,
          rows: Uint32Array.from(rows[i]!),
          length: rows[i]!.length,
        })),
        frame,
      );
    }
    return visible.map((s, i) => {
      const rects = frame.floats(s.key, "bar-overview-exact", exact[i]!.length);
      rects.set(exact[i]!);
      return {
        kind: "rect",
        draw: rectDrawing,
        key: s.key,
        fill: s.color,
        fillOpacity: mark.spec.fillOpacity ?? 1,
        rects,
        count: exact[i]!.length / 4,
      };
    });
  }

  const out: RectGeometry[] = [];
  const selected = new Map<number, number[]>();
  if (!mark.spec.stack) {
    for (let slot = 0; slot < columns * 2 * 4; slot += 4) {
      if (!(winners[slot]! > 0)) continue;
      const index = winners[slot + 2]!;
      const slots = selected.get(index) ?? [];
      if (!selected.has(index)) selected.set(index, slots);
      slots.push(slot);
    }
  }
  // Shared scratch for one layer's segments at the chosen stack positions.
  // Repeated rows at a position may be segments of the same series: merge
  // their touching intervals instead of emitting unbounded rectangles.
  const segments = mark.spec.stack
    ? frame.doubles(String(key), "bar-overview-segments", columns * 2 * 2)
    : undefined;
  segments?.fill(Number.NaN, 0, columns * 2 * 2);
  visible.forEach((s, i) => {
    const slots = mark.spec.stack ? [] : selected.get(i);
    if (!slots) return;
    if (mark.spec.stack) {
      const [start, end] = ranges[i]!;
      const displacement = offset(s);
      for (let k = start; k < end; k++) {
        const ends = mark.ends(s, rowOf(s, k), x, y);
        if (!ends) continue;
        const { center, tip, root, at } = ends;
        const left = Math.fround(center + displacement);
        const top = Math.fround(Math.min(tip, root));
        const height = Math.fround(Math.abs(tip - root));
        if (!intersects(left, top, pixelWidth, height, plot.x, plot.y, rightEdge, bottomEdge))
          continue;
        const first = Math.max(0, Math.floor(left - plot.x));
        const last = Math.min(columns, Math.ceil(left + pixelWidth - plot.x));
        const side = tip < zero ? 0 : 1;
        for (let column = first; column < last; column++) {
          const winner = (column * 2 + side) * 4;
          if (!(winners[winner]! > 0 && at === winners[winner + 1])) continue;
          const slot = (column * 2 + side) * 2;
          if (Number.isNaN(segments![slot])) {
            slots.push(slot);
            segments![slot] = Math.min(tip, root);
            segments![slot + 1] = Math.max(tip, root);
          } else {
            segments![slot] = Math.min(segments![slot]!, tip, root);
            segments![slot + 1] = Math.max(segments![slot + 1]!, tip, root);
          }
        }
      }
    }
    if (slots.length === 0) return;
    // Allocate only emitted rectangles, including for sparse stack layers
    // and per-row series colors. Empty layers retain no rectangle buffer.
    const rects = frame.floats(s.key, "bar-overview-rect", slots.length * 4);
    let count = 0;
    for (const slot of slots) {
      const ends = mark.spec.stack ? undefined : mark.ends(s, winners[slot + 3]!, x, y)!;
      const top = ends ? Math.min(ends.tip, ends.root) : segments![slot]!;
      const bottom = ends ? Math.max(ends.tip, ends.root) : segments![slot + 1]!;
      const column = Math.floor(slot / (mark.spec.stack ? 4 : 8));
      const offset = count++ * 4;
      rects[offset] = plot.x + column;
      rects[offset + 1] = top;
      rects[offset + 2] = Math.min(1, plot.width - column);
      rects[offset + 3] = bottom - top;
      if (segments) segments[slot] = Number.NaN;
    }
    out.push({
      kind: "rect",
      draw: rectDrawing,
      key: s.key,
      fill: s.color,
      fillOpacity: mark.spec.fillOpacity ?? 1,
      rects,
      count,
    });
  });
  return out;
}

/** The nonempty part of a full bar's rectangle can paint inside the strip. */
function intersects(
  left: number,
  top: number,
  width: number,
  height: number,
  x: number,
  y: number,
  right: number,
  bottom: number,
): boolean {
  return (
    width > 0 && height > 0 && left < right && left + width > x && top < bottom && top + height > y
  );
}
