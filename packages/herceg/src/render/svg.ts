// Scene to SVG markup. Used directly for static output (server rendering,
// exports) and piecewise by the live SVG renderer.

import type { Polyline } from "../lod/polyline.ts";
import { isLightColor } from "../scale/color.ts";
import {
  type AreaGeometry,
  type AxisGeometry,
  type ColorLegend,
  isGuide,
  LEGEND_SWATCH,
  type LegendItem,
  type LineGeometry,
  type MarkGeometry,
  type PointGeometry,
  type RasterGeometry,
  type RectGeometry,
  type RuleGeometry,
  type Scene,
  type TextGeometry,
} from "../scene/scene.ts";
import type { Theme } from "../theme.ts";

/** Rounds to 0.1 px: invisible at any pixel ratio and keeps paths short. */
function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Path data for a polyline, one subpath per run. */
export function linePath(path: Polyline): string {
  const c = path.coords;
  let d = "";
  for (let run = 0; run < path.starts.length; run++) {
    const start = path.starts[run]!;
    const end = path.runEnd(run);
    if (end - start < 1) continue;
    d += `M${n(c[start * 2]!)} ${n(c[start * 2 + 1]!)}`;
    for (let i = start + 1; i < end; i++) d += `L${n(c[i * 2]!)} ${n(c[i * 2 + 1]!)}`;
  }
  return d;
}

/** Closed outline of an area: the top edge, then the bottom edge back. */
export function areaPath(area: AreaGeometry): string {
  const upper = area.upper;
  const lower = area.lower;
  const u = upper.coords;
  let d = "";
  for (let run = 0; run < upper.starts.length; run++) {
    const start = upper.starts[run]!;
    const end = upper.runEnd(run);
    if (end - start < 1) continue;
    d += `M${n(u[start * 2]!)} ${n(u[start * 2 + 1]!)}`;
    for (let i = start + 1; i < end; i++) d += `L${n(u[i * 2]!)} ${n(u[i * 2 + 1]!)}`;
    if (lower && run < lower.starts.length) {
      const l = lower.coords;
      const lowerStart = lower.starts[run]!;
      for (let i = lower.runEnd(run) - 1; i >= lowerStart; i--)
        d += `L${n(l[i * 2]!)} ${n(l[i * 2 + 1]!)}`;
    } else {
      d += `L${n(u[(end - 1) * 2]!)} ${n(area.baseline)}L${n(u[start * 2]!)} ${n(area.baseline)}`;
    }
    d += "Z";
  }
  return d;
}

function dash(value: readonly number[] | undefined): string {
  return value && value.length > 0 ? ` stroke-dasharray="${value.join(" ")}"` : "";
}

export function lineElement(line: LineGeometry): string {
  return `<path d="${linePath(line.path)}" fill="none" stroke="${escapeXml(line.stroke)}" stroke-width="${line.strokeWidth}" stroke-linejoin="round" stroke-linecap="round"${dash(line.dash)}/>`;
}

export function areaElement(area: AreaGeometry): string {
  let out = `<path d="${areaPath(area)}" fill="${escapeXml(area.fill)}" fill-opacity="${area.fillOpacity}" stroke="none"/>`;
  if (area.stroke) {
    out += `<path d="${linePath(area.upper)}" fill="none" stroke="${escapeXml(area.stroke)}" stroke-width="${area.strokeWidth}" stroke-linejoin="round"/>`;
  }
  return out;
}

export function ruleElement(rule: RuleGeometry, theme: Theme): string {
  let out = `<line x1="${n(rule.x1)}" y1="${n(rule.y1)}" x2="${n(rule.x2)}" y2="${n(rule.y2)}" stroke="${escapeXml(rule.stroke)}" stroke-width="${rule.strokeWidth}"${dash(rule.dash)}/>`;
  if (rule.label) {
    const vertical = rule.x1 === rule.x2;
    const x = vertical ? rule.x1 + 4 : rule.x2 - 4;
    const y = vertical ? rule.y1 + theme.fontSize : rule.y1 - 4;
    const anchor = vertical ? "start" : "end";
    out += `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" fill="${escapeXml(theme.muted)}">${escapeXml(rule.label)}</text>`;
  }
  return out;
}

/**
 * Labels of a text mark, each with a halo so it stays readable over lines
 * and fills: the background color, or without one, white behind dark text
 * and black behind light text. Fills given by name are taken to be as light
 * as the theme's text.
 */
export function textElements(mark: TextGeometry, theme: Theme): string {
  const opaque = theme.background !== "transparent";
  const light = isLightColor(mark.fill) ?? isLightColor(theme.text);
  const color = opaque ? theme.background : light ? "#000000" : "#ffffff";
  const halo = ` stroke="${escapeXml(color)}" stroke-opacity="${opaque ? 1 : 0.85}" stroke-width="3" stroke-linejoin="round" paint-order="stroke"`;
  const c = mark.coords;
  let out = `<g fill="${escapeXml(mark.fill)}" text-anchor="${mark.anchor}"${halo}>`;
  for (let i = 0; i < mark.count; i++) {
    out += `<text x="${n(c[i * 2]!)}" y="${n(c[i * 2 + 1]!)}" dominant-baseline="middle">${escapeXml(mark.labels[i]!)}</text>`;
  }
  return `${out}</g>`;
}

