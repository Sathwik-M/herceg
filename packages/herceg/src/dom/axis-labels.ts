// Crosshair labels (`tooltip.axisLabels`): the values under the crosshair,
// each in a filled box on its axis, and a dashed line across the plot at
// the pointer. The boxes are HTML the browser sizes to their text, placed
// by CSS inside the chart, so the cursor never measures text. Charts load
// this module only when they ask for the labels; it imports no code of its
// own, so loading it splits nothing else off the chart's bundle.

import type { ChartModel, Inspection } from "../model/model.ts";
import type { AxisGuide, Rect, Scene } from "../scene/scene.ts";

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
  /** The boxes, over the chart. */
  readonly labels: HTMLDivElement;
  readonly #boxes: HTMLDivElement[] = [];

  constructor(document: Document) {
    this.line = element(document, "line", {
      "stroke-width": "1",
      "stroke-dasharray": "3 3",
      visibility: "hidden",
    });
    this.labels = document.createElement("div");
    this.labels.setAttribute("aria-hidden", "true");
    this.labels.style.cssText = "position:absolute;left:0;top:0;pointer-events:none";
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
        const own = drawn.axes.find((axis) => axis.side === side);
        if (own || side !== "bottom") return own;
        let lowest: AxisGuide | undefined;
        for (const p of scene.panels) {
          if (!sameX.has(p.key)) continue;
          const axis = p.axes.find(({ side }) => side === "bottom");
          if (axis && !(lowest && lowest.edge > axis.edge)) lowest = axis;
        }
        return lowest;
      };
      const along = inspection.axis;
      const label = (side: AxisLabel["side"], at: number, text: string) => {
        const axis = axisOf(side);
        if (axis) labels.push({ side, at, edge: axis.edge, text });
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
    for (const box of this.#boxes) box.style.display = "none";
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

  /**
   * Places the boxes as tick labels are placed, inside the chart: centered
   * on the x axis' labels, over the y axes' labels beside the axis, and
   * moved in where they would reach past the chart's edges. The browser
   * sizes each to its text; CSS places it by its own size (percentages in
   * a translation are of the box), so the cursor measures no text.
   */
  #place(labels: readonly AxisLabel[], context: CrosshairContext): void {
    const { labelGap, surface } = context;
    const { theme, width, height } = context.scene;
    const document = this.labels.ownerDocument;
    while (this.#boxes.length < labels.length) {
      const box = document.createElement("div");
      this.labels.append(box);
      this.#boxes.push(box);
    }
    const boxHeight = Math.round(theme.fontSize * 1.25) + 4;
    const look = `position:absolute;left:0;top:0;box-sizing:border-box;white-space:nowrap;overflow:hidden;max-width:${width}px;height:${boxHeight}px;line-height:${boxHeight}px;padding:0 ${PAD}px;border-radius:3px;font:${theme.fontSize}px ${theme.font};background:${theme.text};color:${surface}`;
    const inside = (y: number) => Math.max(0, Math.min(y, height - boxHeight));
    this.#boxes.forEach((box, i) => {
      const label = labels[i];
      if (!label) {
        box.style.display = "none";
        return;
      }
      let x: string;
      let y: number;
      if (label.side === "bottom") {
        // Centered on the line of the tick labels, which hang below the axis.
        x = `clamp(0px, calc(${label.at}px - 50%), calc(${width}px - 100%))`;
        y = inside(Math.round(label.edge) + labelGap + theme.fontSize / 2 - boxHeight / 2);
      } else {
        // Over the tick labels, which end 8 pixels from the axis.
        x =
          label.side === "left"
            ? `max(0px, calc(${label.edge - 3}px - 100%))`
            : `min(${label.edge + 3}px, calc(${width}px - 100%))`;
        y = inside(label.at - boxHeight / 2);
      }
      box.style.cssText = `${look};transform:translate(${x}, ${y}px)`;
      box.textContent = label.text;
    });
  }
}
