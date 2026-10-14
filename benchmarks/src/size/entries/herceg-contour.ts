import { contour, createChart, fromMatrix } from "herceg";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  // A field of y's values over a square grid of x's.
  const side = Math.floor(Math.sqrt(y.length));
  const xs = x.subarray(0, side);
  const field = fromMatrix({ x: xs, y: xs, v: y.subarray(0, side * side) }, { x: "x", y: "y" });
  return createChart(element, {
    marks: [contour(field, { x: "x", y: "y", color: "v", variant: "bands" })],
  });
}
