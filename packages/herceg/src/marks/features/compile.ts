// The feature compiler: draws what only charts asking for it need of their
// marks (see model/features.ts): channels beyond constants, categorical
// scales, styles by value, markers, and which observations lines connect.
// A live chart loads it before drawing such a configuration; static output
// imports it. It imports only types from the chart's modules and is handed
// what it uses of their code (`FeatureKit`).

import { symbolReach } from "../../draw/symbol-shapes.ts";
import { numberPattern, timePattern } from "../../format/patterns.ts";
import type {
  CategoryColors,
  CompiledFeatures,
  FeatureCompiler,
  FeatureKit,
  MarkFeatures,
  SeriesFeatures,
  SeriesSwatch,
} from "../../model/features.ts";
import type { ChartConfig } from "../../model/model.ts";
import type { AreaGeometry, Geometry, LineGeometry } from "../../scene/scene.ts";
import type { OrdinalScaleSpec, SymbolName } from "../../spec/encoding.ts";
import type { FormatSpec } from "../../spec/guides.ts";
import type { AreaSpec, BarSpec, LineSpec, PointSpec } from "../../spec/spec.ts";
import type { Theme } from "../../theme.ts";
import type { Mark } from "../mark.ts";
import { colorCheck, type ScaleOf } from "./channels.ts";
import { Topology } from "./continuity.ts";
import { MARKER_RADIUS, markerPath, markers } from "./markers.ts";
import { RowStyles } from "./row-styles.ts";
import { OrdinalScale } from "./scales.ts";
import { SeriesStyles } from "./series-styles.ts";

/** The compiler, with the chart's code it uses. */
export function featureCompiler(kit: FeatureKit): FeatureCompiler {
  return { compile: (config, marks, previous) => compile(kit, config, marks, previous) };
}

/** Scales channels read without naming one. */
const DEFAULT_SCALES = ["color", "symbol", "dash"];
const POSITIONS = ["x", "y", "yRight"];

interface Compiled extends CompiledFeatures {
  readonly scales: ReadonlyMap<string, OrdinalScale>;
}

function compile(
  kit: FeatureKit,
  config: ChartConfig,
  marks: readonly Mark[],
  previous: CompiledFeatures | undefined,
): CompiledFeatures {
  // Scales keep their values' places across updates that keep their settings.
  const kept = (previous as Compiled | undefined)?.scales;
  const scales = new Map<string, OrdinalScale>();
  const scaleOf = (name: string, spec: OrdinalScaleSpec | undefined) => {
    const old = kept?.get(name);
    const same = old && JSON.stringify(old.spec) === JSON.stringify(spec);
    const scale = new OrdinalScale(name, spec, same ? old : undefined);
    scales.set(name, scale);
    return scale;
  };
  for (const [name, spec] of Object.entries(config.scales ?? {})) {
    if (POSITIONS.includes(name) || spec === undefined) continue;
    const ordinal = spec as OrdinalScaleSpec;
    if (ordinal.type !== "ordinal")
      throw new Error(
        `chart scales.${name}: expected type: "ordinal", a scale of categories; marks place values on x, y, and yRight`,
      );
    scaleOf(name, ordinal);
  }
  const read: ScaleOf = (name, path) => {
    const scale = scales.get(name);
    if (scale) return scale;
    if (DEFAULT_SCALES.includes(name)) return scaleOf(name, undefined);
    const names = [...scales.keys()].map((n) => `"${n}"`).join(", ");
    throw new Error(
      `${path}: the chart has no scale "${name}"; add it to scales${names ? `, or name one of ${names}` : ""}`,
    );
  };
  const zone = config.timeZone ?? "local";
  const byMark = new Map<Mark, MarkFeatures & { use(theme: Theme): void }>();
  marks.forEach((mark, index) => {
    if (!mark.featured && !asks(mark)) return;
    const spec = mark.spec as { type: string; id?: string };
    const path = `${spec.type}${spec.id === undefined ? ` (mark ${index})` : ` "${spec.id}"`}`;
    const log = positionsLog(config, mark);
    if (spec.type === "line") byMark.set(mark, lineFeatures(kit, mark, read, zone, log, path));
    else if (spec.type === "area") byMark.set(mark, areaFeatures(kit, mark, read, zone, log, path));
    else if (spec.type === "bar") byMark.set(mark, barFeatures(kit, mark, read, zone, path));
    else if (spec.type === "point" && !asks(mark))
      byMark.set(mark, pointFeatures(kit, mark, read, path));
    else if (spec.type === "rule" || spec.type === "region" || spec.type === "text")
      byMark.set(mark, labelFeatures(kit, mark, zone, path));
    else
      throw new Error(
        `${path}: encode, style, markers, continuity, and where are not options of ${spec.type} marks`,
      );
  });
  const compiled: Compiled = {
    scales,
    of: (mark) => byMark.get(mark),
    update(theme) {
      for (const scale of scales.values()) scale.update();
      for (const features of byMark.values()) features.use(theme);
    },
  };
  return compiled;
}

