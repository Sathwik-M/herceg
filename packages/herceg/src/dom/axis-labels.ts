// Crosshair labels (`tooltip.axisLabels`): the values under the crosshair,
// each in a filled box on its axis, and a dashed line across the plot at
// the pointer. Charts load this module only when they ask for the labels;
// it imports no code of its own, so loading it splits nothing else off
// the chart's bundle.

import type { MeasureText } from "../layout/text.ts";
import type { ChartModel, Inspection } from "../model/model.ts";
import type { AxisGeometry, Rect, Scene } from "../scene/scene.ts";

/** A value on an axis. */
interface AxisLabel {
  /** The axis the label sits on. */
  side: "bottom" | "left" | "right";
  /** Where along the axis: an x for the bottom axis, a y for the others. */
  at: number;
  /** Where the axis is: the y of the bottom axis, the x of a side axis. */
  edge: number;
  text: string;
}

/** What labels read from the chart: its model and last scene. */
export interface CrosshairContext {
  model: ChartModel;
  /** The scene drawn: labels go only on the axes it draws. */
  scene: Scene;
  measure: MeasureText;
  /** How far below the x axis its tick labels hang. */
  labelGap: number;
  /** The text color in boxes: the surface behind the chart, opaque. */
  surface: string;
}

const NS = "http://www.w3.org/2000/svg";

function element<K extends keyof SVGElementTagNameMap>(
  document: Document,
  name: K,
  attributes: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

/** Room between a box's text and its sides. */
const PAD = 5;

export class CrosshairLabels {
  /** The line across the plot at the pointer, drawn below the points it marks. */
  readonly line: SVGLineElement;
  /** The boxes, drawn above everything. */
  readonly labels: SVGGElement;
  readonly #boxes: { group: SVGGElement; rect: SVGRectElement; text: SVGTextElement }[] = [];

  constructor(document: Document) {
    this.line = element(document, "line", {
      "stroke-width": "1",
      "stroke-dasharray": "3 3",
      visibility: "hidden",
    });
    this.labels = element(document, "g");
  }

  /**
   * Labels the inspections shown: each one's value on the axis it follows,
   * and for `active`, the one under `pointer`, the pointer's place on the
   * other axis (on both y axes when the chart has a right one), across a
   * dashed line.
   */
  draw(
    shown: readonly Inspection[],
    active: Inspection | undefined,
    pointer: { x: number; y: number } | null,
    context: CrosshairContext,
  ): void {
    const labels: AxisLabel[] = [];
    this.line.setAttribute("visibility", "hidden");
    const { model, scene } = context;
    const panels = model.panels();
    for (const inspection of shown) {
      // Items (pie slices) have no axes.
      if (inspection.axis === "item") continue;
      const key = inspection.panel ?? "";
      const panel = panels.find((p) => p.key === key) ?? panels[0];
      const drawn = scene.panels.find((p) => p.key === key) ?? scene.panels[0];
      if (!panel || !drawn) continue;
      const { plot } = panel;
      // Labels go on the axes the scene draws: beside the panel, and for x
      // under it or, when panels share x, under the lowest panel of its
      // column that has an x axis.
      // Panels of the column sharing the inspected panel's x scale.
      const sameX = new Set(
        panels.filter((p) => p.xGroup === panel.xGroup && p.plot.x === plot.x).map((p) => p.key),
      );
      const axisOf = (side: AxisLabel["side"]) => {
        const own = drawn.axes.find((axis) => axis.orient === side);
        if (own || side !== "bottom") return own;
        let lowest: AxisGeometry | undefined;
        for (const p of scene.panels) {
          if (!sameX.has(p.key)) continue;
          const axis = p.axes.find(({ orient }) => orient === "bottom");
          if (axis && !(lowest && lowest.offset > axis.offset)) lowest = axis;
        }
        return lowest;
      };
      const along = inspection.axis;
      const label = (side: AxisLabel["side"], at: number, text: string) => {
        const axis = axisOf(side);
        if (axis) labels.push({ side, at, edge: axis.offset, text });
      };
      label(along === "x" ? "bottom" : "left", inspection.position, inspection.label);
      if (inspection !== active || !pointer) continue;
      this.#cross(pointer, plot, along, scene.theme.axis);
      const format = model.formatsOf(undefined, panel.key);
      if (along === "y") {
        label("bottom", pointer.x, format.x(panel.x.invert(pointer.x)));
        continue;
      }
      label("left", pointer.y, format.y(panel.y.invert(pointer.y)));
      const right = panel.yRight;
      const formatRight = model.yRightFormat(panel.key);
      if (right && formatRight) label("right", pointer.y, formatRight(right.invert(pointer.y)));
    }
    this.#place(labels, context);
  }

  hide(): void {
    this.line.setAttribute("visibility", "hidden");
    for (const { group } of this.#boxes) group.setAttribute("visibility", "hidden");
  }

  /** The line across a plot at the pointer, crossing the crosshair along `axis`. */
  #cross(pointer: { x: number; y: number }, plot: Rect, axis: "x" | "y", stroke: string): void {
    const { line } = this;
    const horizontal = axis === "x";
    const at = String(Math.round(horizontal ? pointer.y : pointer.x) + 0.5);
    line.setAttribute("x1", horizontal ? String(plot.x) : at);
    line.setAttribute("x2", horizontal ? String(plot.x + plot.width) : at);
    line.setAttribute("y1", horizontal ? at : String(plot.y));
    line.setAttribute("y2", horizontal ? at : String(plot.y + plot.height));
    line.setAttribute("stroke", stroke);
    line.setAttribute("visibility", "visible");
  }

  /** Places the boxes as tick labels are placed, inside the chart. */
  #place(labels: readonly AxisLabel[], context: CrosshairContext): void {
    const { measure, labelGap } = context;
    const { theme, width, height } = context.scene;
    const document = this.labels.ownerDocument;
    while (this.#boxes.length < labels.length) {
      const group = element(document, "g");
      const rect = element(document, "rect", { rx: "3" });
      const text = element(document, "text", { "dominant-baseline": "middle" });
      group.append(rect, text);
      this.labels.append(group);
      this.#boxes.push({ group, rect, text });
    }
    const font = `${theme.fontSize}px ${theme.font}`;
    const boxHeight = Math.round(theme.fontSize * 1.25) + 4;
    this.#boxes.forEach(({ group, rect, text }, i) => {
      const label = labels[i];
      group.setAttribute("visibility", label ? "visible" : "hidden");
      if (!label) return;
      const boxWidth = Math.ceil(measure(label.text, font)) + 2 * PAD;
      let x: number;
      let y: number;
      if (label.side === "bottom") {
        // Centered on the line of the tick labels, which hang below the axis.
        x = label.at - boxWidth / 2;
        const middle = Math.round(label.edge) + labelGap + theme.fontSize / 2;
        y = middle - boxHeight / 2;
      } else {
        // Over the tick labels, which end 8 pixels from the axis.
        x = label.side === "left" ? label.edge - 3 - boxWidth : label.edge + 3;
        y = label.at - boxHeight / 2;
      }
      x = Math.max(0, Math.min(x, width - boxWidth));
      y = Math.max(0, Math.min(y, height - boxHeight));
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", String(y));
      rect.setAttribute("width", String(boxWidth));
      rect.setAttribute("height", String(boxHeight));
      rect.setAttribute("fill", theme.text);
      text.setAttribute("x", String(x + PAD));
      text.setAttribute("y", String(y + boxHeight / 2));
      text.setAttribute("fill", context.surface);
      text.textContent = label.text;
    });
  }
}
