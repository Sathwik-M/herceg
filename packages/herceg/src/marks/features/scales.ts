// Categorical scales with fixed outputs: the chart's `scales` of type
// "ordinal", and the default ones an unnamed field reads ("symbol",
// "dash", and "color" where the chart declares it). A value's place in the
// domain is kept for the chart's life, so a value keeps its output as data
// streams, leaves, and comes back, in every mark and panel reading the
// scale. Without a declared "color", a field's values take the chart's
// colors of what they stand for (`IdentityColors`).

import type { Table } from "../../data/table.ts";
import type { OrdinalScaleSpec } from "../../spec/encoding.ts";

/** What channels read a field's values through: a scale of the chart's, or its colors by identity. */
export interface CategoryScale {
  readonly name: string;
  readonly spec: OrdinalScaleSpec | undefined;
  /** Reads `field` of `table` into the domain from now on. */
  read(table: Table, field: string): void;
  /** A value's place in the domain; undefined outside an explicit domain. */
  place(value: string): number | undefined;
  /** A value's output, as `OrdinalScale.output`. */
  output<V>(value: string, defaults: readonly V[], fallback: V): V;
}

/** A field of a mark's table a scale reads its values from. */
interface Source {
  table: Table;
  field: string;
  /** The table version last read. */
  version: number;
}

export class OrdinalScale implements CategoryScale {
  readonly name: string;
  readonly spec: OrdinalScaleSpec | undefined;
  /** Each value's place in the domain, in order: sticky once given. */
  readonly #places = new Map<string, number>();
  readonly #sources: Source[] = [];

  /**
   * `previous`, the scale of the configuration before with the same
   * settings, hands over its values' places, not the tables it read.
   */
  constructor(name: string, spec: OrdinalScaleSpec | undefined, previous?: OrdinalScale) {
    this.name = name;
    this.spec = spec;
    if (previous) for (const [value, place] of previous.#places) this.#places.set(value, place);
    for (const value of spec?.domain ?? [])
      if (!this.#places.has(value)) this.#places.set(value, this.#places.size);
  }

  /** Reads `field` of `table` into the domain from now on, unless the domain is given. */
  read(table: Table, field: string): void {
    if (this.spec?.domain) return;
    if (!this.#sources.some((s) => s.table === table && s.field === field))
      this.#sources.push({ table, field, version: -1 });
  }

  /**
   * Brings the domain up to date with the fields it reads, in the order the
   * marks read them: each field's dictionary in its order (a pandas
   * Categorical's or Arrow dictionary's own; first appearance for strings).
   */
  update(): void {
    for (const source of this.#sources) {
      const { table, field } = source;
      if (source.version === table.version) continue;
      source.version = table.version;
      for (const value of table.categories(field as never).dictionary) this.#add(value);
    }
  }

  #add(value: string): void {
    if (!this.#places.has(value)) this.#places.set(value, this.#places.size);
  }

  /** A value's place in the domain; undefined outside an explicit domain. */
  place(value: string): number | undefined {
    if (!this.spec?.domain) this.#add(value);
    return this.#places.get(value);
  }

  /** The domain's values, in order. */
  get domain(): readonly string[] {
    return [...this.#places.keys()];
  }

  /**
   * A value's output: its `map` entry, else the output of its place among
   * `defaults` (cycled), else (outside an explicit domain, or with no
   * defaults) `unknown`, or `fallback` without one.
   */
  output<V>(value: string, defaults: readonly V[], fallback: V): V {
    const map = this.spec?.map;
    const mapped = map && Object.hasOwn(map, value) ? map[value] : undefined;
    if (mapped !== undefined) return mapped as V;
    const place = this.place(value);
    if (place !== undefined && defaults.length > 0) return defaults[place % defaults.length]!;
    return (this.spec?.unknown as V | undefined) ?? fallback;
  }
}

/**
 * A field's values' colors where the chart declares no "color" scale: the
 * chart's colors of what each value stands for (see model/identity.ts), by
 * the identity keys `prefix` starts, so a bar or point colored by a field
 * has the color the series of that value have: the colors at the chart's
 * palette slots for those keys, which the compilation hands over before
 * each scene.
 */
export class IdentityColors implements CategoryScale {
  readonly name = "color";
  readonly spec = undefined;
  readonly #prefix: string;
  readonly #chart: { slot: ((key: string) => number) | undefined };
  /** Values in the order first colored, which keys of colors list them in. */
  readonly #places = new Map<string, number>();

  constructor(prefix: string, chart: { slot: ((key: string) => number) | undefined }) {
    this.#prefix = prefix;
    this.#chart = chart;
  }

  read(): void {}

  place(value: string): number {
    let place = this.#places.get(value);
    if (place === undefined) {
      place = this.#places.size;
      this.#places.set(value, place);
    }
    return place;
  }

  /** The identity key of a value. */
  key(value: string): string {
    return `${this.#prefix}${JSON.stringify(value)}}`;
  }

  output<V>(value: string, defaults: readonly V[], fallback: V): V {
    this.place(value);
    const slot = this.#chart.slot?.(this.key(value));
    return slot !== undefined && defaults.length > 0 ? defaults[slot % defaults.length]! : fallback;
  }
}
