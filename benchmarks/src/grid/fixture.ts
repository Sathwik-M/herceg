// Seeded columnar fixture for the grid benchmarks, and the cell formatting
// every grid is configured with.
//
// A group of 20 fields holds 16 numbers, 2 times, and 2 categories; the wide
// fixture has five independent groups. Values include missing entries, many
// ties, and duplicated rows. Every library receives these values; adapters
// convert them into the input each library documents.

import { random } from "../datasets.ts";

export type FieldKind = "number" | "time" | "category";

export interface GridField {
  name: string;
  kind: FieldKind;
}

/**
 * Columns of a table or of a batch appended to one. Numbers and times (epoch
 * milliseconds) are Float64Array with NaN for missing values; categories are
 * Int32Array codes into `dictionaries[field]`, -1 for missing values. The
 * arrays are source data: adapters must not write to them.
 */
export interface GridTable {
  fields: GridField[];
  columns: (Float64Array | Int32Array)[];
  /** Labels per category field, in code order (not label order); empty for other kinds. */
  dictionaries: string[][];
  length: number;
  /** Row identities are `firstId + i`. */
  firstId: number;
}

export interface GridSize {
  rows: number;
  /** Groups of 20 fields. */
  groups: number;
}

export const START_TIME = Date.UTC(2026, 0, 1);
const YEAR_MS = 365 * 24 * 3600 * 1000;

/** Share of rows that repeat the previous row's values in every field. */
const DUPLICATE_RATE = 0.005;

/** Numeric field profiles, cycled through n0..n15 in every group. */
const PROFILES: { missing: number; value: (next: () => number, id: number) => number }[] = [
  // n0: uniform 0..1000; the numeric range filter field, also changed under that filter.
  { missing: 0.01, value: (next) => Math.round(next() * 100_000) / 100 },
  // n1: integers 0..99, so sorts have many ties.
  { missing: 0, value: (next) => Math.floor(next() * 100) },
  // n2: prices around 100; the numeric sort field.
  { missing: 0.03, value: (next) => 100 + gaussian(next) * 15 },
  // n3: heavy-tailed sizes; the sort key that updates change.
  { missing: 0, value: (next) => Math.exp(5 + gaussian(next) * 2) },
  // n4: the display-only field that updates change (on screen at the left).
  { missing: 0, value: (next) => next() * 2000 - 1000 },
  // Values that format as 0.00 or -0.00.
  { missing: 0, value: (next) => gaussian(next) * 1e-4 },
  { missing: 0, value: (next) => next() * 1e9 },
  { missing: 0, value: (next) => Math.floor(next() * 1e6) },
  { missing: 0.05, value: (next) => next() },
  { missing: 0, value: (next) => Math.floor(next() * 10) },
  { missing: 0, value: (next, id) => Math.sin(id / 500) * 1000 + gaussian(next) * 10 },
  { missing: 0.1, value: (next) => gaussian(next) },
  { missing: 0, value: (next) => -Math.log(1 - next()) * 50 },
  { missing: 0.2, value: (next) => Math.floor(next() * 101) },
  // All ties apart from missing values.
  { missing: 0.01, value: () => 42 },
  { missing: 0, value: (next) => Math.round(next() * 1_000_000) / 100 },
];

/** Low-cardinality labels and their weights (skewed). */
const STATUS = ["active", "blocked", "closed", "draft", "expired", "held", "pending", "queued"];
const STATUS_WEIGHTS = [0.4, 0.2, 0.12, 0.1, 0.08, 0.05, 0.03, 0.02];
/** Moderate-cardinality labels: same length, lowercase letters and digits, so code-unit and locale order agree. */
const SKUS = Array.from({ length: 1000 }, (_, i) => `sku${String(i).padStart(4, "0")}`);
const CATEGORY_MISSING = 0.01;
const RANDOM_TIME_MISSING = 0.02;

