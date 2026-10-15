// Looks of marks whose rows each draw something (bars): channels and
// `style.by` per row. A row's look is found from small integers (a field's
// dictionary code, a condition's truth), never an object per row: rows
// with the same channel values share one look, and a series draws a
// geometry per look its rows take.

import type { Table } from "../../data/table.ts";
import type { RowPaint } from "../../model/features.ts";
import type { EncodingsSpec, SeriesStyle, StyleMapSpec } from "../../spec/encoding.ts";
import type { Theme } from "../../theme.ts";
import type { GlyphKey } from "../mark.ts";
import type { Series } from "../series.ts";
import {
  type Channel,
  categoryField,
  colorCheck,
  colorShortForm,
  compileChannel,
  type ScaleOf,
} from "./channels.ts";

/** The options of a mark's spec its rows' looks come from. */
export interface RowStyleSpec {
  series?: string;
  color?: string;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
  encode?: EncodingsSpec;
  style?: { by?: StyleMapSpec };
}

/** A part of a row's look: how many values it takes, and each row's. */
interface Part {
  count: number;
  /** A row's value, from 0 to `count` - 1. */
  at(row: number): number;
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

/** The looks of a mark's rows, compiled. */
export class RowStyles {
  readonly #table: Table;
  readonly #spec: RowStyleSpec;
  readonly #fill: Channel<string> | undefined;
  readonly #stroke: Channel<string> | undefined;
  readonly #width: Channel<number> | undefined;
  readonly #opacity: Channel<number> | undefined;
  readonly #by: { field: string; map: StyleMapSpec["map"] } | undefined;
  /** Whether rows have looks of their own; otherwise looks are by series, through the palette. */
  readonly byRow: boolean;
  #theme: Theme | undefined;
  /** Each series' looks, by its key, for the rows' looks they were found from. */
  readonly #rows = new Map<
    string,
    {
      looks: object;
      rows: Series["rows"];
      length: number;
      parts: { paints: readonly RowPaint[]; of(row: number): number };
    }
  >();
  #key: { version: number; theme: Theme | undefined; key: GlyphKey | undefined } | undefined;
  #looks:
    | { version: number; theme: Theme | undefined; of: Int32Array; paints: RowPaint[] }
    | undefined;

