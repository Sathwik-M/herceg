// The reference source passes the conformance fixtures, and the checker
// catches sources that answer otherwise.

import { describe, expect, it } from "vitest";
import { type ColumnInput, category, time } from "../../src/data/column.ts";
import { type Table, table } from "../../src/data/table.ts";
import {
  type ConformanceDriver,
  checkGridSource,
  type FixtureColumn,
  type FixtureValue,
  GRID_SOURCE_FIXTURES,
} from "../../src/grid/conformance.ts";
import { type MemorySource, memorySource } from "../../src/grid/memory.ts";
import type { GridSource, RowsRequest, RowsWindow } from "../../src/grid/source.ts";

function number(value: FixtureValue): number {
  if (value === null) return Number.NaN;
  if (typeof value === "object")
    return value.number === "+infinity" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return value as number;
}

function input({ kind, values }: FixtureColumn): ColumnInput {
  if (kind === "category") return category(values as (string | null)[]);
  const numbers = Float64Array.from(values, number);
  return kind === "time" ? time(numbers) : numbers;
}

const tables = new WeakMap<GridSource, Table>();

const memory: ConformanceDriver = {
  install(fixture) {
    const data = table(
      Object.fromEntries(
        Object.entries(fixture.columns).map(([name, column]) => [name, input(column)]),
      ),
    ) as unknown as Table;
    const source = memorySource(data, { key: fixture.key, name: "fixture" });
    tables.set(source, data);
    return source;
  },
  insert(source, rows) {
    const data = tables.get(source)!;
    data.append(
      Object.fromEntries(
        Object.entries(rows).map(([name, values]) => [
          name,
          data.kind(name) === "category" ? values : values.map(number),
        ]),
      ) as never,
    );
  },
  remove(source) {
    (source as MemorySource).dispose();
  },
};

describe("grid source conformance", () => {
  it("covers each topic", () => {
    expect(new Set(GRID_SOURCE_FIXTURES.map(({ topic }) => topic))).toEqual(
      new Set(["missing", "strings", "time", "groups", "pagination"]),
    );
  });

  it("is met by the in-memory source", async () => {
    const report = await checkGridSource(memory);
    expect(report.failures).toEqual([]);
    expect(report.checked).toBeGreaterThan(30);
    expect(report.skipped).toBe(0);
  });

  it("releases every snapshot it starts", async () => {
    const released: string[] = [];
    // Snapshot ids start again with each fixture's source: count them in order.
    const started: string[] = [];
    const driver: ConformanceDriver = {
      async install(fixture) {
        const source = (await memory.install(fixture)) as MemorySource;
        return {
          schema: source.schema,
          rows: async (request, signal) => {
            const answer = await source.rows(request, signal);
            if (request.snapshot === null) started.push(answer.snapshot);
            return answer;
          },
          release: (snapshot) => {
            released.push(snapshot);
            source.release(snapshot);
          },
        };
      },
    };
    await checkGridSource(driver);
    expect(started.length).toBeGreaterThan(10);
    expect(released.sort()).toEqual(started.sort());
  });

  it("catches sources that sort, count, or page otherwise", async () => {
    // Each wraps the reference source and gets one thing wrong.
    const wrapped = (change: (window: RowsWindow, request: RowsRequest) => RowsWindow) => ({
      ...memory,
      async install(fixture: Parameters<ConformanceDriver["install"]>[0]) {
        const source = (await memory.install(fixture)) as MemorySource;
        const wrapper: GridSource = {
          schema: source.schema,
          rows: async (request, signal) => change(await source.rows(request, signal), request),
        };
        tables.set(wrapper, tables.get(source)!);
        return wrapper;
      },
      remove: () => {},
    });
    // Missing values first instead of last: rows reversed when sorted descending.
    const reversed = wrapped((window, request) => {
      if (window.kind !== "rows" || request.query.sort?.[0]?.order !== "descending") return window;
      const columns = Object.fromEntries(
        Object.entries(window.columns).map(([name, column]) => [
          name,
          column instanceof Float64Array
            ? column.slice().reverse()
            : { ...column, codes: column.codes.slice().reverse() },
        ]),
      );
      return { ...window, columns };
    });
    expect((await checkGridSource(reversed)).failures.length).toBeGreaterThan(0);
    // No total on the window that ends the list.
    const untotalled = wrapped((window) => ({ ...window, total: null }));
    const report = await checkGridSource(untotalled);
    expect(report.failures.some(({ problem }) => /total/.test(problem))).toBe(true);
    // Counts off by one.
    const miscounted = wrapped((window) =>
      window.kind === "groups"
        ? { ...window, rowCounts: window.rowCounts.map((n) => n + 1) }
        : window,
    );
    expect((await checkGridSource(miscounted)).failures.length).toBeGreaterThan(0);
    // An answer the grid would refuse: of another place, or with codes past its dictionary.
    const shifted = wrapped((window) => ({ ...window, offset: window.offset + 1 }));
    const shiftedReport = await checkGridSource(shifted);
    expect(shiftedReport.failures.every(({ problem }) => /another place/.test(problem))).toBe(true);
    expect(shiftedReport.failures.length).toBe(shiftedReport.checked - 1);
    const truncated = wrapped((window) => ({
      ...window,
      columns: Object.fromEntries(
        Object.entries(window.columns).map(([name, column]) => [
          name,
          column instanceof Float64Array ? column : { ...column, dictionary: [] },
        ]),
      ),
    }));
    const truncatedReport = await checkGridSource(truncated);
    expect(truncatedReport.failures.some(({ problem }) => /bad code/.test(problem))).toBe(true);
    // What else the grid refuses: a key twice, and a total that changes within a snapshot.
    const repeated = wrapped((window) =>
      window.kind === "rows" && window.length > 1
        ? { ...window, columns: { ...window.columns, id: new Float64Array(window.length) } }
        : window,
    );
    expect(
      (await checkGridSource(repeated)).failures.some(({ problem }) =>
        /repeats a key/.test(problem),
      ),
    ).toBe(true);
    const seen = new Set<string>();
    const growing = wrapped((window) => {
      const again = seen.has(window.snapshot);
      seen.add(window.snapshot);
      return again && window.kind === "rows" && window.total !== null && window.length > 0
        ? { ...window, total: window.total + 1 }
        : window;
    });
    expect(
      (await checkGridSource(growing)).failures.some(({ problem }) =>
        /where the snapshot had/.test(problem),
      ),
    ).toBe(true);
  });
});
