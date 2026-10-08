// Scene to SVG markup. Used directly for static output (server rendering,
// exports) and piecewise by the live SVG renderer. Each mark's geometry is
// drawn by the drawing it carries; this module draws the chart around it.

import { escapeXml, n } from "../draw/markup.ts";
import {
  type AxisGeometry,
  type ColorLegend,
  type Geometry,
  type GlyphLegend,
  LEGEND_SWATCH,
  type LegendItem,
  type Panel,
  rampOffsets,
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

/** A panel's grid lines as one path. */
export function gridPath(panel: Panel): string {
  const { plot, grid } = panel;
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
      // Labels sit outside the plot: left of a left axis, right of a right one.
      const left = axis.orient === "left";
      const x = left ? axis.offset - 8 : axis.offset + 8;
      const anchor = left ? "end" : "start";
      for (const tick of axis.ticks) {
        out += `<text x="${n(x)}" y="${n(tick.position)}" text-anchor="${anchor}" dominant-baseline="middle">${escapeXml(tick.label)}</text>`;
      }
    }
    if (axis.title) {
      // Vertical titles read bottom to top on the left and top to bottom on the right.
      const angle = axis.orient === "left" ? -90 : axis.orient === "right" ? 90 : 0;
      const rotate = angle
        ? ` transform="rotate(${angle} ${n(axis.title.x)} ${n(axis.title.y)})"`
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
    const fill = escapeXml(item.color);
    // Point series show their symbol.
    const swatch = item.glyph
      ? `<path transform="translate(${n(item.x + LEGEND_SWATCH / 2)} ${n(item.y)})" d="${item.glyph}" fill="${fill}"/>`
      : `<rect x="${n(item.x)}" y="${n(swatchY)}" width="${LEGEND_SWATCH}" height="${LEGEND_SWATCH}" rx="2" fill="${fill}"/>`;
    out += `<g${opacity}>${swatch}`;
    out += `<text x="${n(item.x + LEGEND_SWATCH + 6)}" y="${n(item.y)}" dominant-baseline="middle" fill="${escapeXml(theme.text)}">${escapeXml(item.label)}</text></g>`;
  }
  return out;
}

/** Continuous color legend; `id` must be unique in the document (for the gradient). */
export function colorLegendElement(legend: ColorLegend, theme: Theme, id: string): string {
  const offsets = rampOffsets(legend);
  const stops = legend.stops
    .map((color, i) => `<stop offset="${n(offsets[i]! * 100)}%" stop-color="${escapeXml(color)}"/>`)
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

/** Legends of point sizes and shapes. */
export function glyphLegendElements(legends: readonly GlyphLegend[], theme: Theme): string {
  let out = "";
  const text = (x: number, y: number, value: string, fill: string) =>
    `<text x="${n(x)}" y="${n(y)}" dominant-baseline="middle" fill="${escapeXml(fill)}">${escapeXml(value)}</text>`;
  for (const { title, entries } of legends) {
    out += text(title.x, title.y, title.text, theme.text);
    out += `<g fill="${escapeXml(theme.muted)}" fill-opacity="0.6">`;
    for (const { glyph, x, y } of entries)
      out += `<path transform="translate(${n(x)} ${n(y)})" d="${glyph}"/>`;
    out += "</g>";
    for (const { y, label } of entries) out += text(label.x, y, label.text, theme.muted);
  }
  return out;
}

/** Each panel's facet value above its plot. */
export function panelTitleElements(panels: readonly Panel[], theme: Theme): string {
  let out = "";
  for (const { title } of panels) {
    if (!title) continue;
    out += `<text x="${n(title.x)}" y="${n(title.y)}" dominant-baseline="middle" font-weight="600" fill="${escapeXml(theme.text)}">${escapeXml(title.text)}</text>`;
  }
  return out;
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
  const { theme, width, height } = scene;
  const id = options.idPrefix ?? "herceg";
  const title = options.title ?? scene.title?.text;
  const labelled = [title ? `${id}-title` : "", options.description ? `${id}-desc` : ""]
    .filter(Boolean)
    .join(" ");
  let out = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img"${labelled ? ` aria-labelledby="${labelled}"` : ""} font-family="${escapeXml(theme.font)}" font-size="${theme.fontSize}" fill="${escapeXml(theme.muted)}">`;
  if (title) out += `<title id="${id}-title">${escapeXml(title)}</title>`;
  if (options.description) out += `<desc id="${id}-desc">${escapeXml(options.description)}</desc>`;
  out += "<defs>";
  scene.panels.forEach(({ plot }, i) => {
    out += `<clipPath id="${id}-clip-${i}"><rect x="${n(plot.x)}" y="${n(plot.y)}" width="${n(plot.width)}" height="${n(plot.height)}"/></clipPath>`;
  });
  out += "</defs>";
  if (theme.background !== "transparent") {
    out += `<rect width="${width}" height="${height}" fill="${escapeXml(theme.background)}"/>`;
  }
  const grid = scene.panels.map(gridPath).join("");
  if (grid) out += `<path d="${grid}" stroke="${escapeXml(theme.grid)}" fill="none"/>`;
  const context: SvgContext = { theme, encodeRaster: options.encodeRaster };
  scene.panels.forEach(({ marks }, i) => {
    out += `<g clip-path="url(#${id}-clip-${i})">`;
    for (const mark of marks) if (!mark.draw.guide) out += mark.draw.svg(mark, context);
    out += "</g>";
  });
  for (const panel of scene.panels) out += guideElements(panel.marks, context);
  const axes = scene.panels.flatMap((panel) => panel.axes);
  out += `<g style="font-variant-numeric:tabular-nums">${axisElements(axes, theme)}</g>`;
  out += panelTitleElements(scene.panels, theme);
  out += titleElement(scene);
  if (options.legend ?? true) out += legendElements(scene.legend, theme);
  scene.colorLegends.forEach((legend, i) => {
    out += colorLegendElement(legend, theme, `${id}-ramp-${i}`);
  });
  out += glyphLegendElements(scene.glyphLegends, theme);
  return `${out}</svg>`;
}