function gaussian(next: () => number): number {
  const u = 1 - next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

function mix(...parts: number[]): number {
  let h = 0x811c9dc5;
  for (const part of parts) h = Math.imul(h ^ part, 0x01000193) >>> 0;
  return h;
}

/** Field names and kinds: per group c, t, 8 numbers, c, t, 8 numbers. */
export function gridFields(groups: number): GridField[] {
  const fields: GridField[] = [];
  for (let g = 0; g < groups; g++) {
    for (let half = 0; half < 2; half++) {
      fields.push({ name: `c${2 * g + half}`, kind: "category" });
      fields.push({ name: `t${2 * g + half}`, kind: "time" });
      for (let n = 0; n < 8; n++)
        fields.push({ name: `n${16 * g + 8 * half + n}`, kind: "number" });
    }
  }
  return fields;
}

/** Number profile, time role, or category role of a field, from its name. */
function role(field: GridField): number {
  return Number(field.name.slice(1)) % (field.kind === "number" ? 16 : 2);
}

function dictionaryFor(field: GridField, seed: number): string[] {
  const labels = [...(role(field) === 0 ? STATUS : SKUS)];
  // Codes deliberately do not follow label order.
  const next = random(mix(seed, 0xd1c7, Number(field.name.slice(1))));
  for (let i = labels.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [labels[i], labels[j]] = [labels[j]!, labels[i]!];
  }
  return labels;
}

/** Fills `length` rows starting at identity `firstId`; `stream` separates batches. */
function fill(
  fields: GridField[],
  dictionaries: string[][],
  length: number,
  firstId: number,
  seed: number,
  stream: number,
): GridTable {
  const duplicate = new Uint8Array(length);
  const nextDuplicate = random(mix(seed, stream, 0xd0b1));
  for (let i = 1; i < length; i++) duplicate[i] = nextDuplicate() < DUPLICATE_RATE ? 1 : 0;
  const columns = fields.map((field, f) => {
    const next = random(mix(seed, stream, f + 1));
    const r = role(field);
    if (field.kind === "category") {
      const dictionary = dictionaries[f]!;
      const codeOf = new Map(dictionary.map((label, code) => [label, code]));
      const labels = r === 0 ? STATUS : SKUS;
      const codes = labels.map((label) => codeOf.get(label)!);
      const out = new Int32Array(length);
      for (let i = 0; i < length; i++) {
        if (duplicate[i]) {
          out[i] = out[i - 1]!;
          continue;
        }
        if (next() < CATEGORY_MISSING) {
          out[i] = -1;
          continue;
        }
        let index = 0;
        if (r === 0) {
          let u = next();
          while (index < STATUS_WEIGHTS.length - 1 && u >= STATUS_WEIGHTS[index]!) {
            u -= STATUS_WEIGHTS[index]!;
            index++;
          }
        } else index = Math.floor(next() * labels.length);
        out[i] = codes[index]!;
      }
      return out;
    }
    const out = new Float64Array(length);
    const profile = field.kind === "number" ? PROFILES[r]! : undefined;
    for (let i = 0; i < length; i++) {
      const id = firstId + i;
      if (duplicate[i]) out[i] = out[i - 1]!;
      else if (field.kind === "time") {
        // t even: event time, increasing with the row; t odd: any time in 2025, some missing.
        if (r === 0) out[i] = START_TIME + id * 1000 + Math.floor(next() * 1000);
        else
          out[i] =
            next() < RANDOM_TIME_MISSING
              ? Number.NaN
              : START_TIME - YEAR_MS + Math.floor(next() * YEAR_MS);
      } else out[i] = next() < profile!.missing ? Number.NaN : profile!.value(next, id);
    }
    return out;
  });
  return { fields, columns, dictionaries, length, firstId };
}

/** The table a scenario starts from. */
export function gridTable(size: GridSize, seed = 1): GridTable {
  const fields = gridFields(size.groups);
  const dictionaries = fields.map((field) =>
    field.kind === "category" ? dictionaryFor(field, seed) : [],
  );
  return fill(fields, dictionaries, size.rows, 0, seed, 0);
}

/** Batch `tick` of `count` rows appended after `table` and the batches before it. */
export function appendBatch(table: GridTable, count: number, tick: number, seed = 1): GridTable {
  const firstId = table.firstId + table.length + tick * count;
  return fill(table.fields, table.dictionaries, count, firstId, seed, 1000 + tick);
}

/** New values of field `field` for the given rows, as the field's profile generates them. */
export function updateValues(
  table: GridTable,
  field: number,
  ids: ArrayLike<number>,
  tick: number,
  seed = 1,
): Float64Array {
  const profile = PROFILES[role(table.fields[field]!)]!;
  const next = random(mix(seed, 0x0bda7e, tick));
  return Float64Array.from({ length: ids.length }, (_, i) => profile.value(next, ids[i]!));
}

/** Bytes of the fixture's column buffers. */
export function tableBytes(table: GridTable): number {
  return table.columns.reduce((sum, column) => sum + column.byteLength, 0);
}

// Formatting shared by every grid: the same locale, number format, UTC time
// format, and missing-value text. Herceg's adapter passes these options to its
// columns; the other adapters call the functions below when they render.
export const FORMAT = {
  locale: "en-US",
  // Values that round to zero print without a minus sign.
  number: { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "negative" },
  time: {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  },
  timeZone: "UTC",
  missing: "—",
} as const satisfies {
  locale: string;
  number: Intl.NumberFormatOptions;
  time: Intl.DateTimeFormatOptions;
  timeZone: string;
  missing: string;
};

const numberFormat = new Intl.NumberFormat(FORMAT.locale, FORMAT.number);
const timeFormat = new Intl.DateTimeFormat(FORMAT.locale, {
  ...FORMAT.time,
  timeZone: FORMAT.timeZone,
});

/** Missing values are NaN in the fixture and undefined in row objects. */
export function formatNumber(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? FORMAT.missing : numberFormat.format(value);
}

export function formatTime(value: number | undefined): string {
  return value === undefined || Number.isNaN(value) ? FORMAT.missing : timeFormat.format(value);
}

export function formatLabel(label: string | undefined): string {
  return label ?? FORMAT.missing;
}

/** Formats a value by field kind: numbers and times as numbers, categories as labels. */
export function formatValue(kind: FieldKind, value: number | string | undefined): string {
  if (kind === "category") return formatLabel(value as string | undefined);
  return kind === "time" ? formatTime(value as number | undefined) : formatNumber(value as number);
}
