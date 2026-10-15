// Looks of series of connected marks (lines, areas): their color and paint
// from channels and `style.by`, each one value per series. A channel or
// map by a field reads the field's value over each series' rows, which
// must be one: lines and areas have no styles per row.

import type { Table } from "../../data/table.ts";
import type { Drawing, Geometry } from "../../scene/scene.ts";
import type { ChannelSpec, EncodingsSpec, SeriesStyle, StyleMapSpec } from "../../spec/encoding.ts";
import type { Dash } from "../../spec/spec.ts";
import type { Theme } from "../../theme.ts";
import type { Series } from "../series.ts";
import {
  type Channel,
  categoryField,
  colorCheck,
  colorShortForm,
  compileChannel,
  type ScaleOf,
} from "./channels.ts";

/** The paint a series takes from the features, over its mark's flat paint. */
export interface SeriesPaint {
  color?: string | undefined;
  stroke?: string | undefined;
  fill?: string | undefined;
  strokeWidth?: number | undefined;
  dash?: Dash | undefined;
  /** The series' opacity, its mark's included. */
  opacity: number;
  strokeOpacity?: number | undefined;
  fillOpacity?: number | undefined;
  style?: SeriesStyle | undefined;
}

/** The options of a line's or area's spec its looks come from. */
export interface SeriesStyleSpec {
  type: string;
  series?: string;
  color?: string;
  stroke?: string;
  fill?: string;
  dash?: Dash;
  strokeWidth?: number;
  opacity?: number;
  strokeOpacity?: number;
  encode?: EncodingsSpec;
  style?: { by?: StyleMapSpec };
}

const width = (value: unknown, path: string) => {
  if (typeof value !== "number" || !(value >= 0) || !Number.isFinite(value))
    throw new RangeError(`${path}: expected 0 or more pixels; received ${JSON.stringify(value)}`);
};
const fraction = (value: unknown, path: string) => {
  if (typeof value !== "number" || !(value >= 0 && value <= 1))
    throw new RangeError(
      `${path}: expected a number from 0 to 1; received ${JSON.stringify(value)}`,
    );
};
const dash = (value: unknown, path: string) => {
  if (typeof value === "string" ? !["-", "--", ":", "-."].includes(value) : !Array.isArray(value))
    throw new TypeError(
      `${path}: expected a pixel dash array or "-", "--", ":", "-."; received ${JSON.stringify(value)}`,
    );
};

/** A series' value of a channel: by its name, its rows, or its source. */
type Reader<V> = (s: Series | undefined, id: string) => V | undefined;

/**
 * The looks of a connected mark's series, compiled: `primary` is the paint
 * `color` sets (a line's stroke, an area's fill).
 */
export class SeriesStyles {
  readonly #spec: SeriesStyleSpec;
  readonly #table: Table;
  readonly #primary: "stroke" | "fill";
  readonly #color: Reader<string> | undefined;
  readonly #stroke: Reader<string> | undefined;
  readonly #fill: Reader<string> | undefined;
  readonly #dash: Reader<Dash> | undefined;
  readonly #width: Reader<number> | undefined;
  readonly #opacity: Reader<number> | undefined;
  readonly #by: Reader<SeriesStyle> | undefined;
  /** Whether a series' color needs its rows (a field other than the series field, or a condition). */
  readonly #byRows: boolean;
  #theme: Theme | undefined;
  /** Each series' paint, by its key, for the table's version and the theme it was found in. */
  #paints = new Map<
    string,
    { rows: Series["rows"]; length: number; paint: SeriesPaint; color: string }
  >();
  #paintsOf: { version: number; theme: Theme | undefined } | undefined;

