// Conformance fixtures for grid sources, imported as
// `herceg/grid/conformance`: rows, queries, and the windows a source must
// answer with, worked out by hand from the query semantics (query.ts), not
// produced by any source. A server's tests install each fixture's rows
// where it keeps data and run `checkGridSource`; the fixtures are plain
// JSON (`GRID_SOURCE_FIXTURES`) for servers written in other languages.
//
// Topics: missing values and NaN; string order (UTF-16 code units, no
// normalization); time zones and bins (epoch milliseconds; local days as
// data, never derived from a fixed duration); group versus leaf sorts; and
// pagination within one snapshot.

import type { GridFieldKind, GridQuery } from "./query.ts";
import {
  checkWindow,
  type GridSource,
  type GridSourceErrorCode,
  type GroupPath,
  type RowsRequest,
  type RowsWindow,
  type WindowColumn,
} from "./source.ts";

/** A fixture value: a label, a finite number, null for missing, or an infinity spelled out. */
export type FixtureValue = string | number | null | { readonly number: "+infinity" | "-infinity" };

export interface FixtureColumn {
  readonly kind: GridFieldKind;
  readonly values: readonly FixtureValue[];
}

/**
 * A request and what must answer it: the rows (for a row window, the
 * values of `fields` in order; for a group window, the grouping values down
 * to the level, each aggregate in the query's order, the group's row count,
 * and its child count), with `total` the parent's rows, which a source must
 * report on a window that ends the list and may leave null before; or the
 * errors any of which may refuse it. Requests of one query in a fixture
 * share a snapshot, the first starting it.
 */
export interface FixtureRequest {
  readonly query: Omit<GridQuery, "version" | "source">;
  readonly parent?: GroupPath;
  readonly offset: number;
  readonly limit: number;
  readonly fields?: readonly string[];
  readonly expect:
    | { readonly total: number; readonly rows: readonly (readonly FixtureValue[])[] }
    | { readonly error: readonly GridSourceErrorCode[] };
}

/**
 * Rows appended to the fixture's data between requests (where the driver
 * can): a later request naming the snapshot must answer as before or be
 * refused as "snapshot-expired".
 */
export interface FixtureInsert {
  readonly insert: Readonly<Record<string, readonly FixtureValue[]>>;
}

export interface SourceFixture {
  readonly name: string;
  readonly topic: "missing" | "strings" | "time" | "groups" | "pagination";
  readonly description: string;
  /** The key field: unique, unchanging. */
  readonly key: string;
  readonly columns: Readonly<Record<string, FixtureColumn>>;
  readonly steps: readonly (FixtureRequest | FixtureInsert)[];
}

/** Where a server's tests install a fixture's rows, as a source named as they like. */
export interface ConformanceDriver {
  install(fixture: SourceFixture): GridSource | Promise<GridSource>;
  /** Appends rows to an installed fixture's data; without it, insert steps are skipped. */
  insert?(source: GridSource, rows: FixtureInsert["insert"]): void | Promise<void>;
  /** Removes an installed fixture. */
  remove?(source: GridSource): void | Promise<void>;
}

export interface ConformanceReport {
  readonly checked: number;
  readonly skipped: number;
  readonly failures: readonly {
    readonly fixture: string;
    readonly step: number;
    readonly problem: string;
  }[];
}

const INF = { number: "+infinity" } as const;
const NEG = { number: "-infinity" } as const;
/** Instants as epoch milliseconds. */
const at = (iso: string) => Date.parse(iso);