/** Whether a mark asks for options only the feature compiler draws. */
function asks(mark: Mark): boolean {
  const spec = mark.spec as unknown as Record<string, unknown>;
  return ["encode", "style", "markers", "continuity", "where"].some(
    (key) => spec[key] !== undefined,
  );
}

/** A series' source, from its key (see `seriesKey`): a y field, or a series field's value. */
function sourceOf(key: string): string {
  return String((JSON.parse(key) as unknown[])[1]);
}

/**
 * Whether a line's or area's positions lie on a log scale, as the chart's
 * settings say (each panel's axis it draws in, the scale's settings, the
 * short form; log scales are never inferred): where every panel it draws
 * in has one, since its runs are measured once for all of them.
 */
function positionsLog(config: ChartConfig, mark: Mark): boolean {
  const spec = mark.spec as { panel?: string; axis?: string };
  const name = mark.tooltip !== "y" ? "x" : spec.axis === "right" ? "yRight" : "y";
  const chart = config.scales?.[name]?.type ?? config[name]?.type;
  const list = config.panels?.list ?? [];
  const drawn = spec.panel === "*" ? list : list.filter((p) => p.id === spec.panel);
  const types = drawn.length > 0 ? drawn.map((p) => p[name]?.type ?? chart) : [chart];
  return types.every((type) => type === "log");
}

