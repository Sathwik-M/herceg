// Looks of series of connected marks (lines, areas): their color and paint
// from channels and `style.by`, each one value per series. A channel or
// map by a field reads the field's value over each series' rows, which
// must be one: lines and areas have no styles per row. Each series' value
// is checked once, then as rows are appended only the new rows.

import type { Table } from "../../data/table.ts";
import type { FeatureKit } from "../../model/features.ts";
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
import type { Where } from "./compile.ts";

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
  /** The value of the field coloring the series, where it is not the series field. */
  value?: string | undefined;
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

/** A series' value of a channel: by its rows, its source, or its name. */
type Reader<V> = (s: Series | undefined, id: string, label?: string) => V | undefined;

/**
 * A series' one value of something its rows each have, as last checked:
 * the last row holding it (`evidence`), the last of the series' rows
 * (`seen`), and up to which row of the table (`last`; rows by identity,
 * `rowOffset + position`), in which generation, before which change of
 * existing values, and of the mark's row view, which rows count.
 */
interface Checked {
  value: string | undefined;
  evidence: number;
  seen: number;
  last: number;
  generation: number;
  modified: number;
  view: number | undefined;
}

/**
 * The looks of a connected mark's series, compiled: `primary` is the paint
 * `color` sets (a line's stroke, an area's fill).
 */
