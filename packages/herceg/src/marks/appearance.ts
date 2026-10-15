// The values of a category field in order of first appearance, taking
// places in a cycle of shapes or colors: point marks encode symbol fields
// this way, and 3D and map points category colors, with a key of the
// values in the legend. (Points' colors go through the chart's color scale;
// see marks/features.)

import type { Schema, Table } from "../data/table.ts";
import { symbolPath } from "../draw/symbols.ts";
import type { CategoryColors } from "../model/features.ts";
import type { Theme } from "../theme.ts";
import type { GlyphKey } from "./mark.ts";

/** Radius of the circles of a color key. */
const KEY_RADIUS = 4.5;

/**
 * A category field's values in order of first appearance in the table's
 * rows. A value keeps its place while it stays in the table, though
 * compaction renumbers codes; values that left are forgotten once they
 * outnumber those in it.
 */
export class Appearance {
  readonly field: string;
  readonly #places = new Map<string, number>();
  #next = 0;
  #byCode: { version: number; places: Int32Array; order: number[] } | undefined;
  #cycled: { places: Int32Array; length: number; slots: Int32Array } | undefined;

  constructor(field: string) {
    this.field = field;
  }

  /** Each code's place, or -1 for codes no row holds, for the table's current version. */
  places(table: Table<Schema>): Int32Array {
    return this.#read(table).places;
  }

  /** The codes rows hold, in order of their places: the order a key lists the values in. */
  order(table: Table<Schema>): readonly number[] {
    return this.#read(table).order;
  }

  #read(table: Table<Schema>): { places: Int32Array; order: number[] } {
    const { version } = table;
    if (this.#byCode?.version === version) return this.#byCode;
    const { codes, dictionary } = table.categories(this.field as never);
    const present = new Uint8Array(dictionary.length);
    // The codes rows hold, in the order rows first hold them.
    const seen: number[] = [];
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code >= 0 && !present[code]) {
        present[code] = 1;
        seen.push(code);
      }
    }
    if (this.#places.size > 2 * seen.length + 64) {
      const live = new Set(seen.map((code) => dictionary[code]));
      for (const label of this.#places.keys()) if (!live.has(label)) this.#places.delete(label);
    }
    const places = new Int32Array(dictionary.length).fill(-1);
    for (const code of seen) {
      const label = dictionary[code]!;
      let place = this.#places.get(label);
      if (place === undefined) {
        place = this.#next++;
        this.#places.set(label, place);
      }
      places[code] = place;
    }
    const order = seen.sort((a, b) => places[a]! - places[b]!);
    this.#byCode = { version, places, order };
    return this.#byCode;
  }

  /** Each code's slot in a cycle of `length` (shapes, colors), or -1 for codes no row holds. */
  tones(table: Table<Schema>, length: number): Int32Array {
    const places = this.places(table);
    const cycled = this.#cycled;
    if (cycled?.places === places && cycled.length === length) return cycled.slots;
    const slots = places.map((place) => (place < 0 ? -1 : place % length));
    this.#cycled = { places, length, slots };
    return slots;
  }

  /** A value's place, as of the last `places`. */
  of(label: string): number | undefined {
    return this.#places.get(label);
  }
}

/**
 * The colors category values take in turn: the theme's palette, at most 255
 * of them, since points index their colors by bytes.
 */
export function categoryColors(theme: Theme): readonly string[] {
  return theme.palette.length <= 255 ? theme.palette : theme.palette.slice(0, 255);
}

/** Each code's color of a category `color` field (by `categoryColors`), and -1 for codes no row holds. */
export function categoryTones(colors: Appearance, table: Table<Schema>, theme: Theme): Int32Array {
  return colors.tones(table, categoryColors(theme).length);
}

/** A key of a category `color` field's values in their colors, in order of appearance. */
export function colorKey(colors: Appearance, table: Table<Schema>, theme: Theme): GlyphKey {
  const palette = categoryColors(theme);
  const tones = categoryTones(colors, table, theme);
  const { dictionary } = table.categories(colors.field as never);
  return keyOf(colors.field, dictionary, colors.order(table), (code) => palette[tones[code]!]!);
}

/** A key of a category `color` field's values in the colors a color scale gives them. */
export function scaleKey(categories: CategoryColors): GlyphKey {
  const { colors, tones } = categories;
  return keyOf(
    categories.field,
    categories.dictionary,
    categories.order,
    (code) => colors[tones[code]!]!,
  );
}

function keyOf(
  title: string,
  dictionary: readonly string[],
  order: readonly number[],
  color: (code: number) => string,
): GlyphKey {
  const glyph = symbolPath("circle", 0, 0, KEY_RADIUS);
  return {
    title,
    channel: "color",
    entries: order.map((code) => ({
      label: dictionary[code]!,
      glyph,
      r: KEY_RADIUS,
      color: color(code),
    })),
  };
}