const missing: SourceFixture = {
  name: "missing values and NaN",
  topic: "missing",
  description:
    "Missing numbers (NaN) and categories sort last in both directions; infinities are ordered values but no aggregate reads them; missing values compare false except as unequal.",
  key: "id",
  columns: {
    id: { kind: "number", values: [1, 2, 3, 4, 5, 6, 7, 8] },
    v: { kind: "number", values: [3, null, -1, INF, 0, NEG, null, 2] },
    host: { kind: "category", values: ["a", null, "b", "a", null, "c", "b", "a"] },
  },
  steps: [
    {
      query: { sort: [{ field: "v" }] },
      offset: 0,
      limit: 10,
      fields: ["id", "v"],
      expect: {
        total: 8,
        rows: [
          [6, NEG],
          [3, -1],
          [5, 0],
          [8, 2],
          [1, 3],
          [4, INF],
          [2, null],
          [7, null],
        ],
      },
    },
    {
      query: { sort: [{ field: "v", order: "descending" }] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 8, rows: [[4], [1], [8], [5], [3], [6], [2], [7]] },
    },
    {
      query: { sort: [{ field: "host", order: "descending" }] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 8, rows: [[6], [3], [7], [1], [4], [8], [2], [5]] },
    },
    {
      query: { filter: ["missing", ["field", "v"]] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 2, rows: [[2], [7]] },
    },
    {
      query: { filter: ["!=", ["field", "v"], 3] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 7, rows: [[2], [3], [4], [5], [6], [7], [8]] },
    },
    {
      query: { filter: [">", ["field", "v"], 0] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 3, rows: [[1], [4], [8]] },
    },
    {
      query: { filter: ["==", ["field", "host"], null] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 2, rows: [[2], [5]] },
    },
    {
      query: { filter: ["in", ["field", "host"], "a", null] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 5, rows: [[1], [2], [4], [5], [8]] },
    },
    {
      query: {
        group: {
          by: ["host"],
          aggregate: [
            { op: "count", as: "n" },
            { op: "count", field: "v", as: "values" },
            { op: "sum", field: "v", as: "sum" },
            { op: "mean", field: "v", as: "mean" },
            { op: "min", field: "v", as: "min" },
            { op: "max", field: "v", as: "max" },
          ],
        },
      },
      offset: 0,
      limit: 10,
      expect: {
        total: 4,
        rows: [
          ["a", 3, 2, 5, 2.5, 2, 3, 3, 3],
          ["b", 2, 1, -1, -1, -1, -1, 2, 2],
          ["c", 1, 0, 0, null, null, null, 1, 1],
          [null, 2, 1, 0, 0, 0, 0, 2, 2],
        ],
      },
    },
    {
      query: {
        group: {
          by: ["host"],
          aggregate: [{ op: "mean", field: "v", as: "mean" }],
          sort: [{ field: "mean", order: "descending" }],
        },
      },
      offset: 0,
      limit: 10,
      expect: {
        total: 4,
        rows: [
          ["a", 2.5, 3, 3],
          [null, 0, 2, 2],
          ["b", -1, 2, 2],
          ["c", null, 1, 1],
        ],
      },
    },
  ],
};

