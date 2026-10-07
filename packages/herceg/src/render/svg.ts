// Scene to SVG markup. Used directly for static output (server rendering,
// exports) and piecewise by the live SVG renderer. Each mark's geometry is
// drawn by the drawing it carries; this module draws the chart around it.

import { escapeXml, n } from "../draw/markup.ts";
import {
  type AxisGeometry,
  type ColorLegend,
  type Geometry,
  LEGEND_SWATCH,
  type LegendItem,
  type Scene,
  type SvgContext,
} from "../scene/scene.ts";
import type { Theme } from "../theme.ts";

/** Markup of the guides (rules, text), drawn above the data. */
export function guideElements(marks: readonly Geometry[], context: SvgContext): string {
  let out = "";
  for (const mark of marks) if (mark.draw.guide) out += mark.draw.svg(mark, context);
  return out;
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
  encodeRaster?: SvgContext["encodeRaster"];
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
  const context: SvgContext = { theme, encodeRaster: options.encodeRaster };
  for (const mark of scene.marks) if (!mark.draw.guide) out += mark.draw.svg(mark, context);
  out += "</g>";
  out += guideElements(scene.marks, context);
  out += `<g style="font-variant-numeric:tabular-nums">${axisElements(scene.axes, theme)}</g>`;
  out += titleElement(scene);
  if (options.legend ?? true) out += legendElements(scene.legend, theme);
  if (scene.colorLegend) out += colorLegendElement(scene.colorLegend, theme, `${id}-ramp`);
  return `${out}</svg>`;
}
