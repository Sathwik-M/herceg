// The feature compiler: draws what only charts asking for it need of their
// marks (see model/features.ts): channels beyond constants, categorical
// scales, styles by value, markers, and which observations lines connect.
// A live chart loads it before drawing such a configuration; static output
// imports it. It imports only types from the chart's modules and is handed
// what it uses of their code (`FeatureKit`).

import type { Table } from "../../data/table.ts";
import { symbolReach } from "../../draw/symbol-shapes.ts";
import { numberPattern, timePattern } from "../../format/patterns.ts";
import type {
  CategoryColors,
  CompiledFeatures,
  FeatureCompiler,
  FeatureKit,
  Identities,
  MarkFeatures,
  SeriesFeatures,
  SeriesSwatch,
} from "../../model/features.ts";
import type { ChartConfig } from "../../model/model.ts";
import type { AreaGeometry, Geometry, LineGeometry } from "../../scene/scene.ts";
import type { ChannelSpec, OrdinalScaleSpec, SymbolName } from "../../spec/encoding.ts";
import type { ChartErrorCode } from "../../spec/errors.ts";
import type { FormatSpec } from "../../spec/guides.ts";
import type { AreaSpec, BarSpec, LineSpec, PointSpec } from "../../spec/spec.ts";
import type { Theme } from "../../theme.ts";
import type { Mark, Palette } from "../mark.ts";
import type { Series } from "../series.ts";
import {
  checkOutputs,
  colorCheck,
  compileChannel,
  fieldsOf,
  type ScaleOf,
  scalePath,
} from "./channels.ts";
import { Topology } from "./continuity.ts";
import { type MarkScope, scalePrefix, scopeOfMark } from "./identity.ts";
import { MARKER_RADIUS, markerPath, markers } from "./markers.ts";
import { RowStyles } from "./row-styles.ts";
import { type CategoryScale, IdentityColors, OrdinalScale } from "./scales.ts";
import { SeriesStyles } from "./series-styles.ts";

/** The compiler, with the chart's code it uses. */
export function featureCompiler(kit: FeatureKit): FeatureCompiler {
  return {
    compile: (config, marks, previous, identities) =>
      compile(kit, config, marks, previous, identities),
  };
}