  constructor(
    spec: SeriesStyleSpec,
    table: Table,
    scales: ScaleOf,
    primary: "stroke" | "fill",
    path: string,
    isColor: (value: string) => boolean,
  ) {
    this.#spec = spec;
    this.#table = table;
    this.#primary = primary;
    const encode = spec.encode ?? {};
    const both = (flat: keyof SeriesStyleSpec, channel: keyof EncodingsSpec) => {
      if (spec[flat] !== undefined && encode[channel] !== undefined)
        throw new Error(`${path} ${flat}: set as ${flat} and as encode.${channel}; give one`);
    };
    both("color", "color");
    both(primary, primary);
    both("dash", "dash");
    both("strokeWidth", "strokeWidth");
    both("opacity", "opacity");
    const color =
      encode.color ??
      (spec.color === undefined
        ? undefined
        : colorShortForm(spec.color, table, `${path} color`, isColor));
    let rows = false;
    const reader = <V>(
      channel: ChannelSpec<V> | undefined,
      check: (value: unknown, at: string) => void,
      name: string,
      defaults: () => readonly V[],
      fallback: () => V,
    ): Reader<V> | undefined => {
      if (!channel) return undefined;
      const at = `${path} ${name === "color" && !encode.color ? "color" : `encode.${name}`}`;
      const compiled = compileChannel(
        channel,
        table,
        scales,
        name === "color" || name === "fill" || name === "stroke" ? "color" : name,
        check,
        at,
      );
      // Only the series' own color waits for its rows (see `color`).
      const paint = name === "color" || name === primary;
      if (
        paint &&
        (compiled.kind === "condition" ||
          (compiled.kind === "field" && compiled.field !== spec.series))
      )
        rows = true;
      return this.#reader(compiled, at, defaults, fallback);
    };
    const palette = () => this.#theme?.palette ?? [];
    const muted = () => this.#theme?.muted ?? "#999999";
    const colorValue = colorCheck(isColor);
    this.#color = reader(color, colorValue, "color", palette, muted);
    this.#stroke = reader(encode.stroke, colorValue, "stroke", palette, muted);
    this.#fill = reader(encode.fill, colorValue, "fill", palette, muted);
    this.#dash = reader<Dash>(
      encode.dash,
      dash,
      "dash",
      () => [],
      () => "-",
    );
    this.#width = reader<number>(
      encode.strokeWidth,
      width,
      "strokeWidth",
      () => [],
      () => 2,
    );
    this.#opacity = reader<number>(
      encode.opacity,
      fraction,
      "opacity",
      () => [],
      () => 1,
    );
    const by = spec.style?.by;
    if (by) {
      const field =
        by.field === undefined
          ? undefined
          : categoryField(table, by.field, `${path} style.by.field`);
      this.#by = (s, id) => {
        const key =
          field === undefined || field === spec.series
            ? id
            : s && this.#constant(s, field, `${path} style.by.field`);
        return key === undefined || !Object.hasOwn(by.map, key) ? undefined : by.map[key];
      };
    }
    this.#byRows = rows;
  }

  /** Reads `theme`'s palette for values the scales do not map. */
  use(theme: Theme): void {
    this.#theme = theme;
  }

  /** A series' value of a compiled channel, one per series. */
  #reader<V>(
    channel: Channel<V>,
    path: string,
    defaults: () => readonly V[],
    fallback: () => V,
  ): Reader<V> {
    if (channel.kind === "value") return () => channel.value;
    if (channel.kind === "condition") {
      return (s) => {
        if (!s) return undefined;
        let value: V | undefined;
        this.#each(s, (row) => {
          const out = channel.when(row) ? channel.then : channel.otherwise;
          // Dashes are arrays: alike by their steps.
          if (value !== undefined && JSON.stringify(out) !== JSON.stringify(value))
            throw this.#varies(path, s);
          value = out;
        });
        return value;
      };
    }
    return (s, id) => {
      const value =
        channel.field === this.#spec.series ? id : s && this.#constant(s, channel.field, path);
      return value === undefined ? undefined : channel.scale.output(value, defaults(), fallback());
    };
  }

  #each(s: Series, visit: (row: number) => void): void {
    for (let k = 0; k < s.length; k++) visit(s.rows ? s.rows[k]! : k);
  }

  /** The value of category `field` over a series' rows, which must be one; undefined for none. */
  #constant(s: Series, field: string, path: string): string | undefined {
    const { codes, dictionary } = this.#table.categories(field as never);
    let code = -1;
    this.#each(s, (row) => {
      const at = codes[row]!;
      if (at < 0) return;
      if (code >= 0 && at !== code) throw this.#varies(path, s);
      code = at;
    });
    return code < 0 ? undefined : dictionary[code];
  }

  #varies(path: string, s: Series): Error {
    return new Error(
      `${path}: changes within series "${s.label}"; lines and areas take one value per series, so read the series field or give a value`,
    );
  }

  /**
   * The color the palette gives a series of source `id`: its style map's,
   * the mark's constant `given`, its channels', or the palette's (undefined).
   * Empty when its rows decide it (`attach` sets it).
   */
  color(id: string, given: string | undefined): string | undefined {
    if (this.#byRows) return "";
    return this.#by?.(undefined, id)?.[this.#primary] ?? given ?? this.#paintOf(undefined, id);
  }

  #paintOf(s: Series | undefined, id: string): string | undefined {
    return (
      (this.#primary === "stroke" ? this.#stroke : this.#fill)?.(s, id) ?? this.#color?.(s, id)
    );
  }

  /**
   * A series' paint, its color set on it where its rows decide it; read once
   * per data version and theme, since values within a series are checked.
   */
  paint(s: Series, id: string): SeriesPaint {
    const version = this.#table.version;
    const theme = this.#theme;
    if (this.#paintsOf?.version !== version || this.#paintsOf.theme !== theme) {
      this.#paints.clear();
      this.#paintsOf = { version, theme };
    }
    const kept = this.#paints.get(s.key);
    if (kept && kept.rows === s.rows && kept.length === s.length) {
      // The color the paint resolved, which the palette did not give.
      s.color = kept.color;
      return kept.paint;
    }
    const paint = this.#paintOfSeries(s, id);
    this.#paints.set(s.key, { rows: s.rows, length: s.length, paint, color: s.color });
    return paint;
  }

  #paintOfSeries(s: Series, id: string): SeriesPaint {
    const style = this.#by?.(s, id);
    // A color channel by rows gives every series its color; a style map by
    // another field, the series it maps (the others keep the palette's).
    if (this.#byRows)
      s.color =
        style?.[this.#primary] ?? this.#spec[this.#primary] ?? this.#paintOf(s, id) ?? s.color;
    else if (style?.[this.#primary] !== undefined) s.color = style[this.#primary]!;
    const spec = this.#spec;
    return {
      stroke: style?.stroke ?? (this.#primary === "stroke" ? undefined : this.#stroke?.(s, id)),
      strokeWidth: style?.strokeWidth ?? this.#width?.(s, id),
      dash: style?.dash ?? this.#dash?.(s, id),
      opacity: style?.opacity ?? this.#opacity?.(s, id) ?? spec.opacity ?? 1,
      strokeOpacity: style?.strokeOpacity ?? spec.strokeOpacity,
      fillOpacity: style?.fillOpacity,
      style,
    };
  }

  /** `draw` at `opacity`, as `faded` draws highlights: made once per drawing and opacity. */
  translucent<G extends Geometry>(geometry: G, opacity: number): G {
    if (opacity === 1) return geometry;
    return { ...geometry, draw: translucent(geometry.draw, opacity) };
  }
}

const translucents = new WeakMap<Drawing<Geometry>, Map<number, Drawing<Geometry>>>();

/** A drawing of the same geometry at `opacity`. */
function translucent(draw: Drawing<Geometry>, opacity: number): Drawing<Geometry> {
  let byOpacity = translucents.get(draw);
  if (!byOpacity) {
    byOpacity = new Map();
    translucents.set(draw, byOpacity);
  }
  let made = byOpacity.get(opacity);
  if (made) return made;
  const elements = draw.elements;
  made = {
    ...draw,
    opacity: (draw.opacity ?? 1) * opacity,
    svg: (geometry, context) => `<g opacity="${opacity}">${draw.svg(geometry, context)}</g>`,
    elements:
      elements &&
      ((geometry, context) =>
        elements(geometry, context)?.map(({ tag, attributes }) => ({
          tag,
          attributes: { ...attributes, opacity: String(opacity * Number(attributes.opacity ?? 1)) },
        }))),
    ...(!draw.guide && {
      canvas(context, geometry, options) {
        const alpha = context.globalAlpha;
        context.globalAlpha = alpha * opacity;
        draw.canvas(context, geometry, options);
        context.globalAlpha = alpha;
      },
    }),
  } as Drawing<Geometry>;
  byOpacity.set(opacity, made);
  return made;
}
