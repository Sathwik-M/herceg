// Helpers shared by the browser tests.

/** The x and width of a brush outline drawn as a rectangle, "M x0 y0 H x1 V y1 H x0 Z". */
export function bandBox(outline: Element): { x: number; width: number } {
  const [x0, , x1] = (outline.getAttribute("d") ?? "").match(/-?[\d.]+/g)!.map(Number);
  return { x: x0!, width: x1! - x0! };
}