/** Lines' looks by series, markers, and continuity. */
function lineFeatures(
  kit: FeatureKit,
  mark: Mark,
  scales: ScaleOf,
  zone: string,
  log: boolean,
  path: string,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as LineSpec;
  const table = mark.table!;
  const styles = new SeriesStyles(spec, table, scales, "stroke", path, kit.isColor);
  const along = mark.tooltip as "x" | "y";
  const topology =
    spec.continuity || spec.where !== undefined
      ? new Topology(kit, table, spec, { field: spec[along], log }, zone, path)
      : undefined;
  topology?.check(
    mark.channelKind(along) ?? "number",
    typeof spec.continuity?.maxGap === "object",
    path,
  );
  const symbol: SymbolName = typeof spec.markers === "string" ? spec.markers : "circle";
  const mapped = Object.values(spec.style?.by?.map ?? {}).some((style) => style.marker);
  const marked = spec.markers !== false && (spec.markers !== undefined || mapped);
  return {
    use: (theme) => styles.use(theme),
    palette: (base) => (key, label, given) => base(key, label, styles.color(sourceOf(key), given)),
    attach(s) {
      const paint = styles.paint(s, sourceOf(s.key));
      // Markers where the mark asks for them, or the series' style gives them.
      const marker =
        marked && (spec.markers || paint.style?.marker)
          ? { ...spec.style?.marker, ...paint.style?.marker }
          : undefined;
      // The observations the last trace kept, which markers stand at.
      let kept: Float32Array = new Float32Array(0);
      let count = 0;
      const features: SeriesFeatures = {
        swatch(theme) {
          const strokeWidth = paint.strokeWidth ?? spec.strokeWidth ?? theme.style.line.strokeWidth;
          const dash = paint.dash ?? spec.dash;
          const stroke: SeriesSwatch = {
            type: "line",
            stroke: s.color,
            strokeWidth,
            ...(dash !== undefined && { dash }),
            opacity: paint.opacity * (paint.strokeOpacity ?? 1),
          };
          if (!marker) return stroke;
          // The marker as markers draw it: its symbol, outlined where they are.
          const glyph = marker.symbol ?? symbol;
          const r = marker.radius ?? MARKER_RADIUS;
          const outlined = marker.stroke !== undefined || marker.strokeWidth !== undefined;
          const dot: SeriesSwatch = {
            type: "glyph",
            d: markerPath(kit, glyph, 0, 0, r),
            size: 2 * r * symbolReach(glyph),
            fill: marker.fill ?? s.color,
            opacity: paint.opacity * (marker.opacity ?? 1),
            ...(outlined && { stroke: marker.stroke ?? s.color }),
          };
          return { type: "composite", parts: [stroke, dot] };
        },
        geometry(geometry, series) {
          const line = geometry as LineGeometry;
          if (paint.strokeWidth !== undefined || paint.dash !== undefined) {
            line.strokeWidth = paint.strokeWidth ?? line.strokeWidth;
            line.dash = kit.dashPattern(paint.dash ?? spec.dash, line.strokeWidth);
          }
          const out: Geometry[] = [
            styles.translucent(line, paint.opacity * (paint.strokeOpacity ?? 1)),
          ];
          if (marker && count > 0)
            out.push(
              markers(kit, series.key, kept, count, marker, symbol, series.color, paint.opacity),
            );
          count = 0;
          return out;
        },
      };
      if (marker || topology)
        features.trace = (series, y, frame, stage, out, start, end, reduce) => {
          let step = reduce;
          if (marker && stage === "line") {
            // Crossings `where` meets are not observations: they get no markers.
            kept = frame.floats(series.key, "markers", 64);
            count = 0;
            step = (a, b) => {
              const from = out.count;
              reduce(a, b);
              const length = (count + out.count - from) * 2;
              if (length > kept.length) {
                const grown = frame.floats(series.key, "markers", length);
                grown.set(kept.subarray(0, count * 2));
                kept = grown;
              }
              kept.set(out.coords.subarray(from * 2, out.count * 2), count * 2);
              // Lines along y are traced with x and y swapped, and swapped back after.
              if (along === "y")
                for (let i = count * 2; i < length; i += 2)
                  [kept[i], kept[i + 1]] = [kept[i + 1]!, kept[i]!];
              count = length / 2;
            };
          }
          if (topology) topology.trace(series, y, frame, out, start, end, step);
          else step(start, end);
        };
      if (topology) {
        features.extent = (...args) => topology.extent(...args);
        features.across = (...args) => topology.across(...args);
        features.drawn = (row) => topology.drawn(row);
        features.shown = (series) => topology.shown(series);
      }
      s.features = features;
    },
  };
}

/** How marks write values in a pattern format (`{ number }`, `{ time }`). */
function formatOf(
  kit: FeatureKit,
  zone: string,
): (format: FormatSpec, locale: string | undefined, path: string) => (value: number) => string {
  return (format, locale, path) => {
    const pattern = format as { number?: string; time?: string };
    return pattern.time !== undefined
      ? timePattern(kit, pattern.time, zone, locale, `${path}.time`)
      : numberPattern(kit, pattern.number!, locale, `${path}.number`);
  };
}

