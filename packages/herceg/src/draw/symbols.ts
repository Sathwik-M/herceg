// Point symbols as SVG path data and canvas paths (shapes in symbol-shapes.ts).

import { n } from "./markup.ts";
import { type SymbolName, vertices } from "./symbol-shapes.ts";

export { CYCLE, SYMBOLS, type SymbolName, symbolReach } from "./symbol-shapes.ts";

const PI = Math.PI;

/** SVG path data of a symbol of radius `r` centered at (x, y). */
export function symbolPath(symbol: SymbolName, x: number, y: number, r: number): string {
  if (symbol === "circle") {
    // Two half arcs, clockwise (sweep flag 1), as canvas arcs turn by default.
    const d = n(r * 2);
    return `M${n(x - r)} ${n(y)}a${n(r)} ${n(r)} 0 1 1 ${d} 0a${n(r)} ${n(r)} 0 1 1 -${d} 0`;
  }
  const v = vertices(symbol);
  let d = `M${n(x + v[0]! * r)} ${n(y + v[1]! * r)}`;
  for (let i = 2; i < v.length; i += 2) d += `L${n(x + v[i]! * r)} ${n(y + v[i + 1]! * r)}`;
  return `${d}Z`;
}

/** Adds a symbol of radius `r` centered at (x, y) to the canvas' current path. */
export function traceSymbol(
  context: CanvasRenderingContext2D,
  symbol: SymbolName,
  x: number,
  y: number,
  r: number,
): void {
  if (symbol === "circle") {
    context.moveTo(x + r, y);
    context.arc(x, y, r, 0, PI * 2);
    return;
  }
  const v = vertices(symbol);
  context.moveTo(x + v[0]! * r, y + v[1]! * r);
  for (let i = 2; i < v.length; i += 2) context.lineTo(x + v[i]! * r, y + v[i + 1]! * r);
  context.closePath();
}