/** Guides drawn above the data: rules and their labels, then text marks. */
export function guideElements(marks: readonly MarkGeometry[], theme: Theme): string {
  let out = "";
  for (const mark of marks) {
    if (mark.kind === "rule") out += ruleElement(mark, theme);
    else if (mark.kind === "text") out += textElements(mark, theme);
  }
  return out;
}

/** All rectangles of a series as one path. */
export function rectPath(mark: RectGeometry): string {
  const r = mark.rects;
  let d = "";
  for (let i = 0; i < mark.count; i++) {
    const x = r[i * 4]!;
    const y = r[i * 4 + 1]!;
    const w = r[i * 4 + 2]!;
    const h = r[i * 4 + 3]!;
    d += `M${n(x)} ${n(y)}h${n(w)}v${n(h)}h${n(-w)}Z`;
  }
  return d;
}

/**
 * Circles of a translucent series, one element each so overlaps composite;
 * the inherited `fill-opacity` of their group applies to each circle.
 */
export function pointCircles(mark: PointGeometry): string {
  const c = mark.coords;
  const r = n(mark.radius);
  let out = "";
  for (let i = 0; i < mark.count; i++)
    out += `<circle cx="${n(c[i * 2]!)}" cy="${n(c[i * 2 + 1]!)}" r="${r}"/>`;
  return out;
}

/** All circles of an opaque series as one path of arcs. */
export function pointPath(mark: PointGeometry): string {
  const c = mark.coords;
  const r = n(mark.radius);
  const d2 = n(mark.radius * 2);
  let d = "";
  for (let i = 0; i < mark.count; i++) {
    d += `M${n(c[i * 2]! - mark.radius)} ${n(c[i * 2 + 1]!)}a${r} ${r} 0 1 0 ${d2} 0a${r} ${r} 0 1 0 -${d2} 0`;
  }
  return d;
}

/**
 * Encodes raster pixels as an image URL. Browsers use a canvas (native PNG
 * encoding); servers pass the bundled encoder from `render/png.ts`, which
 * keeps that encoder out of browser bundles.
 */
export type RasterEncoder = (mark: RasterGeometry) => string;

export function rasterElement(mark: RasterGeometry, encode: RasterEncoder): string {
  return `<image x="${n(mark.x)}" y="${n(mark.y)}" width="${n(mark.width)}" height="${n(mark.height)}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${encode(mark)}"/>`;
}

export function markElement(mark: MarkGeometry, theme: Theme, encode: RasterEncoder): string {
  switch (mark.kind) {
    case "line":
      return lineElement(mark);
    case "area":
      return areaElement(mark);
    case "rect":
      return `<path d="${rectPath(mark)}" fill="${escapeXml(mark.fill)}" fill-opacity="${mark.fillOpacity}"/>`;
    case "point":
      return !mark.opaque
        ? `<g fill="${escapeXml(mark.fill)}" fill-opacity="${mark.fillOpacity}">${pointCircles(mark)}</g>`
        : `<path d="${pointPath(mark)}" fill="${escapeXml(mark.fill)}"/>`;
    case "raster":
      return rasterElement(mark, encode);
    case "rule":
      return ruleElement(mark, theme);
    case "text":
      return textElements(mark, theme);
  }
}

/** Grid lines as one path. */
export function gridPath(scene: Scene): string {
  const { plot, grid } = scene;
  let d = "";
  for (const y of grid.y) d += `M${n(plot.x)} ${n(Math.round(y) + 0.5)}H${n(plot.x + plot.width)}`;
  for (const x of grid.x) d += `M${n(Math.round(x) + 0.5)} ${n(plot.y)}V${n(plot.y + plot.height)}`;
  return d;
}

export function axisElements(axes: readonly AxisGeometry[], theme: Theme): string {
  let out = "";
  for (const axis of axes) {
    if (axis.orient === "bottom") {
      const y = Math.round(axis.offset) + 0.5;
      if (axis.line) {
        let d = `M${n(axis.start)} ${n(y)}H${n(axis.end)}`;
        for (const tick of axis.ticks) d += `M${n(Math.round(tick.position) + 0.5)} ${n(y)}v5`;
        out += `<path d="${d}" stroke="${escapeXml(theme.axis)}" fill="none"/>`;
      }
      for (const tick of axis.ticks) {
        out += `<text x="${n(tick.position)}" y="${n(y + 8)}" text-anchor="middle" dominant-baseline="hanging">${escapeXml(tick.label)}</text>`;
      }
    } else {
      for (const tick of axis.ticks) {
        out += `<text x="${n(axis.offset - 8)}" y="${n(tick.position)}" text-anchor="end" dominant-baseline="middle">${escapeXml(tick.label)}</text>`;
      }
    }
    if (axis.title) {
      const rotate =
        axis.orient === "left"
          ? ` transform="rotate(-90 ${n(axis.title.x)} ${n(axis.title.y)})"`
          : "";
      out += `<text x="${n(axis.title.x)}" y="${n(axis.title.y)}" text-anchor="middle" dominant-baseline="middle" fill="${escapeXml(theme.text)}"${rotate}>${escapeXml(axis.title.text)}</text>`;
    }
  }
  return out;
}