/** Bars' looks by series and by row, and their labels' pattern formats. */
function barFeatures(
  kit: FeatureKit,
  mark: Mark,
  scales: ScaleOf,
  zone: string,
  path: string,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as BarSpec;
  const styles = new RowStyles(spec, mark.table!, scales, path, kit.isColor);
  const format = formatOf(kit, zone);
  // A pattern refused is refused now, not when the first label is drawn.
  const labels = typeof spec.labels === "object" ? spec.labels : undefined;
  const pattern = labels?.format as { number?: string; time?: string } | undefined;
  if (pattern?.number !== undefined || pattern?.time !== undefined)
    format(labels!.format!, undefined, `${path} labels.format`);
  return {
    use: (theme) => styles.use(theme),
    palette: (base) => (key, label, given) => base(key, label, styles.color(sourceOf(key), given)),
    attach(s) {
      const rows = styles.rows(s, sourceOf(s.key));
      if (!rows) return;
      // A series of bars of one look shows it in legends that draw marks' looks.
      const look = rows.paints.length === 1 ? rows.paints[0] : undefined;
      s.features = {
        rows,
        key: () => styles.key(),
        swatch: look
          ? () => ({
              type: "rect",
              fill: look.fill ?? s.color,
              ...((look.stroke ?? spec.stroke) !== undefined && {
                stroke: look.stroke ?? spec.stroke,
              }),
              fillOpacity: look.fillOpacity ?? spec.fillOpacity ?? 1,
              opacity: look.opacity ?? spec.opacity ?? 1,
            })
          : undefined,
      };
    },
    format,
  };
}

/** Annotations' labels in pattern formats. */
function labelFeatures(
  kit: FeatureKit,
  mark: Mark,
  zone: string,
  path: string,
): MarkFeatures & { use(theme: Theme): void } {
  const format = formatOf(kit, zone);
  const label = (mark.spec as { label?: unknown }).label;
  const pattern = typeof label === "object" ? (label as { format?: FormatSpec }).format : undefined;
  // A pattern refused is refused now, not when the first label is drawn; Intl options are the chart's.
  const { number, time } = (pattern ?? {}) as { number?: string; time?: string };
  if (number !== undefined || time !== undefined)
    format(pattern!, undefined, `${path} label.format`);
  return { use() {}, palette: (base) => base, attach() {}, format };
}

/** Areas' looks by series, and continuity for areas that do not stack. */
function areaFeatures(
  kit: FeatureKit,
  mark: Mark,
  scales: ScaleOf,
  zone: string,
  log: boolean,
  path: string,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as AreaSpec & { stack?: unknown };
  const table = mark.table!;
  const styles = new SeriesStyles(spec, table, scales, "fill", path, kit.isColor);
  const asks = spec.continuity || spec.where !== undefined;
  if (
    spec.continuity &&
    spec.curve === "monotone" &&
    (spec.y1 !== undefined || spec.x1 !== undefined)
  )
    throw new Error(
      `${path} continuity: monotone bands cannot break yet; give a linear or step curve`,
    );
  if (asks && spec.stack)
    throw new Error(
      `${path} ${spec.where !== undefined ? "where" : "continuity"}: stacked areas cannot leave rows out yet; drop it or the stack`,
    );
  const along = mark.tooltip as "x" | "y";
  const topology = asks
    ? new Topology(kit, table, spec, { field: spec[along], log }, zone, path)
    : undefined;
  topology?.check(
    mark.channelKind(along) ?? "number",
    typeof spec.continuity?.maxGap === "object",
    path,
  );
  return {
    use: (theme) => styles.use(theme),
    palette: (base) => (key, label, given) => base(key, label, styles.color(sourceOf(key), given)),
    attach(s) {
      const paint = styles.paint(s, sourceOf(s.key));
      const banded = spec.y1 !== undefined || spec.x1 !== undefined;
      const features: SeriesFeatures = {
        // As areas fill by default (see the guide compiler's samples): stacks nearly opaque.
        swatch: () => ({
          type: "rect",
          fill: s.color,
          opacity:
            (paint.fillOpacity ?? spec.fillOpacity ?? (spec.stack ? 0.85 : banded ? 0.2 : 0.25)) *
            paint.opacity,
        }),
        geometry(geometry) {
          const area = geometry as AreaGeometry;
          if (paint.stroke !== undefined) area.stroke = paint.stroke;
          if (paint.strokeWidth !== undefined) area.strokeWidth = paint.strokeWidth;
          if (paint.fillOpacity !== undefined) area.fillOpacity = paint.fillOpacity;
          // Opacity is the fill's and the outline's: canvases draw areas at their own alphas.
          area.fillOpacity *= paint.opacity;
          if (paint.opacity !== 1 || paint.strokeOpacity !== undefined)
            area.strokeOpacity = (paint.strokeOpacity ?? 1) * paint.opacity;
          return [area];
        },
      };
      if (topology) {
        features.trace = (series, y, frame, _stage, out, start, end, reduce) =>
          topology.trace(series, y, frame, out, start, end, reduce);
        features.band = (series, top, bottom, frame, upper, lower, start, end, reduce) =>
          topology.band(series, top, bottom, frame, upper, lower, start, end, reduce);
        features.extent = (...args) => topology.extent(...args);
        features.across = (...args) => topology.across(...args);
        features.drawn = (row) => topology.drawn(row);
        features.shown = (series) => topology.shown(series);
      }
      s.features = features;
    },
  };
}

