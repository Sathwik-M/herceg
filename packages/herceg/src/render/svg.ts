// Scene to SVG markup. Used directly for static output (server rendering,
// exports) and piecewise by the live SVG renderer. Each mark's geometry is
// drawn by the drawing it carries; guides are drawn from their items, which
// say where everything goes, so this module places nothing itself.

import { dashAttribute, escapeXml, n, rectMarkup } from "../draw/markup.ts";
import { textItemMarkup } from "../draw/text.ts";
import { gridStrokes } from "../scene/grid.ts";
import {
  type ColorbarGuide,
  clipOf,
  type Geometry,
  type Guide,
  type GuideItem,
  type Panel,
  type RampGuide,
  type Scene,
  type ShapeItem,
  type SvgContext,
  type TitleGuide,
} from "../scene/scene.ts";
import type { StrokePaint } from "../style/style.ts";
import type { Theme } from "../theme.ts";

/**
 * Markup of a panel's geometry the plot does not cut: data, then guides
 * (rules, text), each in a group cut to the plot (`plot`, a clip path's id)
 * or the chart (`chart`) when its mark asks for that.
 */
export function uncutMarkup(
  marks: readonly Geometry[],
  context: SvgContext,
  plot: string,
  chart: string,
): string {
  let data = "";
  let guides = "";
  for (const mark of marks) {
    const clip = clipOf(mark);
    if (clip === "plot" && !mark.draw.guide) continue;
    let markup = mark.draw.svg(mark, context);
    if (clip) markup = `<g clip-path="url(#${clip === "plot" ? plot : chart})">${markup}</g>`;
    if (mark.draw.guide) guides += markup;
    else data += markup;
  }
  return data + guides;
}

/** Whether any geometry of the scene is cut to the chart, which needs a clip path of its own. */
export function cutToChart(scene: Scene): boolean {
  return scene.panels.some((panel) => panel.marks.some((mark) => mark.clip === "chart"));
}

/** Path data of segments: horizontal and vertical ones in the short forms. */
export function segmentPath(coords: readonly number[]): string {
  let d = "";
  for (let i = 0; i + 3 < coords.length; i += 4) {
    const [x1, y1, x2, y2] = [coords[i]!, coords[i + 1]!, coords[i + 2]!, coords[i + 3]!];
    d += `M${n(x1)} ${n(y1)}`;
    d += y1 === y2 ? `H${n(x2)}` : x1 === x2 ? `V${n(y2)}` : `L${n(x2)} ${n(y2)}`;
  }
  return d;
}

/** A stroke's attributes: its color, and its width, dash, and opacity where they are not the defaults. */
export function strokeAttributes(paint: StrokePaint): string {
  return (
    ` stroke="${escapeXml(paint.stroke)}"` +
    (paint.strokeWidth !== 1 ? ` stroke-width="${paint.strokeWidth}"` : "") +
    dashAttribute(paint.dash) +
    (paint.opacity !== 1 ? ` stroke-opacity="${paint.opacity}"` : "")
  );
}

/** A shape item's markup: its path about its point, outlined 1 pixel wide when it has a stroke. */
export function shapeMarkup(item: ShapeItem): string {
  const opacity = item.opacity !== undefined ? ` opacity="${item.opacity}"` : "";
  const fillOpacity = item.fillOpacity !== undefined ? ` fill-opacity="${item.fillOpacity}"` : "";
  const outline = item.stroke
    ? ` stroke="${escapeXml(item.stroke)}" stroke-width="1" stroke-linejoin="round"`
    : "";
  return `<path transform="translate(${n(item.at[0])} ${n(item.at[1])})" d="${item.d}" fill="${escapeXml(item.fill)}"${fillOpacity}${outline}${opacity}/>`;
}

/**
 * Markup of a guide's items (an axis', or `guide`'s); `id` makes a
 * document-unique id for each ramp's gradient.
 */