const strings: SourceFixture = {
  name: "string order",
  topic: "strings",
  description:
    "Labels order by UTF-16 code units (not code points, bytes, a locale, or case folding) and compare equal only when identical (no Unicode normalization); the empty label is not missing.",
  key: "id",
  columns: {
    id: { kind: "number", values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
    s: {
      kind: "category",
      values: ["b", "B", "a", "", null, "é", "é", "\u{1F600}", "�", "10", "9", "a b"],
    },
  },
  steps: [
    {
      query: { sort: [{ field: "s" }] },
      offset: 0,
      limit: 20,
      fields: ["id", "s"],
      expect: {
        total: 12,
        rows: [
          [4, ""],
          [10, "10"],
          [11, "9"],
          [2, "B"],
          [3, "a"],
          [12, "a b"],
          [1, "b"],
          [7, "é"],
          [6, "é"],
          [8, "\u{1F600}"],
          [9, "�"],
          [5, null],
        ],
      },
    },
    {
      query: { sort: [{ field: "s", order: "descending" }] },
      offset: 0,
      limit: 20,
      fields: ["id"],
      expect: {
        total: 12,
        rows: [[9], [8], [6], [7], [1], [12], [3], [2], [11], [10], [4], [5]],
      },
    },
    {
      query: { filter: ["==", ["field", "s"], "é"] },
      offset: 0,
      limit: 20,
      fields: ["id"],
      expect: { total: 1, rows: [[6]] },
    },
    {
      query: { filter: ["==", ["field", "s"], ""] },
      offset: 0,
      limit: 20,
      fields: ["id"],
      expect: { total: 1, rows: [[4]] },
    },
    {
      query: { filter: [">", ["field", "s"], "a"] },
      offset: 0,
      limit: 20,
      fields: ["id"],
      expect: { total: 6, rows: [[1], [6], [7], [8], [9], [12]] },
    },
    {
      // Windows have dictionaries of their own: a label's code means nothing across windows.
      query: { sort: [{ field: "s", order: "descending" }] },
      offset: 4,
      limit: 3,
      fields: ["s"],
      expect: { total: 12, rows: [["b"], ["a b"], ["a"]] },
    },
  ],
};

const time: SourceFixture = {
  name: "time zones and bins",
  topic: "time",
  description:
    "Times are epoch milliseconds: they filter, sort, and aggregate as instants, whatever zone a grid shows them in (01:15 EST after 01:30 EDT on the night clocks fall back). Local days are data (`day`, New York days here), never derived from 24-hour bins; queries cannot bin.",
  key: "id",
  columns: {
    id: { kind: "number", values: [1, 2, 3, 4, 5, 6, 7] },
    t: {
      kind: "time",
      values: [
        at("2026-11-01T05:30:00Z"),
        at("2026-11-01T06:15:00Z"),
        at("2026-11-01T04:59:59.999Z"),
        -1,
        0,
        null,
        at("2026-03-08T07:30:00Z"),
      ],
    },
    day: {
      kind: "category",
      values: [
        "2026-11-01",
        "2026-11-01",
        "2026-11-01",
        "1969-12-31",
        "1969-12-31",
        null,
        "2026-03-08",
      ],
    },
  },
  steps: [
    {
      query: { sort: [{ field: "t" }] },
      offset: 0,
      limit: 10,
      fields: ["id", "t"],
      expect: {
        total: 7,
        rows: [
          [4, -1],
          [5, 0],
          [7, at("2026-03-08T07:30:00Z")],
          [3, at("2026-11-01T04:59:59.999Z")],
          [1, at("2026-11-01T05:30:00Z")],
          [2, at("2026-11-01T06:15:00Z")],
          [6, null],
        ],
      },
    },
    {
      query: { filter: [">=", ["field", "t"], at("2026-11-01T06:00:00Z")] },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 1, rows: [[2]] },
    },
    {
      query: {
        filter: [
          "and",
          [">=", ["field", "t"], at("2026-11-01T04:00:00Z")],
          ["<", ["field", "t"], at("2026-11-01T06:00:00Z")],
        ],
      },
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 2, rows: [[1], [3]] },
    },
    {
      query: {
        group: {
          by: ["day"],
          aggregate: [
            { op: "count", as: "n" },
            { op: "min", field: "t", as: "first" },
            { op: "max", field: "t", as: "last" },
          ],
        },
      },
      offset: 0,
      limit: 10,
      expect: {
        total: 4,
        rows: [
          ["1969-12-31", 2, -1, 0, 2, 2],
          ["2026-03-08", 1, at("2026-03-08T07:30:00Z"), at("2026-03-08T07:30:00Z"), 1, 1],
          ["2026-11-01", 3, at("2026-11-01T04:59:59.999Z"), at("2026-11-01T06:15:00Z"), 3, 3],
          [null, 1, null, null, 1, 1],
        ],
      },
    },
    {
      query: { group: { by: ["t"], aggregate: [], bin: { step: 86_400_000 } } as never },
      offset: 0,
      limit: 10,
      expect: { error: ["invalid-query", "unsupported-query"] },
    },
  ],
};