/** Marks whose short-form `color` is a field or a color (others' is a field). */
const PAINTED = [
  "line",
  "area",
  "bar",
  "histogram",
  "boxplot",
  "boxen",
  "violin",
  "errorbar",
  "rug",
];

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
  identities: Identities,
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
        `chart ${scalePath(name)}: expected type: "ordinal", a scale of categories; marks place values on x, y, and yRight`,
      );
    scaleOf(name, ordinal);
  }
  // The chart's palette slots of identity keys, which each scene hands over first.
  const chart: { slot: ((key: string) => number) | undefined } = { slot: undefined };
  const colors = new Map<string, IdentityColors>();
  const readIn =
    (table: Table | undefined, mark: Where): ScaleOf =>
    (name, path, field) => {
      const scale = scales.get(name);
      if (scale) return scale;
      // Without a declared "color", a field's values take the colors of what they stand for.
      if (name === "color" && field !== undefined && table) {
        const prefix = identities.field(table, field);
        let made = colors.get(prefix);
        if (!made) {
          made = new IdentityColors(prefix, chart);
          colors.set(prefix, made);
        }
        return made;
      }
      if (DEFAULT_SCALES.includes(name)) return scaleOf(name, undefined);
      const names = [...scales.keys()].map((n) => `"${n}"`).join(", ");
      throw new kit.ChartError({
        code: "unknown-reference",
        path: `marks[${mark.index}].${path.slice(mark.path.length + 1)}`,
        mark: mark.mark,
        message: `${path}: the chart has no scale "${name}"; add it to scales${names ? `, or name one of ${names}` : ""}`,
      });
    };
  const zone = config.timeZone ?? "local";
  const byMark = new Map<Mark, MarkFeatures & { use(theme: Theme): void }>();
  const declared = config.scales?.color !== undefined;
  // What series and rows stand for beyond the core's scopes, whose hidden keys stay.
  const prefixes = new Set<string>();
  marks.forEach((mark, at) => {
    // Named by its place among the chart's marks, layout marks included.
    const index = identities.positions[at]!;
    const spec = mark.spec as { type: string; id?: string; color?: unknown };
    const path = `${spec.type}${spec.id === undefined ? ` (mark ${index})` : ` "${spec.id}"`}`;
    const where: Where = { path, index, mark: spec.id ?? index };
    try {
      compileMark(mark, identities.scopes[at], spec, path, where);
    } catch (error) {
      throw placed(kit, error, where);
    }
  });
  function compileMark(
    mark: Mark,
    own: string | undefined,
    spec: { type: string; id?: string; color?: unknown },
    path: string,
    where: Where,
  ): void {
    // On marks whose `color` is a field or a color, a name both says neither
    // (their series would read it as a field), and one that is neither is a mistake.
    const short = PAINTED.includes(spec.type) ? spec.color : undefined;
    if (typeof short === "string" && kit.isColor(short) === !!mark.table?.has(short))
      throw new Error(
        kit.isColor(short)
          ? `${path} color: "${short}" names both a field and a color; give encode.color: { field: "${short}" } or { value: "${short}" }`
          : `${path} color: "${short}" is neither a field nor a color; ${mark.table ? `the table has ${fieldsOf(mark.table)}` : "the mark has no table"}, and colors are hex, rgb(), hsl(), var(), or CSS names`,
      );
    const by = (field: string) => identities.field(mark.table!, field);
    const scope = scopeOfMark(mark, own, by, declared);
    for (const prefix of [scope?.color, scope?.rows])
      if (prefix && prefix !== own) prefixes.add(prefix);
    const read = readIn(mark.table, where);
    // A color channel naming series stands for them whatever paints them
    // (scopeOfMark), so it is checked where a paint of the mark's own wins too.
    const color = (spec as { encode?: { color?: ChannelSpec<string> } }).encode?.color;
    if (color && "series" in color)
      compileChannel(
        color,
        mark.table,
        read,
        "color",
        colorCheck(kit.isColor),
        `${path} encode.color`,
      );
    // The declared scale series' colors follow, its places in their field's dictionary order.
    const scale =
      scope?.scale === undefined
        ? undefined
        : read(scope.scale, `${path} ${scope.option ?? "color"}`);
    if (scale) {
      checkOutputs(scale, colorCheck(kit.isColor), `${path} color`);
      // The scale reads the values that color the mark, not series it colors otherwise.
      if (scope!.field !== undefined) scale.read(mark.table!, scope!.field);
    }
    // Series of marks that need nothing else take the declared scale's colors.
    if (!mark.featured && !asks(mark)) {
      if (scale) byMark.set(mark, scaledFeatures(scale, scope!));
      return;
    }
    const log = positionsLog(config, mark);
    const at = { scope, path, read, scale, where };
    if (spec.type === "line") byMark.set(mark, lineFeatures(kit, mark, at, zone, log));
    else if (spec.type === "area") byMark.set(mark, areaFeatures(kit, mark, at, zone, log));
    else if (spec.type === "bar") byMark.set(mark, barFeatures(kit, mark, at, zone));
    else if (spec.type === "point" && !asks(mark)) byMark.set(mark, pointFeatures(kit, mark, at));
    else if (spec.type === "rule" || spec.type === "region" || spec.type === "text")
      byMark.set(mark, labelFeatures(kit, mark, zone, path));
    else
      throw new Error(
        `${path}: encode, style, markers, continuity, and where are not options of ${spec.type} marks`,
      );
  }
  // Layout marks' items follow a declared color scale too, reading their fields' values into it.
  let theme: Theme | undefined;
  const colorScale = declared ? (scales.get("color") ?? scaleOf("color", undefined)) : undefined;
  if (colorScale) prefixes.add(scalePrefix("color"));
  if (colorScale)
    for (const mark of config.marks as readonly Mark[]) {
      const identity = mark.identity as { field?: string; table?: Table } | undefined;
      if (!marks.includes(mark) && identity?.field !== undefined && mark.table)
        colorScale.read(identity.table ?? mark.table, identity.field);
    }
  const compiled: Compiled = {
    scales,
    scopes: prefixes,
    items: colorScale && {
      prefix: scalePrefix("color"),
      color: (value) => theme && colorScale.output(value, theme.palette, theme.muted),
    },
    of: (mark) => byMark.get(mark),
    update(t, slot) {
      theme = t;
      chart.slot = slot;
      for (const scale of scales.values()) scale.update();
      for (const features of byMark.values()) features.use(t);
    },
  };
  return compiled;
}