export function itemsMarkup(
  items: readonly GuideItem[],
  root: Theme,
  id: () => string,
  guide?: Guide,
): string {
  let out = "";
  for (const item of items) {
    switch (item.type) {
      case "text":
        out += textItemMarkup(item, root);
        break;
      case "segments":
        if (item.coords.length > 0)
          out += `<path d="${segmentPath(item.coords)}"${strokeAttributes(item.paint)} fill="none"/>`;
        break;
      case "shape":
        out += shapeMarkup(item);
        break;
      case "rect": {
        const opacity = item.opacity !== undefined ? ` opacity="${item.opacity}"` : "";
        out += rectMarkup(item, item.radius, ` fill="${escapeXml(item.fill)}"${opacity}`);
        break;
      }
      case "ramp":
        out += (guide as RampGuide | ColorbarGuide).rampMarkup(item, id());
        break;
    }
  }
  return out;
}

/** Markup of what is drawn under the data: the chart's and plots' backgrounds, and the grid lines. */
export function underMarkup(scene: Scene): string {
  const { theme, width, height } = scene;
  let out =
    theme.background !== "transparent"
      ? `<rect width="${width}" height="${height}" fill="${escapeXml(theme.background)}"/>`
      : "";
  for (const { plot, frame } of scene.panels)
    if (frame?.fill) out += rectMarkup(plot, 0, ` fill="${escapeXml(frame.fill)}"`);
  for (const stroke of gridStrokes(scene.panels, theme))
    out += `<path d="${segmentPath(stroke.coords)}"${strokeAttributes(stroke.paint)} fill="none"/>`;
  return out;
}

/** Markup of plots' borders, drawn over the data. */
export function plotBorders(panels: readonly Panel[]): string {
  let out = "";
  for (const { plot, frame } of panels)
    if (frame?.stroke)
      out += rectMarkup(
        plot,
        0,
        ` fill="none" stroke="${escapeXml(frame.stroke)}"${frame.strokeWidth !== 1 ? ` stroke-width="${frame.strokeWidth}"` : ""}`,
      );
  return out;
}

/**
 * Markup of a scene's axes, plot borders, and guides; without `legend`,
 * not the series legend, which the browser draws as buttons.
 */
export function guidesMarkup(scene: Scene, id: string, legend: boolean): string {
  const root = scene.theme;
  let ramps = 0;
  const next = () => `${id}-ramp-${ramps++}`;
  let out = '<g style="font-variant-numeric:tabular-nums">';
  for (const panel of scene.panels)
    for (const axis of panel.axes) out += itemsMarkup(axis.items, root, next);
  out += "</g>";
  out += plotBorders(scene.panels);
  for (const guide of scene.guides)
    if (legend || guide.kind !== "legend") out += itemsMarkup(guide.items, root, next, guide);
  return out;
}

/** An alignment of SVG's `preserveAspectRatio`. */
export type SvgAlign =
  | "xMinYMin"
  | "xMidYMin"
  | "xMaxYMin"
  | "xMinYMid"
  | "xMidYMid"
  | "xMaxYMid"
  | "xMinYMax"
  | "xMidYMax"
  | "xMaxYMax";

/**
 * How a standalone SVG sizes and scales. Scaling an SVG scales its text and
 * geometry as they are laid out; a live chart lays itself out again at a
 * new size instead.
 */
export interface SvgSizing {
  /**
   * "fixed" (the default): width and height attributes of the chart's size.
   * "fluid": neither, so CSS or the container sizes the SVG, its viewBox
   * scaling the chart to fit (as wide as its container by default).
   */
  sizing?: "fixed" | "fluid" | undefined;
  /**
   * How the chart fits a box of another aspect ratio, as SVG's attribute
   * of the same name says: "none" stretches it; the default centers it whole.
   */
  preserveAspectRatio?: "none" | SvgAlign | `${SvgAlign} ${"meet" | "slice"}` | undefined;
  /**
   * "fixed": lines and outlines keep their width in pixels however the SVG
   * scales. "scale" (the default) scales them with it.
   */
  strokeScaling?: "scale" | "fixed" | undefined;
}

/** Each sizing option, the values it takes, and how messages say them. */
const SIZING: readonly [keyof SvgSizing, RegExp, string][] = [
  ["sizing", /^(fixed|fluid)$/, '"fixed" or "fluid"'],
  [
    "preserveAspectRatio",
    /^(none|x(Min|Mid|Max)Y(Min|Mid|Max)( (meet|slice))?)$/,
    '"none" or an alignment such as "xMidYMid meet"',
  ],
  ["strokeScaling", /^(scale|fixed)$/, '"scale" or "fixed"'],
];