const groups: SourceFixture = {
  name: "group and leaf sorts",
  topic: "groups",
  description:
    "Filters apply before groups; aggregates order every level, a grouping field its own; ties and unsorted groups go by their own value, ascending, missing last; rows sort within their group, ties by key; the same label under two parents is two groups.",
  key: "id",
  columns: {
    id: { kind: "number", values: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    region: { kind: "category", values: ["eu", "eu", "eu", "us", "us", "us", "us", null, "eu"] },
    service: {
      kind: "category",
      values: ["api", "api", "db", "api", "web", "web", "db", "api", "web"],
    },
    latency: { kind: "number", values: [10, 30, 5, 20, 1, 3, null, 7, 2] },
    k: { kind: "number", values: [1, INF, NEG, null, 1, -0, 0, 2, 1] },
  },
  steps: [
    {
      query: {
        group: {
          by: ["region", "service"],
          aggregate: [
            { op: "count", as: "n" },
            { op: "sum", field: "latency", as: "total" },
          ],
        },
      },
      offset: 0,
      limit: 10,
      expect: {
        total: 3,
        rows: [
          ["eu", 4, 47, 4, 3],
          ["us", 4, 24, 4, 3],
          [null, 1, 7, 1, 1],
        ],
      },
    },
    {
      query: {
        group: {
          by: ["region", "service"],
          aggregate: [
            { op: "count", as: "n" },
            { op: "sum", field: "latency", as: "total" },
          ],
          sort: [{ field: "total", order: "descending" }],
        },
      },
      parent: ["us"],
      offset: 0,
      limit: 10,
      expect: {
        total: 3,
        rows: [
          ["us", "api", 1, 20, 1, 1],
          ["us", "web", 2, 4, 2, 2],
          ["us", "db", 1, 0, 1, 1],
        ],
      },
    },
    {
      query: {
        group: {
          by: ["region", "service"],
          aggregate: [{ op: "count", as: "n" }],
          sort: [{ field: "n" }],
        },
      },
      parent: ["eu"],
      offset: 0,
      limit: 10,
      expect: {
        total: 3,
        rows: [
          ["eu", "db", 1, 1, 1],
          ["eu", "web", 1, 1, 1],
          ["eu", "api", 2, 2, 2],
        ],
      },
    },
    {
      query: {
        group: {
          by: ["region", "service"],
          aggregate: [{ op: "count", as: "n" }],
          sort: [{ field: "service", order: "descending" }],
        },
      },
      parent: ["eu"],
      offset: 0,
      limit: 10,
      expect: {
        total: 3,
        rows: [
          ["eu", "web", 1, 1, 1],
          ["eu", "db", 1, 1, 1],
          ["eu", "api", 2, 2, 2],
        ],
      },
    },
    {
      query: {
        sort: [{ field: "latency", order: "descending" }],
        group: { by: ["region", "service"], aggregate: [] },
      },
      parent: ["us", "web"],
      offset: 0,
      limit: 10,
      fields: ["id", "latency"],
      expect: {
        total: 2,
        rows: [
          [6, 3],
          [5, 1],
        ],
      },
    },
    {
      query: {
        sort: [{ field: "service" }],
        group: { by: ["region"], aggregate: [] },
      },
      parent: ["eu"],
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 4, rows: [[1], [2], [3], [9]] },
    },
    {
      query: {
        filter: [">", ["field", "latency"], 4],
        group: { by: ["region"], aggregate: [{ op: "count", as: "n" }] },
      },
      offset: 0,
      limit: 10,
      expect: {
        total: 3,
        rows: [
          ["eu", 3, 3, 3],
          ["us", 1, 1, 1],
          [null, 1, 1, 1],
        ],
      },
    },
    {
      // -0 is 0; infinities are groups of their own, apart from missing values.
      query: { group: { by: ["k"], aggregate: [{ op: "count", as: "n" }] } },
      offset: 0,
      limit: 10,
      expect: {
        total: 6,
        rows: [
          [NEG, 1, 1, 1],
          [0, 2, 2, 2],
          [1, 3, 3, 3],
          [2, 1, 1, 1],
          [INF, 1, 1, 1],
          [null, 1, 1, 1],
        ],
      },
    },
    {
      query: { group: { by: ["k"], aggregate: [] } },
      parent: [INF],
      offset: 0,
      limit: 10,
      fields: ["id"],
      expect: { total: 1, rows: [[2]] },
    },
  ],
};