export class SeriesStyles {
  readonly #kit: FeatureKit;
  readonly #where: Where;
  readonly #spec: SeriesStyleSpec;
  readonly #table: Table;
  readonly #view: { readonly revision: number } | undefined;
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
  /**
   * The field the series' color is read from, where it is not the series
   * field, and the option naming it.
   */
  readonly #colorField: string | undefined;
  readonly #colorPath: string;
  /** The axis whose positions are bands, where rows without a band are no series' (see `#constant`). */
  readonly #bands: "x" | "y" | undefined;
  /** Each series' checked values, by series key and what they are of. */
  readonly #checked = new Map<string, Checked>();
  /** The series field's codes by value, for one table version (see `#codeOf`). */
  #codes: { version: number; dictionary: readonly string[]; of: Map<string, number> } | undefined;
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
    where: Where,
    kit: FeatureKit,
    view?: { readonly revision: number },
    bands?: "x" | "y",
  ) {
    const { isColor } = kit;
    const { path } = where;
    this.#kit = kit;
    this.#where = where;
    this.#spec = spec;
    this.#table = table;
    this.#view = view;
    this.#bands = bands;
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
    // A paint of the mark's own (a line's stroke, an area's fill) wins over its color.
    const own = spec[primary] !== undefined || encode[primary] !== undefined;
    const color = own
      ? undefined
      : (encode.color ??
        (spec.color === undefined
          ? undefined
          : colorShortForm(spec.color, table, `${path} color`, isColor)));
    let rows = false;
    let colorField: string | undefined;
    let colorPath = `${path} color`;
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
      if (paint && compiled.kind === "field" && compiled.field !== spec.series) {
        colorField = compiled.field;
        colorPath = at;
      }
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
            : s && this.#field(s, field, `${path} style.by.field`);
        return key === undefined || !Object.hasOwn(by.map, key) ? undefined : by.map[key];
      };
    }
    this.#byRows = rows;
    this.#colorField = colorField;
    this.#colorPath = colorPath;
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
    if (channel.kind === "series")
      return (s, id, label) =>
        channel.scale.output(label ?? s?.label ?? id, defaults(), fallback());
    if (channel.kind === "condition") {
      // Each row's outcome, as text: dashes are arrays, alike by their steps.
      const outcome = (row: number) =>
        JSON.stringify(channel.when(row) ? channel.then : channel.otherwise);
      return (s) => {
        const value = s && this.#constant(s, `${path}|condition`, outcome, path);
        return value === undefined ? undefined : (JSON.parse(value) as V);
      };
    }
    return (s, id) => {
      const value =
        channel.field === this.#spec.series ? id : s && this.#field(s, channel.field, path);
      return value === undefined ? undefined : channel.scale.output(value, defaults(), fallback());
    };
  }

  /** The value of category `field` over a series' rows, which must be one; undefined for none. */
  #field(s: Series, field: string, path: string): string | undefined {
    const { codes, dictionary } = this.#table.categories(field as never);
    return this.#constant(
      s,
      field,
      (row) => {
        const code = codes[row]!;
        return code < 0 ? undefined : dictionary[code];
      },
      path,
      field,
    );
  }

  /**
   * The one value `read` gives the rows of a series (cached as `of`):
   * found once, then as the table appends rows checked over its new rows
   * alone, while the rows checked before are unchanged and the last of them
   * holding the value is still there. Throws where a series has two.
   */
  #constant(
    s: Series,
    of: string,
    read: (row: number) => string | undefined,
    path: string,
    field?: string,
  ): string | undefined {
    const table = this.#table;
    const offset = table.rowOffset;
    const view = this.#view?.revision;
    const key = `${s.key}|${of}`;
    let checked = this.#checked.get(key);
    if (
      checked &&
      !(
        checked.generation === table.generation &&
        checked.modified === table.modifiedVersion &&
        checked.view === view &&
        held(checked, offset)
      )
    )
      checked = undefined;
    let { value, evidence, seen } = checked ?? { value: undefined, evidence: -1, seen: -1 };
    const check = (row: number) => {
      const id = offset + row;
      if (id > seen) seen = id;
      const at = read(row);
      if (at === undefined) return;
      if (value !== undefined && at !== value) {
        // A series found varying is checked whole again, so it recovers once its rows agree.
        this.#checked.delete(key);
        throw this.#varies(path, s, field);
      }
      value = at;
      if (id > evidence) evidence = id;
    };
    if (checked && !this.#view) {
      // Rows appended since: the table's last ones, of the series where they
      // are its field's value (whatever order the series draws them in).
      const { series } = this.#spec;
      const codes = series === undefined ? undefined : table.categories(series as never);
      const code = codes && this.#codeOf(codes.dictionary, (JSON.parse(s.key) as string[])[1]!);
      // Rows without a band are no series' (bandOrder leaves them out).
      const bands = this.#bands && (this.#bands === "x" ? s.x : s.y);
      for (let row = checked.last + 1 - offset; row < table.length; row++)
        if ((!codes || codes.codes[row] === code) && !(bands && !(bands[row]! >= 0))) check(row);
    } else for (let k = 0; k < s.length; k++) check(s.rows ? s.rows[k]! : k);
    // Every row of the table is checked now, or not the series'.
    const last = offset + table.length - 1;
    this.#checked.set(key, {
      value,
      evidence,
      seen,
      last,
      generation: table.generation,
      modified: table.modifiedVersion,
      view,
    });
    return value;
  }

  /** `value`'s code in `dictionary`, by an index made once per table version. */
  #codeOf(dictionary: readonly string[], value: string): number {
    const version = this.#table.version;
    if (this.#codes?.version !== version || this.#codes.dictionary !== dictionary)
      this.#codes = { version, dictionary, of: new Map(dictionary.map((v, i) => [v, i])) };
    return this.#codes.of.get(value) ?? -1;
  }

  #varies(path: string, s: Series, field: string | undefined): Error {
    const series = this.#spec.series;
    const what = field === undefined ? "its value" : `field "${field}"`;
    const area = this.#spec.type === "area";
    const within =
      series === undefined
        ? `the ${area ? "area" : "line"}`
        : `series "${s.label}" (by "${series}")`;
    const { index, mark } = this.#where;
    return new this.#kit.ChartError({
      code: "series-varies",
      path: `marks[${index}].${path.slice(this.#where.path.length + 1)}`,
      mark,
      message: `${path}: ${what} changes within ${within}; ${area ? "areas" : "lines"} take one color per series, so split them by ${series === undefined ? "a series field" : "another field"} or give a constant color`,
    });
  }

  /** The value of the field coloring a series, where it is not the series field. */
  #colorValue(s: Series): string | undefined {
    const field = this.#colorField;
    return field === undefined ? undefined : this.#field(s, field, this.#colorPath);
  }

  /**
   * The color the palette gives a series of source `id`, named `label`: its
   * style map's, the mark's constant `given`, its channels', or the
   * palette's (undefined). Empty when its rows decide it (`attach` sets it).
   */
  color(id: string, given: string | undefined, label?: string): string | undefined {
    if (this.#byRows) return "";
    return (
      this.#by?.(undefined, id)?.[this.#primary] ?? given ?? this.#paintOf(undefined, id, label)
    );
  }

  #paintOf(s: Series | undefined, id: string, label?: string): string | undefined {
    return (
      (this.#primary === "stroke" ? this.#stroke : this.#fill)?.(s, id, label) ??
      this.#color?.(s, id, label)
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
      // What was checked of rows the table no longer has goes, so series a
      // stream leaves behind are not kept; one that returns is checked afresh.
      const { generation, rowOffset } = this.#table;
      for (const [key, checked] of this.#checked)
        if (checked.generation !== generation || !held(checked, rowOffset))
          this.#checked.delete(key);
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
      value: this.#colorValue(s),
    };
  }

  /** `draw` at `opacity`, as `faded` draws highlights: made once per drawing and opacity. */
  translucent<G extends Geometry>(geometry: G, opacity: number): G {
    if (opacity === 1) return geometry;
    return { ...geometry, draw: translucent(geometry.draw, opacity) };
  }
}

/**
 * Whether the table still has the rows `checked` stands on: the last
 * holding its value, or for none, the series' last.
 */
function held(checked: Checked, rowOffset: number): boolean {
  return (checked.value === undefined ? checked.seen : checked.evidence) >= rowOffset;
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