/** Throws for `SvgSizing` options that are not valid, named under `where` (such as "renderToSVG"). */
export function checkSizing(options: SvgSizing, where: string): void {
  for (const [key, valid, expected] of SIZING) {
    const value: unknown = options[key];
    if (value !== undefined && !(typeof value === "string" && valid.test(value)))
      throw new TypeError(
        `${where} ${key}: expected ${expected}; received ${JSON.stringify(value)}`,
      );
  }
}

export interface SvgOptions extends SvgSizing {
  /** Raster image encoder; rasters are omitted without one. */
  encodeRaster?: SvgContext["encodeRaster"];
  /** Prefix for element ids, unique per document. */
  idPrefix?: string;
  /** Accessible name; defaults to the scene title. */
  title?: string;
  description?: string;
  /** Include the legend (the browser runtime renders it as HTML instead). */
  legend?: boolean;
  /**
   * Draw text unkerned and without ligatures, as supplied fonts measure
   * it: glyph after glyph.
   */
  unkerned?: boolean;
}

/** Complete, standalone SVG document for a scene. */
export function renderSvg(scene: Scene, options: SvgOptions = {}): string {
  const { theme, width, height } = scene;
  const id = options.idPrefix ?? "herceg";
  const title =
    options.title ??
    (scene.guides.find((guide) => guide.kind === "title") as TitleGuide | undefined)?.text;
  const labelled = [title ? `${id}-title` : "", options.description ? `${id}-desc` : ""]
    .filter(Boolean)
    .join(" ");
  const size = options.sizing === "fluid" ? "" : ` width="${width}" height="${height}"`;
  const aspect = options.preserveAspectRatio;
  const fixed = options.strokeScaling === "fixed";
  let out = `<svg xmlns="http://www.w3.org/2000/svg"${fixed ? ` id="${escapeXml(id)}"` : ""}${size} viewBox="0 0 ${width} ${height}"${aspect ? ` preserveAspectRatio="${aspect}"` : ""} role="img"${labelled ? ` aria-labelledby="${labelled}"` : ""} font-family="${escapeXml(theme.font)}" font-size="${theme.fontSize}" fill="${escapeXml(theme.muted)}"${options.unkerned ? ' style="font-kerning:none;font-variant-ligatures:none"' : ""}>`;
  if (title) out += `<title id="${id}-title">${escapeXml(title)}</title>`;
  if (options.description) out += `<desc id="${id}-desc">${escapeXml(options.description)}</desc>`;
  // vector-effect is not inherited, so every element of this document gets
  // it (and of no other, where the SVG is inlined into a page).
  if (fixed)
    out += `<style>[id="${escapeXml(cssString(id))}"] *{vector-effect:non-scaling-stroke}</style>`;
  out += "<defs>";
  scene.panels.forEach(({ plot }, i) => {
    out += `<clipPath id="${id}-clip-${i}">${rectMarkup(plot, 0, "")}</clipPath>`;
  });
  if (cutToChart(scene))
    out += `<clipPath id="${id}-clip-chart"><rect width="${width}" height="${height}"/></clipPath>`;
  out += `</defs>${underMarkup(scene)}`;
  const context: SvgContext = { theme, encodeRaster: options.encodeRaster };
  scene.panels.forEach(({ marks }, i) => {
    out += `<g clip-path="url(#${id}-clip-${i})">`;
    for (const mark of marks)
      if (!mark.draw.guide && clipOf(mark) === "plot") out += mark.draw.svg(mark, context);
    out += "</g>";
  });
  scene.panels.forEach(({ marks }, i) => {
    out += uncutMarkup(marks, context, `${id}-clip-${i}`, `${id}-clip-chart`);
  });
  out += guidesMarkup(scene, id, options.legend ?? true);
  return `${out}</svg>`;
}

/**
 * `text` inside a CSS string: quotes, backslashes, and line breaks escaped,
 * so any id prefix (one starting with a digit too) selects its document.
 */
function cssString(text: string): string {
  return text.replace(/["\\\n\r]/g, (c) => `\\${c.charCodeAt(0).toString(16)} `);
}
