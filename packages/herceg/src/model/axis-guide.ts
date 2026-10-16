// Axes as guides: an axis' line, tick marks, tick labels, and title, placed
// along one side of a plot. The model decides where (`AxisPlacement`); this
// module turns a placement and ticks into the items every renderer draws,
// and value transitions place the ticks between two scenes the same way.

import { type MeasureText, type TextAt, textItem } from "../layout/text.ts";
import { strokeKey } from "../scene/grid.ts";
import type {
  AxisGuide,
  AxisPlacement,
  AxisTick,
  GuideItem,
  SegmentsItem,
} from "../scene/scene.ts";
import type { StrokePaint, TextPaint } from "../style/style.ts";

/** Length of x axes' tick marks, in pixels. */
export const TICK = 5;

/**
 * The items of an axis at `placement` with `ticks` and `title` (its
 * middle); `measure` sizes the boxes of labels whose paints have them.
 */
export function axisItems(
  placement: AxisPlacement,
  ticks: readonly AxisTick[],
  title?: AxisGuide["title"],
  measure?: MeasureText,
): GuideItem[] {
  const { side, paints, gap } = placement;
  const items: GuideItem[] = [];
  // Lines fall on pixel centers, so 1-pixel lines are crisp.
  const edge = Math.round(placement.edge) + 0.5;
  const below = side === "bottom";
  if (below) {
    const line = [placement.start, edge, placement.end, edge];
    const marks: number[] = [];
    for (const { position } of ticks) {
      const at = Math.round(position) + 0.5;
      marks.push(at, edge, at, edge + placement.tickLength);
    }
    // One stroke when the line and ticks look alike, as they do by default.
    if (strokeKey(paints.line) === strokeKey(paints.tick))
      items.push(segments([...line, ...marks], paints.line));
    else {
      items.push(segments(line, paints.line));
      if (marks.length > 0) items.push(segments(marks, paints.tick));
    }
  }
  const text = (label: string, at: TextAt, paint: TextPaint) =>
    items.push(textItem(label, at, paint, placement.surface, measure));
  for (const { position, label } of ticks) {
    // One line, as it is drawn, its box too: a line break is a space here.
    text(
      label.replaceAll("\n", " "),
      below
        ? { x: position, y: edge + gap, anchor: "middle", baseline: "hanging", angle: 0 }
        : {
            x: placement.edge + (side === "left" ? -gap : gap),
            y: position,
            anchor: side === "left" ? "end" : "start",
            baseline: "middle",
            angle: 0,
          },
      paints.label,
    );
  }
  if (title) {
    // Titles beside a plot read bottom to top on the left, top to bottom on the right.
    const angle = below ? 0 : side === "left" ? -90 : 90;
    text(
      title.text,
      { x: title.x, y: title.y, anchor: title.anchor ?? "middle", baseline: "middle", angle },
      paints.title,
    );
  }
  return items;
}

/** An axis guide of scale `scale` keyed `key`, with its items. */
export function axisGuide(
  key: string,
  scale: string,
  placement: AxisPlacement,
  ticks: readonly AxisTick[],
  title: AxisGuide["title"],
  measure?: MeasureText,
): AxisGuide {
  return {
    kind: "axis",
    key,
    scale,
    ...placement,
    ticks,
    title,
    items: axisItems(placement, ticks, title, measure),
  };
}

function segments(coords: number[], paint: StrokePaint): SegmentsItem {
  return { type: "segments", coords, paint };
}