const pagination: SourceFixture = {
  name: "pagination stability",
  topic: "pagination",
  description:
    "Windows of one snapshot fit together without gaps or repeats, in any order and overlapping; ties go by key; an answer past the end has no rows but reports the total; one ending the list reports its total.",
  key: "id",
  columns: {
    id: { kind: "number", values: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] },
    v: { kind: "number", values: [0, 1, 2, 0, 1, 2, 0, 1, 2, 0] },
  },
  steps: [
    // Out of order: the end first.
    {
      query: { sort: [{ field: "v" }] },
      offset: 6,
      limit: 4,
      fields: ["id"],
      expect: { total: 10, rows: [[7], [2], [5], [8]] },
    },
    {
      query: { sort: [{ field: "v" }] },
      offset: 0,
      limit: 4,
      fields: ["id"],
      expect: { total: 10, rows: [[0], [3], [6], [9]] },
    },
    // Overlapping windows agree where they overlap.
    {
      query: { sort: [{ field: "v" }] },
      offset: 2,
      limit: 4,
      fields: ["id"],
      expect: { total: 10, rows: [[6], [9], [1], [4]] },
    },
    {
      query: { sort: [{ field: "v" }] },
      offset: 4,
      limit: 3,
      fields: ["id"],
      expect: { total: 10, rows: [[1], [4], [7]] },
    },
    {
      query: { sort: [{ field: "v" }] },
      offset: 20,
      limit: 5,
      fields: ["id"],
      expect: { total: 10, rows: [] },
    },
    {
      query: { filter: false },
      offset: 0,
      limit: 5,
      fields: ["id"],
      expect: { total: 0, rows: [] },
    },
    // A full window ending the list may leave its total unsaid.
    {
      query: {},
      offset: 5,
      limit: 5,
      fields: ["id"],
      expect: { total: 10, rows: [[5], [6], [7], [8], [9]] },
    },
    // Rows added later are not in the snapshot (or it expires).
    { insert: { id: [10], v: [0] } },
    {
      query: { sort: [{ field: "v" }] },
      offset: 0,
      limit: 5,
      fields: ["id"],
      expect: { total: 10, rows: [[0], [3], [6], [9], [1]] },
    },
  ],
};

/** Every fixture, by topic. */
export const GRID_SOURCE_FIXTURES: readonly SourceFixture[] = [
  missing,
  strings,
  time,
  groups,
  pagination,
];

/**
 * Checks a source against every fixture: installs each, answers its
 * requests in order (those of one query from one snapshot), and compares
 * the windows' values (not their category codes or dictionaries) with the
 * fixture's.
 */
export async function checkGridSource(
  driver: ConformanceDriver,
  fixtures: readonly SourceFixture[] = GRID_SOURCE_FIXTURES,
): Promise<ConformanceReport> {
  const failures: { fixture: string; step: number; problem: string }[] = [];
  let checked = 0;
  let skipped = 0;
  for (const fixture of fixtures) {
    const source = await driver.install(fixture);
    const snapshots = new Map<string, string>();
    /** Each list's total in each snapshot, which must not change. */
    const totals = new Map<string, number>();
    /** Snapshots the source started, released when the fixture is done. */
    const opened = new Set<string>();
    let inserted = false;
    try {
      for (const [index, step] of fixture.steps.entries()) {
        if ("insert" in step) {
          if (driver.insert) {
            await driver.insert(source, step.insert);
            inserted = true;
          } else skipped++;
          continue;
        }
        checked++;
        const problem = await checkStep(source, step, snapshots, totals, opened, inserted);
        if (problem) failures.push({ fixture: fixture.name, step: index, problem });
      }
    } finally {
      for (const snapshot of opened) source.release?.(snapshot);
      await driver.remove?.(source);
    }
  }
  return { checked, skipped, failures };
}