  constructor(
    spec: RowStyleSpec,
    table: Table,
    scales: ScaleOf,
    path: string,
    isColor: (value: string) => boolean,
  ) {
    this.#table = table;
    this.#spec = spec;
    const encode = spec.encode ?? {};
    const both = (flat: keyof RowStyleSpec, channel: keyof EncodingsSpec) => {
      if (spec[flat] !== undefined && encode[channel] !== undefined)
        throw new Error(`${path} ${flat}: set as ${flat} and as encode.${channel}; give one`);
    };
    both("color", "color");
    both("fill", "fill");
    both("stroke", "stroke");
    both("strokeWidth", "strokeWidth");
    both("opacity", "opacity");
    const color =
      encode.color ??
      (spec.color === undefined
        ? undefined
        : colorShortForm(spec.color, table, `${path} color`, isColor));
    const at = (name: string) =>
      `${path} ${name === "color" && !encode.color ? "color" : `encode.${name}`}`;
    const colorValue = colorCheck(isColor);
    // A fill set flat wins over the color channel.
    const fill = spec.fill === undefined ? (encode.fill ?? color) : undefined;
    this.#fill =
      fill &&
      compileChannel(fill, table, scales, "color", colorValue, at(encode.fill ? "fill" : "color"));
    this.#stroke =
      encode.stroke &&
      compileChannel(encode.stroke, table, scales, "color", colorValue, at("stroke"));
    this.#width =
      encode.strokeWidth &&
      compileChannel(encode.strokeWidth, table, scales, "strokeWidth", width, at("strokeWidth"));
    this.#opacity =
      encode.opacity &&
      compileChannel(encode.opacity, table, scales, "opacity", fraction, at("opacity"));
    const by = spec.style?.by;
    if (by?.field !== undefined && by.field !== spec.series)
      this.#by = { field: categoryField(table, by.field, `${path} style.by.field`), map: by.map };
    const rowWise = (c: Channel<unknown> | undefined) =>
      c !== undefined &&
      (c.kind === "condition" || (c.kind === "field" && c.field !== spec.series));
    this.byRow =
      [this.#fill, this.#stroke, this.#width, this.#opacity].some(rowWise) ||
      this.#by !== undefined;
  }

  use(theme: Theme): void {
    this.#theme = theme;
  }

  /**
   * The color the palette gives a series of `name`: its style map's, its
   * channel's, the theme's muted color where rows have colors of their own
   * (as legends list the series), or the palette's (undefined).
   */
  color(name: string, given: string | undefined): string | undefined {
    const by = this.#spec.style?.by;
    const mapped =
      by && (by.field === undefined || by.field === this.#spec.series)
        ? own(by.map, name)?.fill
        : undefined;
    if (mapped !== undefined) return mapped;
    if (given !== undefined) return given;
    const fill = this.#fill;
    if (fill?.kind === "value") return fill.value;
    if (fill?.kind === "field" && fill.field === this.#spec.series)
      return fill.scale.output(name, this.#theme?.palette ?? [], this.#theme?.muted ?? "#999999");
    if (fill) return this.#theme?.muted;
    return undefined;
  }

  /**
   * A key of the colors a field other than the series field gives rows: the
   * values rows hold, in the scale's order, for the table's version.
   */
  key(): GlyphKey | undefined {
    const fill = this.#fill;
    if (fill?.kind !== "field" || fill.field === this.#spec.series) return undefined;
    const table = this.#table;
    const theme = this.#theme;
    if (this.#key?.version === table.version && this.#key.theme === theme) return this.#key.key;
    const { codes, dictionary } = table.categories(fill.field as never);
    const held = new Uint8Array(dictionary.length);
    for (let row = 0; row < codes.length; row++) if (codes[row]! >= 0) held[codes[row]!] = 1;
    const values = dictionary.filter((_, code) => held[code]);
    const place = (value: string) => fill.scale.place(value) ?? Infinity;
    values.sort((a, b) => place(a) - place(b));
    const palette = theme?.palette ?? [];
    const muted = theme?.muted ?? "#999999";
    const key: GlyphKey | undefined = values.length
      ? {
          title: fill.field,
          channel: "color",
          entries: values.map((label) => ({
            label,
            glyph: "M-4.5 -4.5h9v9h-9Z",
            r: 4.5,
            color: fill.scale.output(label, palette, muted),
          })),
        }
      : undefined;
    this.#key = { version: table.version, theme, key };
    return key;
  }

  /** A series' look by its name (`style.by` without a field), over the mark's. */
  seriesStyle(name: string): SeriesStyle | undefined {
    const by = this.#spec.style?.by;
    return by && (by.field === undefined || by.field === this.#spec.series)
      ? own(by.map, name)
      : undefined;
  }

  /**
   * A series' look where its rows have none of their own: its channels'
   * constants and outputs for the series' value, under its style map's.
   */
  #seriesPaint(name: string): RowPaint | undefined {
    const theme = this.#theme;
    const value = <V>(channel: Channel<V> | undefined, defaults: readonly V[], fallback: V) =>
      channel?.kind === "value"
        ? channel.value
        : channel?.kind === "field"
          ? channel.scale.output(name, defaults, fallback)
          : undefined;
    const paint: RowPaint = {
      stroke: value(this.#stroke, theme?.palette ?? [], theme?.muted ?? "#999999"),
      strokeWidth: value(this.#width, [], 1),
      opacity: value(this.#opacity, [], 1),
    };
    const style = this.seriesStyle(name);
    const merged = style ? { ...paint, ...definedOf(style) } : paint;
    return Object.values(merged).some((v) => v !== undefined) ? merged : undefined;
  }

  /** The looks a series' rows take, and which each takes. */
  rows(
    s: Series,
    name: string,
  ): { paints: readonly RowPaint[]; of(row: number): number } | undefined {
    const looks = this.#read();
    if (!looks) {
      const paint = this.#seriesPaint(name);
      return paint ? { paints: [paint], of: () => 0 } : undefined;
    }
    // Kept per series while the data and theme are the same.
    const kept = this.#rows.get(s.key);
    if (kept && kept.looks === looks && kept.rows === s.rows && kept.length === s.length)
      return kept.parts;
    // A series draws the looks its rows take, in the order they first take
    // them; its own style over theirs may make some alike, which share one.
    const parts = new Map<number, number>();
    const alike = new Map<string, number>();
    const paints: RowPaint[] = [];
    const series = this.seriesStyle(name);
    for (let k = 0; k < s.length; k++) {
      const look = looks.of[s.rows ? s.rows[k]! : k]!;
      if (parts.has(look)) continue;
      const paint = series ? { ...looks.paints[look]!, ...definedOf(series) } : looks.paints[look]!;
      const content = JSON.stringify(paint);
      let part = alike.get(content);
      if (part === undefined) {
        part = paints.push(paint) - 1;
        alike.set(content, part);
      }
      parts.set(look, part);
    }
    const out = { paints, of: (row: number) => parts.get(looks.of[row]!) ?? 0 };
    this.#rows.set(s.key, { looks, rows: s.rows, length: s.length, parts: out });
    return out;
  }

  /** Each row's look, for the table's version: an index into `paints`. */
  #read(): { of: Int32Array; paints: RowPaint[] } | undefined {
    if (!this.byRow) return undefined;
    const table = this.#table;
    const theme = this.#theme;
    if (this.#looks?.version === table.version && this.#looks.theme === theme) return this.#looks;
    const palette = theme?.palette ?? [];
    const muted = theme?.muted ?? "#999999";
    const channels = [
      this.#part(this.#fill, palette, muted),
      this.#part(this.#stroke, palette, muted),
      this.#part(this.#width, [], 1),
      this.#part(this.#opacity, [], 1),
    ];
    const by = this.#by;
    const byPart = by && this.#codes(by.field);
    const parts: Part[] = [...channels.map((c) => c.part), ...(byPart ? [byPart] : [])];
    // Rows' looks numbered by their parts' values, in the order rows take them;
    // values that give the same paint share one look.
    const of = new Int32Array(table.length);
    const numbers = new Map<number, number>();
    const interned = new Map<string, number>();
    const paints: RowPaint[] = [];
    this.#rows.clear();
    // Past exact integers, ids are their parts' values written out.
    const exact = parts.reduce((size, part) => size * part.count, 1) <= Number.MAX_SAFE_INTEGER;
    const ids = new Map<string, number>();
    for (let row = 0; row < of.length; row++) {
      let id = 0;
      if (exact) for (const part of parts) id = id * part.count + part.at(row);
      else id = ids.get(parts.map((part) => part.at(row)).join()) ?? ids.size;
      if (!exact) ids.set(parts.map((part) => part.at(row)).join(), id);
      let look = numbers.get(id);
      if (look === undefined) {
        const [fill, stroke, strokeWidth, opacity] = channels.map((c) => c.output(row));
        let paint: RowPaint = {
          fill: fill as string | undefined,
          stroke: stroke as string | undefined,
          strokeWidth: strokeWidth as number | undefined,
          opacity: opacity as number | undefined,
        };
        if (by && byPart) {
          const code = this.#table.categories(by.field as never).codes[row]!;
          const value =
            code < 0 ? undefined : this.#table.categories(by.field as never).dictionary[code];
          const style = value === undefined ? undefined : own(by.map, value);
          if (style) paint = { ...paint, ...definedOf(style) };
        }
        const content = JSON.stringify(paint);
        look = interned.get(content);
        if (look === undefined) {
          look = paints.length;
          interned.set(content, look);
          paints.push(paint);
        }
        numbers.set(id, look);
      }
      of[row] = look;
    }
    this.#looks = { version: table.version, theme, of, paints };
    return this.#looks;
  }

  /** A field's dictionary codes as a part of rows' looks. */
  #codes(field: string): Part {
    const { codes, dictionary } = this.#table.categories(field as never);
    return { count: dictionary.length + 1, at: (row) => codes[row]! + 1 };
  }

  /** A channel as a part of rows' looks, and a row's output. */
  #part<V>(
    channel: Channel<V> | undefined,
    defaults: readonly V[],
    fallback: V,
  ): { part: Part; output(row: number): V | undefined } {
    if (!channel) return { part: { count: 1, at: () => 0 }, output: () => undefined };
    if (channel.kind === "value")
      return { part: { count: 1, at: () => 0 }, output: () => channel.value };
    if (channel.kind === "condition")
      return {
        part: { count: 2, at: (row) => (channel.when(row) ? 1 : 0) },
        output: (row) => (channel.when(row) ? channel.then : channel.otherwise),
      };
    const { codes, dictionary } = this.#table.categories(channel.field as never);
    const outputs = dictionary.map((value) => channel.scale.output(value, defaults, fallback));
    return {
      part: { count: dictionary.length + 1, at: (row) => codes[row]! + 1 },
      output: (row) => (codes[row]! < 0 ? undefined : outputs[codes[row]!]),
    };
  }
}

/** A series style's paint for a row's look: the paint properties it sets. */
function definedOf(style: SeriesStyle): RowPaint {
  const out: { -readonly [K in keyof RowPaint]: RowPaint[K] } = {};
  for (const name of PAINT) if (style[name] !== undefined) out[name] = style[name] as never;
  return out;
}

const PAINT = [
  "fill",
  "stroke",
  "strokeWidth",
  "dash",
  "opacity",
  "fillOpacity",
  "strokeOpacity",
] as const;

/** A map's own entry, not one objects inherit (`"constructor"`). */
export function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