/**
 * `error`, thrown compiling the features of the mark `where` names, as a
 * ChartError at the option its message starts with: "line (mark 1)
 * encode.color.field: ..." at `marks[1].encode.color.field`, "chart
 * scales.color.map..." at `scales.color.map...`. Errors made with a `code`
 * keep it.
 */
function placed(kit: FeatureKit, error: unknown, where: Where): unknown {
  if (error instanceof kit.ChartError || !(error instanceof Error)) return error;
  const { message } = error;
  // The mark's name may hold colons (an id's), so the option is read after
  // it, up to a colon or " (read by " outside quoted keys (`map["a:b"]`).
  const at = (text: string) => text.match(/^(?:"(?:[^"\\]|\\.)*"|(?! \(read by )[^:"])*/)![0];
  const own = message.startsWith(`${where.path} `);
  const location = at(own ? message.slice(where.path.length + 1) : message);
  const path = own
    ? `marks[${where.index}].${location.replaceAll(" ", ".")}`
    : location.startsWith("chart ")
      ? location.slice(6)
      : `marks[${where.index}]`;
  const code = (error as { code?: ChartErrorCode }).code ?? "invalid-option";
  return new kit.ChartError({ code, path, mark: where.mark, message }, error);
}

/** Which mark features are compiled for: its name in messages, its index among the chart's marks, and its id or index. */
export interface Where {
  readonly path: string;
  readonly index: number;
  readonly mark: string | number;
}

/**
 * Where a mark's features are compiled: its scope, its name in messages,
 * its scales, and the declared scale its series' colors follow, if any.
 */
interface At {
  readonly scope: MarkScope | undefined;
  readonly path: string;
  readonly read: ScaleOf;
  readonly scale: CategoryScale | undefined;
  readonly where: Where;
}

/**
 * A palette giving series the colors of what they stand for: through the
 * scale their mark's scope declares (`scales.color`, or a scale a channel
 * names), where `color` (the mark's own) gives none, and naming the
 * identity of a series standing for a scale's value.
 */
function scaledPalette(
  base: Palette,
  scope: MarkScope | undefined,
  scale: CategoryScale | undefined,
  theme: () => Theme | undefined,
  color: (key: string, label: string | undefined, given: string | undefined) => string | undefined,
): Palette {
  return (key, label, given) => {
    const own = color(key, label, given);
    const t = theme();
    const name = label ?? sourceOf(key);
    return base(
      key,
      label,
      own ?? (scale && t ? scale.output(name, t.palette, t.muted) : own),
      // A series its rows color (by another field) stands for their value, which the
      // chart keeps from the last scene; others for their name through the scale.
      scope?.scale === undefined || own === ""
        ? undefined
        : `${scope.color}${JSON.stringify(name)}}`,
    );
  };
}

/** For a mark needing no other features: its series' colors through a declared scale. */
function scaledFeatures(
  scale: CategoryScale,
  scope: MarkScope,
): MarkFeatures & { use(theme: Theme): void } {
  let theme: Theme | undefined;
  return {
    use(t) {
      theme = t;
    },
    palette: (base) =>
      scaledPalette(
        base,
        scope,
        scale,
        () => theme,
        (_key, _label, given) => given,
      ),
    attach: (s) => identify(s, scope, undefined),
  };
}

/**
 * What a series stands for where its mark's scope says more than the
 * core's default: a declared scale's value (its name), or the value of the
 * field a line or area is colored by (`value`, its rows' one).
 */