export function legendElements(legend: readonly LegendItem[], theme: Theme): string {
  let out = "";
  for (const item of legend) {
    const opacity = item.hidden ? ' opacity="0.4"' : "";
    const swatchY = item.y - LEGEND_SWATCH / 2;
    out += `<g${opacity}><rect x="${n(item.x)}" y="${n(swatchY)}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" rx="2" fill="${escapeXml(item.color)}"/>`;
    out += `<text x="${n(item.x + LEGEND_SWATCH + 6)}" y="${n(item.y)}" dominant-baseline="middle" fill="${escapeXml(theme.text)}">${escapeXml(item.label)}</text></g>`;
  }
  return out;
}

/** Continuous color legend; `id` must be unique in the document (for the gradient). */
export function colorLegendElement(legend: ColorLegend, theme: Theme, id: string): string {
  const stops = legend.stops
    .map(
      (color, i) =>
        `<stop offset="${n((i / Math.max(1, legend.stops.length - 1)) * 100)}%" stop-color="${escapeXml(color)}"/>`,
    )
    .join("");
  const y = legend.y;
  const text = (item: { text: string; x: number }, fill: string) =>
    `<text x="${n(item.x)}" y="${n(y)}" dominant-baseline="middle" fill="${escapeXml(fill)}">${escapeXml(item.text)}</text>`;
  return (
    `<defs><linearGradient id="${id}">${stops}</linearGradient></defs>` +
    text(legend.title, theme.text) +
    text(legend.low, theme.muted) +
    `<rect x="${n(legend.ramp.x)}" y="${n(y - LEGEND_SWATCH / 2)}" width="${n(legend.ramp.width)}" height="${LEGEND_SWATCH}" rx="2" fill="url(#${id})"/>` +
    text(legend.high, theme.muted)
  );
}

export function titleElement(scene: Scene): string {
  if (!scene.title) return "";
  const { theme } = scene;
  return `<text x="${n(scene.title.x)}" y="${n(scene.title.y)}" dominant-baseline="middle" font-size="${theme.fontSize + 2}" font-weight="600" fill="${escapeXml(theme.text)}">${escapeXml(scene.title.text)}</text>`;
}

export interface SvgOptions {
  /** Raster image encoder; rasters are omitted without one. */
  encodeRaster?: RasterEncoder;
  /** Prefix for element ids, unique per document. */
  idPrefix?: string;
  /** Accessible name; defaults to the scene title. */
  title?: string;
  description?: string;
  /** Include the legend (the browser runtime renders it as HTML instead). */
  legend?: boolean;
}

/** Complete, standalone SVG document for a scene. */
export function renderSvg(scene: Scene, options: SvgOptions = {}): string {
  const { theme, plot, width, height } = scene;
  const id = options.idPrefix ?? "herceg";
  const title = options.title ?? scene.title?.text;
  const labelled = [title ? `${id}-title` : "", options.description ? `${id}-desc` : ""]
    .filter(Boolean)
    .join(" ");
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"${labelled ? ` aria-labelledby="${labelled}"` : ""} font-family="${escapeXml(theme.font)}" font-size="${theme.fontSize}" fill="${escapeXml(theme.muted)}">`;
  if (title) out += `<title id="${id}-title">${escapeXml(title)}</title>`;
  if (options.description) out += `<desc id="${id}-desc">${escapeXml(options.description)}</desc>`;
  out += `<defs><clipPath id="${id}-clip"><rect x="${n(plot.x)}" y="${n(plot.y)}" width="${n(plot.width)}" height="${n(plot.height)}"/></clipPath></defs>`;
  if (theme.background !== "transparent") {
    out += `<rect width="${width}" height="${height}" fill="${escapeXml(theme.background)}"/>`;
  }
  const grid = gridPath(scene);
  if (grid) out += `<path d="${grid}" stroke="${escapeXml(theme.grid)}" fill="none"/>`;
  out += `<g clip-path="url(#${id}-clip)">`;
  const encode = options.encodeRaster;
  for (const mark of scene.marks) {
    if (isGuide(mark) || (mark.kind === "raster" && !encode)) continue;
    out += markElement(mark, theme, encode!);
  }
  out += "</g>";
  out += guideElements(scene.marks, theme);
  out += `<g style="font-variant-numeric:tabular-nums">${axisElements(scene.axes, theme)}</g>`;
  out += titleElement(scene);
  if (options.legend ?? true) out += legendElements(scene.legend, theme);
  if (scene.colorLegend) out += colorLegendElement(scene.colorLegend, theme, `${id}-ramp`);
  return `${out}</svg>`;
}