async function checkStep(
  source: GridSource,
  step: FixtureRequest,
  snapshots: Map<string, string>,
  totals: Map<string, number>,
  opened: Set<string>,
  inserted: boolean,
): Promise<string | null> {
  const query: GridQuery = { ...step.query, version: 1, source: source.schema.source };
  const id = JSON.stringify(query);
  const request: RowsRequest = {
    query,
    revision: 1,
    schemaVersion: source.schema.version,
    snapshot: snapshots.get(id) ?? null,
    parent: step.parent ?? [],
    offset: step.offset,
    limit: step.limit,
    // The grid always asks rows for the key too, and groups for no fields.
    fields:
      (step.parent ?? []).length < (step.query.group?.by.length ?? 0)
        ? []
        : [
            ...new Set([
              ...(step.fields ?? Object.keys(source.schema.fields)),
              ...(source.schema.key !== null ? [source.schema.key] : []),
            ]),
          ],
  };
  let answer: RowsWindow;
  try {
    answer = await source.rows(request, new AbortController().signal);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if ("error" in step.expect)
      return step.expect.error.includes(code as GridSourceErrorCode)
        ? null
        : `refused with "${code}", expected ${step.expect.error.join(" or ")}`;
    // A snapshot read after an insert may be refused as expired.
    if (inserted && code === "snapshot-expired" && request.snapshot !== null) return null;
    return `refused: ${(error as Error).message}`;
  }
  const snapshot = (answer as { snapshot?: unknown } | null)?.snapshot;
  if (request.snapshot === null && typeof snapshot === "string") opened.add(snapshot);
  if ("error" in step.expect) return `answered; expected ${step.expect.error.join(" or ")}`;
  // What the grid checks of every answer, first.
  const depth = request.parent.length;
  const by = step.query.group?.by ?? [];
  const kind = depth < by.length ? "groups" : "rows";
  const fields = source.schema.fields as Readonly<Record<string, string>>;
  const kinds: Record<string, string> = Object.create(null);
  if (kind === "rows") for (const field of request.fields) kinds[field] = fields[field]!;
  else {
    for (const field of by.slice(0, depth + 1)) kinds[field] = fields[field]!;
    for (const { as } of step.query.group!.aggregate) kinds[as] = "number";
  }
  try {
    checkWindow(answer, request, kind, kinds, {
      key: kind === "rows" ? source.schema.key : null,
      ...(kind === "groups" && { group: by[depth]! }),
    });
  } catch (error) {
    return (error as Error).message;
  }
  if (answer.total !== null) {
    const list = `${answer.snapshot}\u0000${JSON.stringify(request.parent)}`;
    const known = totals.get(list);
    if (known !== undefined && known !== answer.total)
      return `reports a total of ${answer.total} where the snapshot had ${known}`;
    totals.set(list, answer.total);
  }
  if (request.snapshot === null) snapshots.set(id, answer.snapshot);
  else if (answer.snapshot !== request.snapshot) return "answered from another snapshot";
  const { total, rows } = step.expect;
  if (answer.length !== rows.length) return `has ${answer.length} rows, expected ${rows.length}`;
  const ends = step.offset + answer.length >= total;
  if (answer.total !== null ? answer.total !== total : ends && answer.length < step.limit)
    return `reports a total of ${answer.total}, expected ${total}`;
  const columns: WindowColumn[] = [];
  const names =
    answer.kind === "groups"
      ? Object.keys(answer.columns)
      : (step.fields ?? Object.keys(source.schema.fields));
  if (answer.kind === "groups") {
    const by = step.query.group!.by.slice(0, (step.parent ?? []).length + 1);
    const aggregates = step.query.group!.aggregate.map(({ as }) => as);
    for (const name of [...by, ...aggregates]) {
      const column = answer.columns[name];
      if (!column) return `lacks "${name}"`;
      columns.push(column);
    }
    columns.push(answer.rowCounts, answer.childCounts);
  } else
    for (const name of names) {
      const column = answer.columns[name];
      if (!column) return `lacks "${name}"`;
      columns.push(column);
    }
  for (let row = 0; row < rows.length; row++) {
    const actual = columns.map((column) => valueAt(column, row));
    const expected = rows[row]!;
    if (actual.length !== expected.length || actual.some((value, k) => !same(value, expected[k]!)))
      return `row ${row} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`;
  }
  return null;
}

function valueAt(column: WindowColumn, row: number): FixtureValue {
  if (column instanceof Float64Array) {
    const value = column[row]!;
    if (Number.isNaN(value)) return null;
    if (value === Number.POSITIVE_INFINITY) return INF;
    if (value === Number.NEGATIVE_INFINITY) return NEG;
    return value === 0 ? 0 : value;
  }
  const code = column.codes[row]!;
  return code < 0 ? null : (column.dictionary[code] ?? null);
}

function same(a: FixtureValue, b: FixtureValue): boolean {
  if (typeof a === "object" && a !== null) return typeof b === "object" && b?.number === a.number;
  return a === b;
}
