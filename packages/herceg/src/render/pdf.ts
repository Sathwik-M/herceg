// Scene to PDF: the same drawing as the static SVG (render/svg.ts), as
// vector paths, text in the standard PDF fonts, and images for rasters.
//
// Geometry is drawn by a switch on its kind here rather than by a `pdf`
// member of each drawing. Marks import their drawings, so whatever a drawing
// holds ships in every bundle that uses the mark, while PDF output is rare
// and usually server-side; this way only `herceg/pdf` carries it. The cost
// is that this module knows the built-in geometry kinds: the switch is
// checked against `MarkGeometry` at compile time, and other kinds (from
// third-party drawings) are refused with an error.

import { arcSweep, sectorsByColor, traceArcs } from "../draw/arc.ts";
import { traceArea, traceAreaOutline } from "../draw/area.ts";
import { type FaceSink, faceRuns, traceFace, traceOutline } from "../draw/faces.ts";
import { hasIsolated, traceLine } from "../draw/line.ts";
import { KAPPA, type PathSink } from "../draw/markup.ts";
import { placeCloud } from "../draw/point.ts";
import { tracePolygon } from "../draw/polygons.ts";
import { traceRects } from "../draw/rect.ts";
import { ruleLabel } from "../draw/rule.ts";
import { MIDDLE_TO_BASELINE } from "../draw/shapes.ts";
import { SYMBOLS, symbolPath } from "../draw/symbols.ts";
import { HALO_WIDTH, textHalo } from "../draw/text.ts";
import { parseFont } from "../layout/text.ts";
import { isLightColor } from "../scale/color.ts";
import { cssColor } from "../scale/css-color.ts";
import {
  type Geometry,
  LEGEND_SWATCH,
  type MarkGeometry,
  type PointGeometry,
  type Rect,
  rampOffsets,
  type Scene,
  tickLabelGap,
} from "../scene/scene.ts";
import { surface, type Theme } from "../theme.ts";
import { type DocumentInfo, language, literal, num, PdfPage, PdfWriter } from "./pdf-document.ts";
import type { PdfFontResolver } from "./pdf-font-resolver.ts";
import { encodeText, type PdfFont, standardFont, textWidth } from "./pdf-fonts.ts";
import { tracePath } from "./svg-path.ts";

/** Bézier control distance for a quarter circle of radius 1. */

/** Most pixels a heatmap image grows to when its cells are repeated (as many as heatmaps have cells). */
const MAX_IMAGE_PIXELS = 4_194_304;

/** Collects path operators; a move is written only once a segment follows it. */
class PathBuilder {
  operators = "";
  #move = "";
  /** The current point and where its subpath started, as arcs need them. */
  #x = Number.NaN;
  #y = Number.NaN;
  #startX = Number.NaN;
  #startY = Number.NaN;

  moveTo(x: number, y: number): void {
    this.#move = `${num(x)} ${num(y)} m\n`;
    this.#x = this.#startX = x;
    this.#y = this.#startY = y;
  }