/** Points colored by a category field, through the chart's color scale. */
function pointFeatures(
  kit: FeatureKit,
  mark: Mark,
  scales: ScaleOf,
  path: string,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as PointSpec;
  const table = mark.table!;
  const field = spec.color as string;
  const scale = scales("color", `${path} color`);
  const color = colorCheck(kit.isColor);
  for (const [value, output] of Object.entries(scale.spec?.map ?? {}))
    color(output, `chart scales.color.map[${JSON.stringify(value)}] (read by ${path} color)`);
  if (scale.spec?.unknown !== undefined)
    color(scale.spec.unknown, `chart scales.color.unknown (read by ${path} color)`);
  scale.read(table, field);
  let theme: Theme | undefined;
  let last: { version: number; theme: Theme; categories: CategoryColors } | undefined;
  // Each value's color slot, kept while the data streams: values never change colors.
  let slots: { theme: Theme; colors: string[]; tone: Map<string, number>; of: Map<string, number> };
  const categories = (): CategoryColors => {
    if (last?.version === table.version && last.theme === theme) return last.categories;
    if (slots?.theme !== theme)
      slots = { theme: theme!, colors: [], tone: new Map(), of: new Map() };
    const { colors, tone, of } = slots;
    const { codes, dictionary } = table.categories(field as never);
    const held = new Uint8Array(dictionary.length);
    for (let i = 0; i < codes.length; i++) if (codes[i]! >= 0) held[codes[i]!] = 1;
    const tones = new Int32Array(dictionary.length).fill(-1);
    const order: number[] = [];
    // Points index their colors by bytes: the palette's first 254 cycle, and
    // one stays for the muted color.
    const palette = theme!.palette.slice(0, 254);
    const muted = theme!.muted;
    for (let code = 0; code < dictionary.length; code++) {
      if (!held[code]) continue;
      order.push(code);
      const value = dictionary[code]!;
      let slot = of.get(value);
      if (slot === undefined) {
        // Values outside an explicit domain take `unknown`, or the muted color, as other marks
        // do; past 254 colors of their own, the muted color too.
        let color = scale.output(value, palette, muted);
        if (!tone.has(color) && colors.length >= 254) color = muted;
        if (!tone.has(color)) tone.set(color, colors.push(color) - 1);
        slot = tone.get(color)!;
        of.set(value, slot);
      }
      tones[code] = slot;
    }
    const placeOf = (code: number) => scale.place(dictionary[code]!) ?? Infinity;
    order.sort((a, b) => placeOf(a) - placeOf(b));
    last = {
      version: table.version,
      theme: theme!,
      categories: { field, dictionary, codes, tones, colors, order },
    };
    return last.categories;
  };
  return {
    use(t) {
      theme = t;
    },
    // Colored by their series field, series take its values' colors.
    palette: (base) =>
      field === spec.series
        ? (key, label, given) =>
            base(key, label, given ?? scale.output(sourceOf(key), theme!.palette, theme!.muted))
        : base,
    attach(s) {
      if (field !== spec.series) s.features = { categories: categories() };
    },
  };
}