function identify(s: Series, scope: MarkScope | undefined, value: string | undefined): void {
  if (!scope) return;
  // Series named through a scale stand for their names, whatever their rows' paint.
  if (value !== undefined && !scope.named) {
    s.entry = `${scope.color}${JSON.stringify(value)}}`;
    s.entryLabel = value;
  } else if (scope.scale !== undefined) s.entry = `${scope.color}${JSON.stringify(s.label)}}`;
  if (scope.named) s.partition = s.entry;
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
 * The axis a line's or area's positions lie in bands along: its orient's,
 * where its position field is a category.
 */
function bandAxis(mark: Mark): "x" | "y" | undefined {
  const orient = mark.tooltip === "y" ? "y" : "x";
  const field = (mark.spec as { x?: unknown; y?: unknown })[orient];
  const table = mark.table;
  return typeof field === "string" && table?.has(field) && table.kind(field) === "category"
    ? orient
    : undefined;
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

/** A mark's spec as its looks read it: its series field the one it splits rows by, inferred included. */
function resolved<T extends { series?: string | false }>(
  mark: Mark,
): Omit<T, "series"> & { series?: string } {
  const { series: _, ...spec } = mark.spec as unknown as T;
  const field = mark.identity?.field;
  return field === undefined ? spec : { ...spec, series: field };
}

/** Lines' looks by series, markers, and continuity. */
function lineFeatures(
  kit: FeatureKit,
  mark: Mark,
  { scope, path, read, scale, where }: At,
  zone: string,
  log: boolean,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as LineSpec;
  const table = mark.table!;
  const styles = new SeriesStyles(
    resolved<LineSpec>(mark),
    table,
    read,
    "stroke",
    where,
    kit,
    mark.view,
    bandAxis(mark),
  );
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
  let theme: Theme | undefined;
  return {
    use(t) {
      theme = t;
      styles.use(t);
    },
    palette: (base) =>
      scaledPalette(
        base,
        scope,
        scale,
        () => theme,
        (key, label, given) => styles.color(sourceOf(key), given, label),
      ),
    attach(s) {
      const paint = styles.paint(s, sourceOf(s.key));
      identify(s, scope, paint.value);
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
  { scope, path, read, scale }: At,
  zone: string,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as BarSpec;
  const styles = new RowStyles(resolved<BarSpec>(mark), mark.table!, read, path, kit.isColor);
  const format = formatOf(kit, zone);
  // A pattern refused is refused now, not when the first label is drawn.
  const labels = typeof spec.labels === "object" ? spec.labels : undefined;
  const pattern = labels?.format as { number?: string; time?: string } | undefined;
  if (pattern?.number !== undefined || pattern?.time !== undefined)
    format(labels!.format!, undefined, `${path} labels.format`);
  let theme: Theme | undefined;
  return {
    use(t) {
      theme = t;
      styles.use(t);
    },
    palette: (base) =>
      scaledPalette(
        base,
        scope,
        styles.byRow ? undefined : scale,
        () => theme,
        (key, label, given) => styles.color(sourceOf(key), given, label),
      ),
    attach(s) {
      identify(s, scope, undefined);
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
  { scope, path, read, scale, where }: At,
  zone: string,
  log: boolean,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as AreaSpec & { stack?: unknown };
  const table = mark.table!;
  const styles = new SeriesStyles(
    resolved<AreaSpec>(mark),
    table,
    read,
    "fill",
    where,
    kit,
    mark.view,
    bandAxis(mark),
  );
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
  let theme: Theme | undefined;
  return {
    use(t) {
      theme = t;
      styles.use(t);
    },
    palette: (base) =>
      scaledPalette(
        base,
        scope,
        scale,
        () => theme,
        (key, label, given) => styles.color(sourceOf(key), given, label),
      ),
    attach(s) {
      const paint = styles.paint(s, sourceOf(s.key));
      identify(s, scope, paint.value);
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
  { scope, path, read }: At,
): MarkFeatures & { use(theme: Theme): void } {
  const spec = mark.spec as PointSpec;
  const table = mark.table!;
  const field = spec.color as string;
  const scale = read("color", `${path} color`, field);
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
    // Colored by their series field, series take its values' colors; colored
    // by another, their rows do, and the series take none of the palette's.
    palette: (base) =>
      scaledPalette(
        base,
        scope,
        undefined,
        () => theme,
        (key, _label, given) =>
          given ??
          (field === mark.identity?.field
            ? scale.output(sourceOf(key), theme!.palette, theme!.muted)
            : theme!.muted),
      ),
    attach(s) {
      identify(s, scope, undefined);
      if (field !== mark.identity?.field) s.features = { categories: categories() };
    },
  };
}