  #segment(operators: string): void {
    this.operators += this.#move + operators;
    this.#move = "";
  }

  lineTo(x: number, y: number): void {
    this.#segment(`${num(x)} ${num(y)} l\n`);
    this.#x = x;
    this.#y = y;
  }

  bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    this.#segment(`${num(x1)} ${num(y1)} ${num(x2)} ${num(y2)} ${num(x)} ${num(y)} c\n`);
    this.#x = x;
    this.#y = y;
  }

  closePath(): void {
    // A subpath of one point stays empty rather than becoming a dot.
    if (this.#move) this.#move = "";
    else if (this.operators) this.operators += "h\n";
    this.#x = this.#startX;
    this.#y = this.#startY;
  }

  rect(x: number, y: number, width: number, height: number): void {
    this.#move = "";
    this.operators += `${num(x)} ${num(y)} ${num(width)} ${num(height)} re\n`;
    this.#x = this.#startX = x;
    this.#y = this.#startY = y;
  }

  /** A circular arc as on a canvas, in cubic curves of at most a quarter turn. */
  arc(cx: number, cy: number, r: number, a0: number, a1: number, counterclockwise = false): void {
    const x = cx + r * Math.cos(a0);
    const y = cy + r * Math.sin(a0);
    if (Number.isNaN(this.#x)) this.moveTo(x, y);
    else if (Math.abs(x - this.#x) > 0.01 || Math.abs(y - this.#y) > 0.01) this.lineTo(x, y);
    const sweep = arcSweep(a0, a1, counterclockwise);
    const parts = Math.ceil(sweep / (Math.PI / 2));
    const step = (counterclockwise ? -sweep : sweep) / parts;
    // Control points along the tangents, 4/3 tan(step / 4) radii away.
    const k = (4 / 3) * Math.tan(step / 4);
    for (let i = 0; i < parts; i++) {
      const [c0, s0] = [Math.cos(a0 + step * i), Math.sin(a0 + step * i)];
      const [c1, s1] = [Math.cos(a0 + step * (i + 1)), Math.sin(a0 + step * (i + 1))];
      this.bezierCurveTo(
        cx + r * (c0 - k * s0),
        cy + r * (s0 + k * c0),
        cx + r * (c1 + k * s1),
        cy + r * (s1 - k * c1),
        cx + r * c1,
        cy + r * s1,
      );
    }
  }

  circle(x: number, y: number, r: number): void {
    const k = r * KAPPA;
    this.moveTo(x + r, y);
    this.bezierCurveTo(x + r, y + k, x + k, y + r, x, y + r);
    this.bezierCurveTo(x - k, y + r, x - r, y + k, x - r, y);
    this.bezierCurveTo(x - r, y - k, x - k, y - r, x, y - r);
    this.bezierCurveTo(x + k, y - r, x + r, y - k, x + r, y);
    this.closePath();
  }

  roundedRect(x: number, y: number, width: number, height: number, radius: number): void {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    const k = r * (1 - KAPPA);
    const right = x + width;
    const bottom = y + height;
    this.moveTo(x + r, y);
    this.lineTo(right - r, y);
    this.bezierCurveTo(right - k, y, right, y + k, right, y + r);
    this.lineTo(right, bottom - r);
    this.bezierCurveTo(right, bottom - k, right - k, bottom, right - r, bottom);
    this.lineTo(x + r, bottom);
    this.bezierCurveTo(x + k, bottom, x, bottom - k, x, bottom - r);
    this.lineTo(x, y + r);
    this.bezierCurveTo(x, y + k, x + k, y, x + r, y);
    this.closePath();
  }
}

/** Channels from 0 to 1 and alpha times `opacity`; undefined when nothing would show. */
function color(css: string, opacity = 1): [number, number, number, number] | undefined {
  if (css === "none") return undefined;
  const rgba = cssColor(css);
  if (!rgba) {
    throw new TypeError(
      `PDF export cannot read the color ${JSON.stringify(css)}; use hex, rgb(), hsl(), or a CSS color name`,
    );
  }
  const alpha = Math.min(1, Math.max(0, rgba[3] * opacity));
  if (!(alpha > 0)) return undefined;
  const channel = (value: number) => Math.min(1, Math.max(0, value / 255));
  return [channel(rgba[0]), channel(rgba[1]), channel(rgba[2]), alpha];
}

function rgb(c: readonly number[]): string {
  return `${num(c[0]!, 3)} ${num(c[1]!, 3)} ${num(c[2]!, 3)}`;
}

interface PaintStyle {
  fill?: string | undefined;
  fillOpacity?: number | undefined;
  stroke?: string | undefined;
  strokeWidth?: number | undefined;
  strokeOpacity?: number | undefined;
  dash?: readonly number[] | undefined;
  /** Default "butt", as in SVG. */
  cap?: "butt" | "round";
  /** Default "miter", as in SVG. */
  join?: "miter" | "round";
  /** Fill with the even-odd rule rather than nonzero winding. */
  evenOdd?: boolean;
}

/**
 * Opens a graphics state painting with `style` and returns the operators
 * that paint a path with it, or undefined (and opens nothing) when it would
 * paint nothing. The caller closes the state with "Q".
 */
function begin(page: PdfPage, style: PaintStyle): ("f" | "f*" | "S")[] | undefined {
  const fill = style.fill === undefined ? undefined : color(style.fill, style.fillOpacity);
  // PDF draws a width of 0 as the thinnest visible line, SVG draws nothing.
  const raw = style.strokeWidth ?? 1;
  const width = num(raw, 3);
  const stroke =
    style.stroke === undefined || !(Number.isFinite(raw) && Number(width) > 0)
      ? undefined
      : color(style.stroke, style.strokeOpacity);
  if (!fill && !stroke) return undefined;
  let state = "q";
  const fillAlpha = fill?.[3] ?? 1;
  const strokeAlpha = stroke?.[3] ?? 1;
  if (fillAlpha < 1 || strokeAlpha < 1) state += ` /${page.opacity(fillAlpha, strokeAlpha)} gs`;
  if (fill) state += ` ${rgb(fill)} rg`;
  if (stroke) {
    state += ` ${rgb(stroke)} RG ${width} w ${style.cap === "round" ? 1 : 0} J`;
    // SVG's default miter limit is 4; PDF's is 10.
    state += style.join === "round" ? " 1 j" : " 0 j 4 M";
    // Patterns SVG cannot draw (all zeros, negative lengths) draw solid
    // lines; PDF rejects a pattern of zeros.
    const dash = style.dash?.every(Number.isFinite) ? style.dash.map((d) => num(d, 3)) : [];
    if (dash.some((d) => Number(d) > 0) && dash.every((d) => Number(d) >= 0))
      state += ` [${dash.join(" ")}] 0 d`;
  }
  page.write(`${state}\n`);
  // Filled and stroked paths are painted twice rather than with "B", which
  // knocks the fill out under a translucent stroke instead of compositing
  // the stroke over it as SVG does.
  const filled = style.evenOdd ? "f*" : "f";
  return fill && stroke ? [filled, "S"] : fill ? [filled] : ["S"];
}

function paint(page: PdfPage, path: PathBuilder, style: PaintStyle): void {
  if (!path.operators) return;
  const operators = begin(page, style);
  if (!operators) return;
  for (const operator of operators) page.write(`${path.operators}${operator}\n`);
  page.write("Q\n");
}

/** How far below the text's `y` its alphabetic baseline lies, in font sizes. */
const BASELINE = {
  // As for text of custom marks (draw/shapes.ts).
  middle: MIDDLE_TO_BASELINE,
  // Helvetica's cap height: capitals and digits hang from `y`.
  hanging: 0.72,
  alphabetic: 0,
};

interface TextStyle {
  font: PdfFont | { family: string; bold: boolean };
  size: number;
  fill: string;
  opacity?: number;
  anchor?: "start" | "middle" | "end";
  baseline: keyof typeof BASELINE;
  /** Degrees, clockwise, around (x, y). */
  angle?: number;
  halo?: { color: string; opacity: number } | undefined;
}

function textFont(page: PdfPage, family: string, bold: boolean): TextStyle["font"] {
  return page.resolver ? { family, bold } : standardFont(family, bold);
}

function text(page: PdfPage, content: string, x: number, y: number, style: TextStyle): void {
  const resolved =
    typeof style.font === "string"
      ? undefined
      : page.resolver!.resolve(content, style.font.family, style.font.bold);
  const encoded = resolved ? "" : encodeText(content);
  if (resolved ? !resolved.runs.length : !encoded) return;
  const fill = color(style.fill, style.opacity);
  if (!fill) return;
  const halo = style.halo && color(style.halo.color, style.halo.opacity);
  const radians = ((style.angle ?? 0) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const along =
    (style.anchor === "middle" ? 0.5 : style.anchor === "end" ? 1 : 0) *
    (resolved?.width ?? textWidth(encoded, style.font as PdfFont)) *
    style.size;
  const baseline = resolved
    ? style.baseline === "hanging"
      ? resolved.capHeight
      : style.baseline === "middle"
        ? resolved.capHeight / 2
        : 0
    : BASELINE[style.baseline];
  const down = baseline * style.size;
  const ox = x - along * cos - down * sin;
  const oy = y - along * sin + down * cos;
  // The page's y axis points down, so the text matrix flips glyphs upright.
  const spans = resolved?.runs.map((run) => ({
    font: run.face,
    encoded: run.face.encode(run.glyphs),
    width: run.width,
  })) ?? [{ font: style.font as PdfFont, encoded: literal(encoded), width: 0 }];
  const show = (mode: number) => {
    let out = "";
    let offset = 0;
    for (const span of spans) {
      const precision = resolved ? 6 : 2;
      out += `BT /${page.font(span.font)} ${num(style.size, precision)} Tf ${mode} Tr ${num(cos, precision)} ${num(sin, precision)} ${num(sin, precision)} ${num(-cos, precision)} ${num(ox + offset * cos, precision)} ${num(oy + offset * sin, precision)} Tm ${span.encoded} Tj ET\n`;
      offset += span.width * style.size;
    }
    return out;
  };
  let out = "q";
  const haloAlpha = halo?.[3] ?? 1;
  if (fill[3] < 1 || haloAlpha < 1) out += ` /${page.opacity(fill[3], haloAlpha)} gs`;
  out += ` ${rgb(fill)} rg`;
  // The halo is the glyphs' outline, drawn first so the fill covers its
  // inner half. Its replacement text is empty, so readers that honor
  // replacement text in marked content (a PDF 1.5 feature; MuPDF does,
  // macOS Preview does not) copy and search the label once. Other readers
  // ignore the entry, which leaves the document valid PDF 1.4.
  if (halo)
    out += ` ${rgb(halo)} RG ${HALO_WIDTH} w 1 j\n/Span << /ActualText () >> BDC ${show(1).trim()} EMC\n`;
  else out += "\n";
  page.write(`${out}${show(0)}Q\n`);
}

/** A path sink that moves everything it is given by (dx, dy). */
function shifted(sink: PathBuilder, dx: number, dy: number): PathSink {
  return {
    moveTo: (x, y) => sink.moveTo(x + dx, y + dy),
    lineTo: (x, y) => sink.lineTo(x + dx, y + dy),
    bezierCurveTo: (x1, y1, x2, y2, x, y) =>
      sink.bezierCurveTo(x1 + dx, y1 + dy, x2 + dx, y2 + dy, x + dx, y + dy),
    closePath: () => sink.closePath(),
    rect: (x, y, width, height) => sink.rect(x + dx, y + dy, width, height),
  };
}

/**
 * Points encoding fields, as the SVG and canvas renderers draw them: opaque
 * ones one path per color, low values first; translucent ones one by one.
 */
function paintEncoded(page: PdfPage, mark: PointGeometry): void {
  const c = mark.coords;
  const point = (i: number, path: PathBuilder) => {
    const r = mark.radii ? mark.radii[i]! : mark.radius;
    const symbol = mark.symbols ? SYMBOLS[mark.symbols[i]!]! : mark.symbol;
    tracePath(symbolPath(symbol, c[i * 2]!, c[i * 2 + 1]!, r), path);
  };
  const fillOf = (i: number) =>
    mark.colors ? mark.colors.palette[mark.colors.index[i]!]! : mark.fill;
  if (mark.opaque && !mark.ring) {
    const groups = new Map<number, number[]>();
    for (let i = 0; i < mark.count; i++) {
      const tone = mark.colors ? mark.colors.index[i]! : 0;
      const group = groups.get(tone);
      if (group) group.push(i);
      else groups.set(tone, [i]);
    }
    for (const tone of [...groups.keys()].sort((a, b) => a - b)) {
      const path = new PathBuilder();
      const group = groups.get(tone)!;
      for (const i of group) point(i, path);
      paint(page, path, { fill: fillOf(group[0]!), fillOpacity: mark.fillOpacity });
    }
    return;
  }
  for (let i = 0; i < mark.count; i++) {
    const path = new PathBuilder();
    point(i, path);
    paint(page, path, {
      fill: fillOf(i),
      fillOpacity: mark.opacities ? mark.opacities[i]! : mark.fillOpacity,
      ...ringStyle(mark),
    });
  }
}

/** The paint style of a points' ring, if they have one. */
function ringStyle(mark: PointGeometry): PaintStyle {
  return mark.ring ? { stroke: mark.ring.color, strokeWidth: mark.ring.width, join: "round" } : {};
}

function paintPoints(page: PdfPage, mark: PointGeometry): void {
  if (mark.symbol !== "circle" || mark.radii || mark.colors || mark.opacities || mark.symbols) {
    paintEncoded(page, mark);
    return;
  }
  const c = mark.coords;
  const style = { fill: mark.fill, fillOpacity: mark.fillOpacity, ...ringStyle(mark) };
  const path = new PathBuilder();
  if (mark.opaque && !mark.ring) {
    for (let i = 0; i < mark.count; i++) path.circle(c[i * 2]!, c[i * 2 + 1]!, mark.radius);
    paint(page, path, style);
    return;
  }
  // One fill per point so overlapping translucent points darken, as in SVG.
  const operators = begin(page, style);
  if (!operators) return;
  for (let i = 0; i < mark.count; i++) {
    path.operators = "";
    path.circle(c[i * 2]!, c[i * 2 + 1]!, mark.radius);
    for (const operator of operators) page.write(`${path.operators}${operator}\n`);
  }
  page.write("Q\n");
}

/**
 * How many times a raster's pixels repeat across and down in its image.
 * Some viewers smooth images whatever /Interpolate says (macOS Preview
 * does), blurring cells into each other; repeating the pixel of each cell
 * wider than a CSS pixel to about two per CSS pixel confines that blur to
 * cell edges. The image stays within MAX_IMAGE_PIXELS (or the cell count).
 */
export function cellRepeat(
  width: number,
  height: number,
  columns: number,
  rows: number,
): [number, number] {
  const per = (size: number, count: number) =>
    size / count < 1 ? 1 : Math.ceil((size / count) * 2);
  let across = per(width, columns);
  let down = per(height, rows);
  const budget = Math.max(1, Math.floor(MAX_IMAGE_PIXELS / (columns * rows)));
  if (across * down > budget) {
    const shrink = Math.sqrt(budget / (across * down));
    across = Math.max(1, Math.floor(across * shrink));
    down = Math.max(1, Math.floor(down * shrink));
    // Raising one factor to 1 can leave the other too large.
    if (across * down > budget) {
      if (across > down) across = Math.floor(budget / down);
      else down = Math.floor(budget / across);
    }
  }
  return [across, down];
}

function paintGeometry(
  page: PdfPage,
  geometry: Geometry,
  plot: Rect,
  theme: Theme,
  font: TextStyle["font"],
): void {
  const mark = geometry as MarkGeometry;
  const path = new PathBuilder();
  switch (mark.kind) {
    case "line":
      traceLine(path, mark.path);
      paint(page, path, {
        stroke: mark.stroke,
        strokeWidth: mark.strokeWidth,
        dash: mark.dash,
        cap: "round",
        join: "round",
      });
      return;
    case "area":
      traceArea(path, mark);
      paint(page, path, { fill: mark.fill, fillOpacity: mark.fillOpacity });
      if (mark.strokeWidth === 0) return;
      {
        const top = new PathBuilder();
        traceAreaOutline(top, mark);
        paint(page, top, {
          stroke: mark.stroke ?? mark.fill,
          strokeWidth: mark.strokeWidth,
          join: "round",
          cap: hasIsolated(mark.upper) ? "round" : "butt",
        });
      }
      return;
    case "arc": {
      // One path per color, as SVG and canvas draw them.
      const groups = sectorsByColor(mark);
      mark.colors.forEach((fill, color) => {
        const sectors = new PathBuilder();
        traceArcs(sectors, mark, groups[color]!);
        paint(page, sectors, { fill, fillOpacity: mark.fillOpacity });
      });
      return;
    }
    case "rect": {
      traceRects(path, mark);
      paint(page, path, { fill: mark.fill, fillOpacity: mark.fillOpacity });
      return;
    }
    case "segments": {
      if (mark.strokeWidth === 0) return;
      const c = mark.coords;
      for (let i = 0; i < mark.count; i++) {
        path.moveTo(c[i * 4]!, c[i * 4 + 1]!);
        path.lineTo(c[i * 4 + 2]!, c[i * 4 + 3]!);
      }
      paint(page, path, {
        stroke: mark.stroke,
        strokeWidth: mark.strokeWidth,
        strokeOpacity: mark.opacity,
        dash: mark.dash,
      });
      return;
    }
    case "point":
      paintPoints(page, mark.cloud ? placeCloud(mark, plot) : mark);
      return;
    case "raster": {
      if (mark.columns * mark.rows === 0 || !(mark.width > 0 && mark.height > 0)) return;
      const repeat = cellRepeat(mark.width, mark.height, mark.columns, mark.rows);
      const image = page.image(mark.columns, mark.rows, mark.pixels, repeat);
      // Images fill the unit square with their first row at the top (y = 1).
      page.write(
        `q ${num(mark.width)} 0 0 ${num(-mark.height)} ${num(mark.x)} ${num(mark.y + mark.height)} cm /${image} Do Q\n`,
      );
      return;
    }
    case "polygons":
      // Shape by shape, as SVG and canvas draw them.
      mark.shapes.forEach((shape, i) => {
        const rings = new PathBuilder();
        tracePolygon(rings, shape, mark.transform);
        paint(page, rings, {
          fill: mark.colors[mark.colorIndex[i]!],
          fillOpacity: mark.fillOpacity,
          evenOdd: true,
          stroke: mark.strokeWidth > 0 ? mark.stroke : undefined,
          strokeWidth: mark.strokeWidth,
          join: "round",
        });
      });
      return;
    case "faces":
      // Run by run, as SVG and canvas draw them; outlines after each run's fill.
      for (const { start, end, style } of faceRuns(mark)) {
        const fill = new PathBuilder();
        const sink: FaceSink = Object.assign(fill, {
          disc: (x: number, y: number, r: number) => fill.circle(x, y, r),
        });
        for (let f = start; f < end; f++) traceFace(sink, mark, f);
        paint(page, fill, { fill: style.fill, fillOpacity: style.opacity });
        if (style.stroke === undefined || !(style.strokeWidth > 0)) continue;
        const outline = new PathBuilder();
        const lines: FaceSink = Object.assign(outline, { disc: () => {} });
        for (let f = start; f < end; f++) traceOutline(lines, mark, f);
        paint(page, outline, {
          stroke: style.stroke,
          strokeWidth: style.strokeWidth,
          join: "round",
          cap: "round",
        });
      }
      return;
    case "shapes":
      for (const shape of mark.shapes) {
        if ("text" in shape) {
          const { family, bold } = parseFont(mark.font);
          text(page, shape.text, shape.x, shape.y, {
            font: textFont(page, family, bold),
            size: mark.fontSize,
            fill: shape.fill,
            anchor: shape.anchor,
            baseline: "middle",
          });
          continue;
        }
        const shapePath = new PathBuilder();
        tracePath(shape.d, shapePath);
        paint(page, shapePath, {
          fill: shape.fill === "none" ? undefined : shape.fill,
          fillOpacity: shape.opacity,
          stroke: shape.stroke,
          strokeWidth: shape.strokeWidth,
          strokeOpacity: shape.opacity,
          dash: shape.dash,
        });
      }
      return;
    case "rule": {
      path.moveTo(mark.x1, mark.y1);
      path.lineTo(mark.x2, mark.y2);
      paint(page, path, { stroke: mark.stroke, strokeWidth: mark.strokeWidth, dash: mark.dash });
      if (mark.label) {
        const label = ruleLabel(mark, theme.fontSize);
        text(page, mark.label, label.x, label.y, {
          font,
          size: theme.fontSize,
          fill: theme.muted,
          anchor: label.anchor,
          baseline: "alphabetic",
        });
      }
      return;
    }
    case "text": {
      const halo = mark.halo ? textHalo(mark.fill, theme) : undefined;
      for (let i = 0; i < mark.count; i++) {
        text(page, mark.labels[i]!, mark.coords[i * 2]!, mark.coords[i * 2 + 1]!, {
          font,
          size: theme.fontSize,
          fill: mark.fill,
          anchor: mark.anchor,
          baseline: "middle",
          halo,
        });
      }
      return;
    }
    default: {
      const unknown: never = mark;
      throw new Error(`PDF export cannot draw ${(unknown as Geometry).kind} geometry`);
    }
  }
}

/** A one-page PDF document of a scene, laid out as the static SVG output. */
export function renderPdf(
  scene: Scene,
  info: DocumentInfo = {},
  resolver?: PdfFontResolver,
): Uint8Array {
  const writer = new PdfWriter();
  writer.add(
    drawPdfPage(scene, new PdfPage(scene.width, scene.height, resolver), info.language),
    info,
  );
  return writer.toBytes(info);
}

/** Draws one chart, without finalizing the document's shared font subsets. */
export function drawPdfPage(scene: Scene, page: PdfPage, locale?: string): PdfPage {
  const lang = language(locale);
  const { theme, width, height } = scene;
  const regular = textFont(page, theme.font, false);
  const bold = textFont(page, theme.font, true);
  const size = theme.fontSize;

  page.write("/Artifact BMC\n");
  // Pages are white: a transparent theme with light text gets the dark
  // surface it was meant for (see `surface`), its text read as PDF reads
  // colors (named ones among them).
  const rgb = cssColor(theme.text);
  const ink = rgb ? `rgb(${rgb.slice(0, 3).map(Math.round).join(", ")})` : theme.text;
  if (theme.background !== "transparent" || isLightColor(ink)) {
    const background = new PathBuilder();
    background.rect(0, 0, width, height);
    paint(page, background, { fill: surface({ ...theme, text: ink }) });
  }

  const grid = new PathBuilder();
  for (const { plot, grid: lines } of scene.panels) {
    for (const y of lines.y) {
      grid.moveTo(plot.x, Math.round(y) + 0.5);
      grid.lineTo(plot.x + plot.width, Math.round(y) + 0.5);
    }
    for (const x of lines.x) {
      grid.moveTo(Math.round(x) + 0.5, plot.y);
      grid.lineTo(Math.round(x) + 0.5, plot.y + plot.height);
    }
  }
  paint(page, grid, { stroke: theme.grid, dash: theme.gridDash });
  // One figure owns the complete chart, including panels, labels, and legends.
  page.write("EMC\n/Figure << /MCID 0 >> BDC\n");

  if (lang) page.write(`/Span <<${lang} >> BDC\n`);

  for (const { plot, marks } of scene.panels) {
    page.write(`q ${num(plot.x)} ${num(plot.y)} ${num(plot.width)} ${num(plot.height)} re W n\n`);
    for (const mark of marks) if (!mark.draw.guide) paintGeometry(page, mark, plot, theme, regular);
    page.write("Q\n");
  }
  for (const { plot, marks } of scene.panels) {
    for (const mark of marks) if (mark.draw.guide) paintGeometry(page, mark, plot, theme, regular);
  }

  const label = { font: regular, size, fill: theme.muted };
  for (const axis of scene.panels.flatMap((panel) => panel.axes)) {
    if (axis.orient === "bottom") {
      const y = Math.round(axis.offset) + 0.5;
      if (axis.line) {
        const line = new PathBuilder();
        line.moveTo(axis.start, y);
        line.lineTo(axis.end, y);
        for (const tick of axis.ticks) {
          line.moveTo(Math.round(tick.position) + 0.5, y);
          line.lineTo(Math.round(tick.position) + 0.5, y + 5);
        }
        paint(page, line, { stroke: theme.axis });
      }
      const below = y + tickLabelGap(theme.fontSize);
      for (const tick of axis.ticks)
        text(page, tick.label, tick.position, below, {
          ...label,
          anchor: "middle",
          baseline: "hanging",
        });
    } else {
      // Labels sit outside the plot: left of a left axis, right of a right one.
      const left = axis.orient === "left";
      const x = left ? axis.offset - 8 : axis.offset + 8;
      for (const tick of axis.ticks) {
        text(page, tick.label, x, tick.position, {
          ...label,
          anchor: left ? "end" : "start",
          baseline: "middle",
        });
      }
    }
    if (axis.title) {
      // Vertical titles read bottom to top on the left and top to bottom on the right.
      text(page, axis.title.text, axis.title.x, axis.title.y, {
        ...label,
        fill: theme.text,
        anchor: "middle",
        baseline: "middle",
        angle: axis.orient === "left" ? -90 : axis.orient === "right" ? 90 : 0,
      });
    }
  }

  for (const header of scene.headers) {
    text(page, header.text, header.x, header.y, {
      ...label,
      font: bold,
      fill: theme.text,
      anchor: header.anchor,
      baseline: "middle",
      angle: header.angle,
    });
  }
  if (scene.title) {
    text(page, scene.title.text, scene.title.x, scene.title.y, {
      font: bold,
      size: theme.titleSize,
      fill: theme.text,
      baseline: "middle",
    });
  }

  for (const item of scene.legend) {
    const opacity = item.hidden ? 0.4 : 1;
    const swatch = new PathBuilder();
    // Point series show their symbol; others a rounded square.
    if (item.glyph) tracePath(item.glyph, shifted(swatch, item.x + LEGEND_SWATCH / 2, item.y));
    else swatch.roundedRect(item.x, item.y - LEGEND_SWATCH / 2, LEGEND_SWATCH, LEGEND_SWATCH, 2);
    paint(page, swatch, {
      fill: item.color,
      fillOpacity: opacity,
      ...(item.stroke && {
        stroke: item.stroke,
        strokeWidth: 1,
        strokeOpacity: opacity,
        join: "round",
      }),
    });
    text(page, item.label, item.x + LEGEND_SWATCH + 6, item.y, {
      ...label,
      fill: theme.text,
      opacity,
      baseline: "middle",
    });
  }

  for (const ramp of scene.colorLegends) {
    const y = ramp.y;
    text(page, ramp.title.text, ramp.title.x, y, {
      ...label,
      fill: theme.text,
      baseline: "middle",
    });
    text(page, ramp.low.text, ramp.low.x, y, { ...label, baseline: "middle" });
    // Ramps are opaque hex colors (checked when the theme or mark is made).
    const stops = ramp.stops.map((stop): [number, number, number] => {
      const [r, g, b] = color(stop) ?? [0, 0, 0];
      return [r, g, b];
    });
    const shading = page.gradient(
      [ramp.ramp.x, y, ramp.ramp.x + ramp.ramp.width, y],
      stops,
      rampOffsets(ramp),
    );
    const outline = new PathBuilder();
    outline.roundedRect(ramp.ramp.x, y - LEGEND_SWATCH / 2, ramp.ramp.width, LEGEND_SWATCH, 2);
    page.write(`q\n${outline.operators}W n /${shading} sh Q\n`);
    text(page, ramp.high.text, ramp.high.x, y, { ...label, baseline: "middle" });
  }

  // Size and shape keys: glyphs in the muted color; color keys: in their colors. Then their labels.
  for (const { title, entries } of scene.glyphLegends) {
    text(page, title.text, title.x, title.y, { ...label, fill: theme.text, baseline: "middle" });
    const glyphs = new PathBuilder();
    for (const { glyph, x, y, fill } of entries) {
      if (fill === undefined) tracePath(glyph, shifted(glyphs, x, y));
      else {
        const own = new PathBuilder();
        tracePath(glyph, shifted(own, x, y));
        paint(page, own, { fill });
      }
    }
    paint(page, glyphs, { fill: theme.muted, fillOpacity: 0.6 });
    for (const { y, label: entry } of entries)
      text(page, entry.text, entry.x, y, { ...label, baseline: "middle" });
  }

  if (lang) page.write("EMC\n");
  page.write("EMC\n");
  return page;
}
