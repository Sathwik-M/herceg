import { mapValue } from "../lod/m4.ts";
import type { Drawing, PointGeometry, Rect, SvgElement } from "../scene/scene.ts";
import { escapeXml, markupOf, n } from "./markup.ts";
import { SYMBOLS, symbolPath, traceSymbol } from "./symbols.ts";

/** Points of one shape, size, color, and opacity: circles drawn the fast way. */
function plain(mark: PointGeometry): boolean {
  return (
    mark.symbol === "circle" && !mark.radii && !mark.colors && !mark.opacities && !mark.symbols
  );
}

/** Point i's radius, shape, fill, and opacity, from its arrays or the series'. */
function styleOf(mark: PointGeometry, i: number) {
  return {
    r: mark.radii ? mark.radii[i]! : mark.radius,
    symbol: mark.symbols ? SYMBOLS[mark.symbols[i]!]! : mark.symbol,
    fill: mark.colors ? mark.colors.palette[mark.colors.index[i]!]! : mark.fill,
    opacity: mark.opacities ? mark.opacities[i]! : mark.fillOpacity,
  };
}

/**
 * Points grouped by fill: `order` lists point indexes color by color (none
 * means every point in order), and each group spans a range of it. Colors go
 * from the low end of the scale to the high, so higher values are drawn on top.
 */
function fillGroups(mark: PointGeometry): {
  order: Uint32Array | undefined;
  groups: { fill: string; start: number; end: number }[];
} {
  const { colors, count } = mark;
  if (!colors) return { order: undefined, groups: [{ fill: mark.fill, start: 0, end: count }] };
  const { index, palette } = colors;
  // A counting sort by palette index.
  const starts = new Uint32Array(palette.length + 1);
  for (let i = 0; i < count; i++) starts[index[i]! + 1]!++;
  for (let c = 0; c < palette.length; c++) starts[c + 1]! += starts[c]!;
  const groups: { fill: string; start: number; end: number }[] = [];
  for (let c = 0; c < palette.length; c++) {
    if (starts[c + 1]! > starts[c]!)
      groups.push({ fill: palette[c]!, start: starts[c]!, end: starts[c + 1]! });
  }
  const order = new Uint32Array(count);
  const next = starts.slice(0, palette.length);
  for (let i = 0; i < count; i++) order[next[index[i]!]!++] = i;
  return { order, groups };
}

/** Path data of points `order[start..end)`, each in its own shape and size. */
function symbolsPath(
  mark: PointGeometry,
  order: Uint32Array | undefined,
  start: number,
  end: number,
): string {
  const c = mark.coords;
  let d = "";
  for (let k = start; k < end; k++) {
    const i = order ? order[k]! : k;
    const { r, symbol } = styleOf(mark, i);
    d += symbolPath(symbol, c[i * 2]!, c[i * 2 + 1]!, r);
  }
  return d;
}

/**
 * Encoded points: opaque ones as a path per color, others one by one, in
 * row order, so overlaps darken.
 */
function encodedElements(mark: PointGeometry): SvgElement[] {
  if (mark.opaque && !mark.ring) {
    const { order, groups } = fillGroups(mark);
    return groups.map(({ fill, start, end }) => ({
      tag: "path",
      attributes: { d: symbolsPath(mark, order, start, end), fill },
    }));
  }
  const c = mark.coords;
  return Array.from({ length: mark.count }, (_, i) => {
    const { r, symbol, fill, opacity } = styleOf(mark, i);
    return {
      tag: "path",
      attributes: {
        d: symbolPath(symbol, c[i * 2]!, c[i * 2 + 1]!, r),
        fill,
        "fill-opacity": String(opacity),
        ...ringAttributes(mark),
      },
    };
  });
}

/**
 * SVG attributes of a points' ring, if they have one. Joins are round in every
 * renderer, so corners reach no farther than half the ring's width.
 */
function ringAttributes(mark: PointGeometry): Record<string, string> {
  if (!mark.ring) return {};
  return {
    stroke: mark.ring.color,
    "stroke-width": String(mark.ring.width),
    "stroke-linejoin": "round",
  };
}

/** Strokes a point's ring on a canvas, after its fill. */
function strokeRing(context: CanvasRenderingContext2D, mark: PointGeometry): void {
  if (!mark.ring) return;
  context.globalAlpha = 1;
  context.strokeStyle = mark.ring.color;
  context.lineWidth = mark.ring.width;
  context.lineJoin = "round";
  context.stroke();
}

function paintEncoded(context: CanvasRenderingContext2D, mark: PointGeometry): void {
  const c = mark.coords;
  if (mark.opaque && !mark.ring) {
    const { order, groups } = fillGroups(mark);
    for (const { fill, start, end } of groups) {
      context.fillStyle = fill;
      context.beginPath();
      for (let k = start; k < end; k++) {
        const i = order ? order[k]! : k;
        const { r, symbol } = styleOf(mark, i);
        traceSymbol(context, symbol, c[i * 2]!, c[i * 2 + 1]!, r);
      }
      context.fill();
    }
    return;
  }
  for (let i = 0; i < mark.count; i++) {
    const { r, symbol, fill, opacity } = styleOf(mark, i);
    context.globalAlpha = opacity;
    context.fillStyle = fill;
    context.beginPath();
    traceSymbol(context, symbol, c[i * 2]!, c[i * 2 + 1]!, r);
    context.fill();
    strokeRing(context, mark);
  }
  context.globalAlpha = 1;
}

/**
 * Circles of a translucent series, one element each so overlaps composite;
 * the inherited `fill-opacity` of their group applies to each circle.
 */
function pointCircles(mark: PointGeometry): string {
  const c = mark.coords;
  const r = n(mark.radius);
  let out = "";
  for (let i = 0; i < mark.count; i++)
    out += `<circle cx="${n(c[i * 2]!)}" cy="${n(c[i * 2 + 1]!)}" r="${r}"/>`;
  return out;
}

/** All circles of an opaque series as one path of arcs. */
function pointPath(mark: PointGeometry): string {
  const c = mark.coords;
  const r = n(mark.radius);
  const d2 = n(mark.radius * 2);
  let d = "";
  for (let i = 0; i < mark.count; i++) {
    d += `M${n(c[i * 2]! - mark.radius)} ${n(c[i * 2 + 1]!)}a${r} ${r} 0 1 0 ${d2} 0a${r} ${r} 0 1 0 -${d2} 0`;
  }
  return d;
}

function paintPoints(context: CanvasRenderingContext2D, mark: PointGeometry): void {
  if (!plain(mark)) {
    paintEncoded(context, mark);
    return;
  }
  const c = mark.coords;
  const r = mark.radius;
  context.globalAlpha = mark.fillOpacity;
  context.fillStyle = mark.fill;
  if (!mark.opaque || mark.ring) {
    // One fill per point so overlapping translucent points darken, as in SVG.
    for (let i = 0; i < mark.count; i++) {
      context.beginPath();
      context.arc(c[i * 2]!, c[i * 2 + 1]!, r, 0, Math.PI * 2);
      context.fill();
      strokeRing(context, mark);
      context.globalAlpha = mark.fillOpacity;
    }
    context.globalAlpha = 1;
    return;
  }
  context.beginPath();
  for (let i = 0; i < mark.count; i++) {
    const x = c[i * 2]!;
    const y = c[i * 2 + 1]!;
    context.moveTo(x + r, y);
    context.arc(x, y, r, 0, Math.PI * 2);
  }
  context.fill();
  context.globalAlpha = 1;
}

/**
 * Places a cloud's points on the CPU: the fallback when no GPU painter can
 * draw it. Points whose disc misses the plot are left out, as by the mark.
 */
export function placeCloud(mark: PointGeometry, plot: Rect): PointGeometry {
  const cloud = mark.cloud!;
  const { x, y, rows, start, end, xMap, yMap } = cloud;
  const coords = new Float32Array((end - start) * 2);
  const r = mark.radius;
  let count = 0;
  for (let k = start; k < end; k++) {
    const row = rows ? rows[k]! : k;
    const vx = x[row]!;
    const vy = y[row]!;
    if (!(Number.isFinite(vx) && Number.isFinite(vy))) continue;
    if ((xMap.log && vx <= 0) || (yMap.log && vy <= 0)) continue;
    const px = mapValue(xMap, vx);
    const py = mapValue(yMap, vy);
    if (px < plot.x - r || px > plot.x + plot.width + r) continue;
    if (py < plot.y - r || py > plot.y + plot.height + r) continue;
    coords[count * 2] = px;
    coords[count * 2 + 1] = py;
    count++;
  }
  const { cloud: _, ...placed } = mark;
  return { ...placed, coords, count };
}

/** Opaque points as one path; translucent points need a circle each (markup). */
function pointElements(mark: PointGeometry): SvgElement[] | undefined {
  if (mark.cloud) return [];
  if (!plain(mark)) return encodedElements(mark);
  if (!mark.opaque || mark.ring) return undefined;
  return [{ tag: "path", attributes: { d: pointPath(mark), fill: mark.fill } }];
}

/**
 * Points. Clouds (large series left to a GPU painter) are only drawn on a
 * canvas; scenes for SVG never contain them.
 */
export const pointDrawing: Drawing<PointGeometry> = {
  size: (mark) => mark.count,
  elements: pointElements,
  svg(mark) {
    const elements = pointElements(mark);
    return elements
      ? markupOf(elements)
      : `<g fill="${escapeXml(mark.fill)}" fill-opacity="${mark.fillOpacity}"${mark.ring ? ` stroke="${escapeXml(mark.ring.color)}" stroke-width="${mark.ring.width}"` : ""}>${pointCircles(mark)}</g>`;
  },
  canvas(context, mark, { plot, pixelRatio, clouds }) {
    if (!mark.cloud) return paintPoints(context, mark);
    if (clouds.defer) return;
    const owner = clouds.owner ?? context.canvas;
    if (!clouds.painter?.paint(context, mark, plot, pixelRatio, owner))
      paintPoints(context, placeCloud(mark, plot));
  },
};
