// Remote grids: the query and its checks, the source protocol (snapshots,
// stale answers, aborts, bad answers), windows and their cache, and focus
// and selection by key across queries.

import { afterEach, describe, expect, it, vi } from "vitest";
import { category } from "../../src/data/column.ts";
import { col } from "../../src/data/expression.ts";
import { type Table, table } from "../../src/data/table.ts";
import { memorySource } from "../../src/grid/memory.ts";
import { type GridQuery, validateGridQuery } from "../../src/grid/query.ts";
import { createRemoteGridModel, type RemoteGridModelOptions } from "../../src/grid/remote.ts";
import {
  remoteSelectionStore,
  selectionCondition,
  selectMatching,
} from "../../src/grid/remote-selection.ts";
import {
  decodeGroupPath,
  encodeGroupPath,
  type GridSource,
  GridSourceError,
  groupCondition,
  type LocateRequest,
  type RowsRequest,
  type RowsWindow,
} from "../../src/grid/source.ts";

/** `n` requests: an id (the key), a latency, and a host. */
function requests(n: number) {
  return table({
    id: Float64Array.from({ length: n }, (_, i) => i),
    ms: Float64Array.from({ length: n }, (_, i) => (i * 37) % 101),
    host: category(Array.from({ length: n }, (_, i) => ["web", "api", "db"][i % 3]!)),
  });
}

/** Lets answers arrive and the model plan again. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

interface Pending {
  request: RowsRequest;
  signal: AbortSignal;
  resolve(window: RowsWindow): void;
  reject(error: unknown): void;
}

/**
 * A source answering only when told: requests wait in `pending`, and
 * `answer` gives the reference source's answer (or `change`'s of it).
 */
function controlled(n = 1000, { locate = true } = {}) {
  const data = requests(n);
  const memory = memorySource(data, { key: "id" });
  const pending: Pending[] = [];
  /** Snapshots released, and the signals locate requests carried. */
  const released: string[] = [];
  const locates: AbortSignal[] = [];
  const source: GridSource = {
    schema: memory.schema,
    rows: (request, signal) =>
      new Promise((resolve, reject) => pending.push({ request, signal, resolve, reject })),
    ...(locate && {
      locate: (request: LocateRequest, signal: AbortSignal) => {
        locates.push(signal);
        return memory.locate(request, signal);
      },
    }),
    // Recorded only: answers to requests of released snapshots still come, as a server's would.
    release: (snapshot) => {
      released.push(snapshot);
    },
  };
  const answer = async (
    at = 0,
    change: (window: RowsWindow) => RowsWindow = (window) => window,
  ) => {
    const [next] = pending.splice(at, 1);
    next!.resolve(change(await memory.rows(next!.request, new AbortController().signal)));
    await settle();
  };
  const answerAll = async () => {
    for (let round = 0; round < 50 && pending.length > 0; round++)
      while (pending.length > 0) await answer();
  };
  return { data, memory, source, pending, answer, answerAll, released, locates };
}

const COLUMNS = [{ field: "id" }, { field: "ms" }, { field: "host" }] as const;

function model(
  source: GridSource,
  options: Partial<RemoteGridModelOptions> = {},
): ReturnType<typeof createRemoteGridModel> {
  const m = createRemoteGridModel({
    source,
    columns: COLUMNS as never,
    blockSize: 50,
    ...options,
  });
  // 10 rows of 28 pixels in view.
  m.setViewport(400, 280);
  models.push(m);
  return m;
}

const models: { dispose(): void }[] = [];
afterEach(() => {
  for (const m of models.splice(0)) m.dispose();
  vi.useRealTimers();
});

const texts = (m: ReturnType<typeof model>, column: number, from = 0, to = 10) =>
  Array.from({ length: to - from }, (_, i) => m.textAt(from + i, column));

describe("grid queries", () => {
  const schema = memorySource(requests(1), { key: "id" }).schema;
  const valid: GridQuery = {
    version: 1,
    source: "memory",
    filter: [">", ["field", "ms"], 10],
    sort: [{ field: "ms", order: "descending" }],
    group: {
      by: ["host"],
      aggregate: [
        { op: "count", as: "n" },
        { op: "mean", field: "ms", as: "latency" },
      ],
      sort: [{ field: "latency" }],
    },
  };

  it("are JSON, checked against the schema and frozen", () => {
    const query = validateGridQuery(JSON.parse(JSON.stringify(valid)), schema);
    expect(query).toEqual(valid);
    expect(Object.isFrozen(query) && Object.isFrozen(query.group!.aggregate[0])).toBe(true);
    expect(JSON.parse(JSON.stringify(query))).toEqual(valid);
  });

  it("refuse what a server might not understand or would run differently", () => {
    // biome-ignore lint/suspicious/noExplicitAny: queries broken every way JSON allows.
    const bad = (change: (query: any) => void, message: RegExp) => {
      const query = JSON.parse(JSON.stringify(valid));
      change(query);
      expect(() => validateGridQuery(query, schema)).toThrow(message);
    };
    bad((q) => (q.bins = []), /unknown property "bins"/);
    bad((q) => (q.version = 2), /version 1/);
    bad((q) => (q.source = "other"), /not the source "memory"/);
    bad((q) => (q.filter = ["field", "ms"]), /true or false/);
    bad((q) => (q.filter = [">", ["field", "nope"], 1]), /no field "nope"/);
    bad((q) => (q.sort = [{ field: "nope" }]), /Unknown sort field/);
    bad((q) => (q.sort = [{ field: "ms", order: "up" }]), /"ascending" or "descending"/);
    bad((q) => (q.sort = [{ field: "ms", direction: "up" }]), /unknown property "direction"/);
    bad((q) => (q.group.by = []), /fields to group by/);
    bad((q) => (q.group.by = ["host", "host"]), /groups by a field once/);
    bad((q) => (q.group.aggregate = [{ op: "median", field: "ms", as: "m" }]), /Unknown aggregate/);
    bad((q) => (q.group.aggregate = [{ op: "sum", as: "s" }]), /"sum" needs a field/);
    bad((q) => (q.group.aggregate = [{ op: "max", field: "host", as: "m" }]), /number or time/);
    bad(
      (q) =>
        (q.group.aggregate = [
          { op: "count", as: "n" },
          { op: "count", as: "n" },
        ]),
      /named "n"/,
    );
    bad((q) => (q.group.aggregate = [{ op: "count", as: "host" }]), /named "host"/);
    bad((q) => (q.group.sort = [{ field: "ms" }]), /Unknown group sort field "ms"/);
  });

  it("encode group paths for JSON, infinities spelled out and -0 as 0", () => {
    const key = [Number.POSITIVE_INFINITY, -0, null, "a", Number.NEGATIVE_INFINITY, 3];
    const path = encodeGroupPath(key);
    expect(JSON.parse(JSON.stringify(path))).toEqual([
      { number: "+infinity" },
      0,
      null,
      "a",
      { number: "-infinity" },
      3,
    ]);
    expect(Object.is(path[1], 0)).toBe(true);
    expect(decodeGroupPath(path)).toEqual([Number.POSITIVE_INFINITY, 0, null, "a", -Infinity, 3]);
    expect(() => decodeGroupPath([{ number: "nan" } as never])).toThrow(/Not a group path value/);
  });

  it("turn groups and selections into conditions a server can filter by", () => {
    expect(groupCondition(["host", "ms"], ["web", Number.POSITIVE_INFINITY])).toEqual([
      "and",
      ["==", ["field", "host"], "web"],
      [">", ["field", "ms"], Number.MAX_VALUE],
    ]);
    expect(groupCondition(["host"], [null])).toEqual(["missing", ["field", "host"]]);
    expect(selectionCondition({ kind: "keys", keys: [] }, "id")).toBe(false);
    expect(selectionCondition({ kind: "keys", keys: [1, 2] }, "id")).toEqual([
      "in",
      ["field", "id"],
      1,
      2,
    ]);
    expect(
      selectionCondition(selectMatching(col("ms").gt(5), { include: [1], except: [2] }), "id"),
    ).toEqual([
      "and",
      ["or", [">", ["field", "ms"], 5], ["in", ["field", "id"], 1]],
      ["not", ["in", ["field", "id"], 2]],
    ]);
  });
});

describe("remote grids", () => {
  it("show placeholders, then the rows of the windows in view and one ahead", async () => {
    const { source, pending, answer } = controlled();
    const m = model(source);
    expect(m.rowCount).toBe(50);
    expect(m.row(0)).toMatchObject({ kind: "placeholder", state: "loading", version: 0 });
    expect(m.textAt(0, 0)).toBe("Loading…");
    expect(m.textAt(0, 1)).toBe("");
    expect(m.status.starting).toBe(true);
    await settle();
    // The first request starts the snapshot; nothing else goes until it answers.
    expect(pending.map(({ request }) => [request.offset, request.snapshot])).toEqual([[0, null]]);
    expect(pending[0]!.request.fields).toEqual(["host", "id", "ms"]);
    await answer();
    expect(m.status).toMatchObject({ starting: false, total: 1000, loading: 1 });
    expect(m.rowCount).toBe(1000);
    expect(texts(m, 0, 0, 3)).toEqual(["0", "1", "2"]);
    expect(m.row(0)).toMatchObject({ kind: "row", key: 0, setIndex: 0, setSize: 1000 });
    // The window ahead, from the snapshot.
    expect(pending.map(({ request }) => [request.offset, request.snapshot])).toEqual([[50, "s1"]]);
  });

  it("keep at most `maxRequests` in flight and abort those scrolled away", async () => {
    const { source, pending, answer } = controlled(10_000);
    const m = model(source, { maxRequests: 2 });
    await settle();
    await answer();
    expect(pending).toHaveLength(1);
    // A window down: the one ahead goes out too; two in flight.
    m.scrollTo({ top: 60 * 28 });
    await settle();
    expect(pending.map(({ request }) => request.offset).sort((a, b) => a - b)).toEqual([50, 100]);
    m.scrollTo({ top: 8000 * 28 });
    await settle();
    // Requests far from the view are aborted at once.
    const aborted = pending
      .filter(({ signal }) => signal.aborted)
      .map(({ request }) => request.offset);
    expect(aborted.sort((a, b) => a - b)).toEqual([50, 100]);
    // Those for the view go out once the jump settles: in view, then ahead.
    await vi.waitFor(() =>
      expect(
        pending.filter(({ signal }) => !signal.aborted).map(({ request }) => request.offset),
      ).toEqual([8000, 8050]),
    );
  });

  it("start the snapshot again when its first request was aborted", async () => {
    const { source, pending, answer } = controlled(100_000);
    const m = model(source, { settleDelay: 0 });
    await settle();
    await answer();
    pending.length = 0;
    // A new query shows as many rows as the last until it answers.
    m.setSort([{ field: "id", order: "descending" }]);
    await settle();
    expect(pending.map(({ request }) => [request.offset, request.snapshot])).toEqual([[0, null]]);
    // Gone far before its first answer: that request is aborted, and the view's goes instead.
    m.scrollTo({ top: 50_000 * 28 });
    await settle();
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.request).toMatchObject({ offset: 50_000, snapshot: null, revision: 2 });
    await answer(1);
    expect(m.textAt(50_000, 0)).toBe("49,999");
    // A column needing a field the first request lacks does the same.
    const other = controlled();
    const n = model(other.source, { columns: [{ field: "id" }] as never });
    await settle();
    n.setColumns([{ field: "id" }, { field: "ms" }] as never);
    await settle();
    expect(other.pending.map(({ request, signal }) => [request.fields, signal.aborted])).toEqual([
      [["id"], true],
      [["id", "ms"], false],
    ]);
  });

  it("ask for one block ahead only, keeping the direction until the rows in view move", async () => {
    const { source, pending, answerAll } = controlled(100_000);
    const m = model(source, { settleDelay: 0 });
    await settle();
    await answerAll();
    m.scrollTo({ top: 50_000 * 28 });
    await settle();
    await answerAll();
    // A jump up: the rows in view, and the block below them.
    const asked: number[] = [];
    const before = pending.length;
    m.scrollTo({ top: 20_000 * 28 });
    await settle();
    for (let round = 0; round < 5 && pending.length > 0; round++) {
      asked.push(...pending.map(({ request }) => request.offset));
      await answerAll();
    }
    expect(before).toBe(0);
    expect(asked.sort((a, b) => a - b)).toEqual([20_000, 20_050]);
    // Scrolling up from there asks for the rows come into view and those above them.
    m.scrollTo({ top: 19_990 * 28 });
    await settle();
    expect(pending.map(({ request }) => request.offset)).toEqual([19_950, 19_900]);
  });

  it("ignore answers to aborted, replaced, and earlier requests", async () => {
    const { source, pending, answer } = controlled();
    const m = model(source);
    await settle();
    await answer();
    m.setSort([{ field: "ms", order: "descending" }]);
    await settle();
    // The old query's request for the window ahead was aborted; the new query's first is out.
    const [old, fresh] = [pending[0]!, pending[1]!];
    expect(old.signal.aborted).toBe(true);
    expect(fresh.request).toMatchObject({ revision: 2, snapshot: null, offset: 0 });
    // The old answer arrives anyway: it is dropped.
    await answer(0);
    expect(m.row(0).kind).toBe("placeholder");
    // And a late failure of it says nothing.
    old.reject(new Error("late"));
    await settle();
    expect(m.status.error).toBeNull();
    await answer(0);
    expect(texts(m, 1, 0, 3)).toEqual(["100", "100", "100"]);
  });

  it("refuse answers that do not answer their request", async () => {
    const cases: [string, (window: RowsWindow) => RowsWindow][] = [
      ["another place", (w) => ({ ...w, offset: w.offset + 1 })],
      ["for a limit of 50", (w) => ({ ...w, length: 60 })],
      ["lacks", (w) => ({ ...w, columns: { id: w.columns.id! } })],
      ["values of", (w) => ({ ...w, columns: { ...w.columns, ms: new Float64Array(3) } })],
      [
        "bad code",
        (w) => ({
          ...w,
          columns: {
            ...w.columns,
            host: { codes: new Int32Array(w.length).fill(9), dictionary: [] },
          },
        }),
      ],
      ["no total", (w) => ({ ...w, length: 10, total: null, columns: cut(w, 10) })],
      [
        "repeats a key",
        (w) => ({ ...w, columns: { ...w.columns, id: new Float64Array(w.length) } }),
      ],
    ];
    for (const [problem, change] of cases) {
      const { source, answer, pending } = controlled();
      const m = model(source);
      await settle();
      await answer(0, change);
      expect(m.status.error, problem).toBeInstanceOf(GridSourceError);
      expect((m.status.error as GridSourceError).code).toBe("invalid-response");
      expect(m.status.error!.message, problem).toContain(problem);
      expect(m.row(0)).toMatchObject({ kind: "placeholder", state: "failed" });
      expect(m.textAt(0, 0)).toBe("Couldn't load rows");
      // Nothing more is asked of a query whose first answer failed, until `retry`.
      expect(pending).toHaveLength(0);
      m.retry();
      await settle();
      expect(pending).toHaveLength(1);
      await answer();
      expect(m.status.error).toBeNull();
      expect(m.textAt(0, 0)).toBe("0");
    }
  });

  it("refuse a total that changes within a snapshot", async () => {
    const { source, answer } = controlled();
    const m = model(source);
    await settle();
    await answer();
    await answer(0, (w) => ({ ...w, total: 999 }));
    expect(m.status.error?.message).toMatch(/changed its list's total/);
    expect(m.status.failed).toBe(1);
  });

  it("refresh after a snapshot expires", async () => {
    const { source, pending, answer } = controlled();
    const m = model(source);
    await settle();
    await answer();
    pending.shift()!.reject(new GridSourceError("snapshot-expired", "gone"));
    await settle();
    expect(m.status.error).toMatchObject({ code: "snapshot-expired" });
    // Expired: rows already loaded stay, nothing more is asked of that snapshot.
    m.scrollTo({ top: 300 * 28 });
    await settle();
    expect(pending).toHaveLength(0);
    m.retry();
    await settle();
    expect(pending.map(({ request }) => [request.revision, request.snapshot])).toEqual([[2, null]]);
  });

  it("grow while the source has not said how many rows there are", async () => {
    const { source, answer } = controlled(120);
    const unknown = (w: RowsWindow) => (w.length === 50 ? { ...w, total: null } : w);
    const m = model(source);
    await settle();
    await answer(0, unknown);
    // As far as read, and a window more.
    expect([m.rowCount, m.status.total, m.exactRowCount]).toEqual([100, null, null]);
    await answer(0, unknown);
    expect(m.rowCount).toBe(150);
    m.scrollTo({ top: 100 * 28 });
    await settle();
    await answer(0, unknown);
    expect([m.rowCount, m.status.total, m.exactRowCount]).toEqual([120, 120, 120]);
  });

  it("keep a bounded cache of windows, dropping those farthest from the view", async () => {
    const { source, pending, answerAll } = controlled(10_000);
    const m = model(source, { cachedBlocks: 4 });
    for (const row of [0, 2000, 4000, 6000, 8000]) {
      m.scrollTo({ top: row * 28 });
      await vi.waitFor(() =>
        expect(
          pending.some(({ request, signal }) => !signal.aborted && request.offset === row),
        ).toBe(true),
      );
      await answerAll();
    }
    // Four besides the three the view wants (in view, ahead, behind).
    expect(m.status.blocks).toBeLessThanOrEqual(4 + 3);
    // In view now, and the window ahead.
    expect(m.textAt(8000, 0)).toBe("8,000");
    expect(m.row(0).kind).toBe("placeholder");
    expect(m.status.bytes).toBeGreaterThan(0);
    // The focused row's window stays while the view moves away.
    m.focusCell(8005, "id");
    m.scrollTo({ top: 0 });
    await vi.waitFor(() =>
      expect(pending.some(({ request, signal }) => !signal.aborted && request.offset === 0)).toBe(
        true,
      ),
    );
    await answerAll();
    expect(m.focus!.rowIndex).toBe(8005);
    expect(m.textAt(8005, 0)).toBe("8,005");
  });

  it("wait for a dragged scrollbar to settle, but no longer than 150 ms", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { source, pending, answer } = controlled(1_000_000);
    const m = model(source);
    const step = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    await step(0);
    // The reference source answers after a timer too.
    const answered = answer();
    await step(10);
    await answered;
    const live = () =>
      pending.filter(({ signal }) => !signal.aborted).map(({ request }) => request.offset);
    expect(live()).toEqual([50]);
    // A drag: a jump every 16 ms, for 96 ms.
    for (let frame = 1; frame <= 6; frame++) {
      m.scrollTo({ top: frame * 100_000 * 28 });
      await step(16);
    }
    // Nothing goes out while it lasts (the window ahead of the start was aborted).
    expect(live()).toEqual([]);
    // Settled, the view's windows are asked for.
    await step(60);
    expect(live()).toEqual([600_000, 600_050]);
    // A drag going on past 150 ms asks for where it is at least that often.
    pending.length = 0;
    for (let frame = 1; frame <= 12; frame++) {
      m.scrollTo({ top: (600_000 + frame * 20_000) * 28 });
      await step(16);
    }
    // (Each aborted by the next jump.)
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.length).toBeLessThanOrEqual(4);
  });

  it("keep waiting for a jump to settle through changes other than scrolling", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { source, pending, answer } = controlled(1_000_000);
    const m = model(source, { settleDelay: 1000 });
    const step = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    await step(0);
    const answered = answer();
    await step(10);
    await answered;
    pending.length = 0;
    m.scrollTo({ top: 500_000 * 28 });
    await step(10);
    // A column resized meanwhile: still waiting.
    m.resizeColumn("ms", 200);
    await step(10);
    expect(pending.filter(({ signal }) => !signal.aborted)).toHaveLength(0);
    await step(1000);
    expect(pending.map(({ request }) => request.offset)).toContain(500_000);
  });

  it("follow the focused record by key to its place in a new query", async () => {
    const { source, answerAll } = controlled();
    const m = model(source);
    await settle();
    await answerAll();
    m.focusCell(7, "ms");
    expect(m.keyAt(7)).toBe(7);
    m.setSort([{ field: "ms", order: "descending" }]);
    // At once the focus waits on the header: its row is not known yet.
    expect(m.focus).toMatchObject({ rowIndex: -1, column: "ms" });
    await settle();
    await answerAll();
    const index = m.focus!.rowIndex;
    expect(index).toBeGreaterThan(0);
    expect(m.keyAt(index)).toBe(7);
    expect(m.rowIndexOfKey(7)).toBe(index);
  });

  it("leave the focus on the header without a way to locate it, or once moved", async () => {
    const without = controlled(1000, { locate: false });
    const a = model(without.source);
    await settle();
    await without.answerAll();
    a.focusCell(3, "id");
    a.setSort([{ field: "ms" }]);
    await settle();
    await without.answerAll();
    expect(a.focus).toMatchObject({ rowIndex: -1, column: "id" });
    const moved = controlled();
    const b = model(moved.source);
    await settle();
    await moved.answerAll();
    b.focusCell(3, "id");
    b.setSort([{ field: "ms" }]);
    b.focusCell(-1, "ms");
    await settle();
    await moved.answerAll();
    expect(b.focus).toMatchObject({ rowIndex: -1, column: "ms" });
  });

  it("select records by key, which survive new queries", async () => {
    const { source, answerAll } = controlled();
    const store = remoteSelectionStore(source.schema);
    const m = model(source, { selectionStore: store });
    await settle();
    await answerAll();
    m.select(2);
    m.select(5, "toggle");
    expect(store.get("grid-rows")).toEqual({ kind: "keys", keys: [2, 5] });
    expect(m.selectedCount).toBe(2);
    m.select(9, "range");
    expect(store.get("grid-rows")).toEqual({ kind: "keys", keys: [5, 6, 7, 8, 9] });
    m.select(5, "toggle");
    expect(m.isSelected(5)).toBe(false);
    m.setSort([{ field: "ms", order: "descending" }]);
    await settle();
    await answerAll();
    expect(store.get("grid-rows")).toEqual({ kind: "keys", keys: [6, 7, 8, 9] });
    // Record 8 (latency 94) is among the first rows now; rows around it are not selected.
    const at = m.rowIndexOfKey(8);
    expect(at).toBeGreaterThan(0);
    expect([m.isSelected(at), m.isSelected(at + 1), m.isSelected(0)]).toEqual([true, false, false]);
    // The range anchor does not survive a new query; a Shift click starts one.
    m.select(0, "range");
    expect(store.get("grid-rows")).toEqual({ kind: "keys", keys: [m.keyAt(0)] });
  });

  it("refuse ranges over rows not loaded, saying why", async () => {
    const { source, pending, answerAll } = controlled(10_000);
    const m = model(source, { cachedBlocks: 2 });
    await settle();
    await answerAll();
    m.select(0);
    m.scrollTo({ top: 5000 * 28 });
    await vi.waitFor(() =>
      expect(
        pending.some(({ request, signal }) => !signal.aborted && request.offset === 5000),
      ).toBe(true),
    );
    await answerAll();
    const before = m.selectionStore.revision;
    m.select(5005, "range");
    expect(m.selectionStore.revision).toBe(before);
    expect(m.message).toMatchObject({ text: expect.stringMatching(/only rows loaded/), count: 1 });
  });

  it("select every row matching, with rows taken out and added back", async () => {
    const { source, answerAll } = controlled();
    const store = remoteSelectionStore(source.schema);
    const m = model(source, {
      selectionStore: store,
      query: { filter: ["<", ["field", "ms"], 50] },
    });
    await settle();
    await answerAll();
    m.selectAll();
    expect(store.get("grid-rows")).toEqual({
      kind: "matching",
      where: ["<", ["field", "ms"], 50],
      include: [],
      except: [],
    });
    expect(m.selectedCount).toBeNull();
    expect(m.isSelected(0) && m.isSelected(3)).toBe(true);
    m.select(3, "toggle");
    expect(m.isSelected(3)).toBe(false);
    expect(store.get("grid-rows")).toMatchObject({ except: [m.keyAt(3)] });
    m.select(3, "toggle");
    expect(store.get("grid-rows")).toMatchObject({ include: [], except: [] });
    // A row outside the condition (after the filter changes) is added by key.
    m.setQuery({});
    await settle();
    await answerAll();
    const outside = Array.from({ length: 50 }, (_, i) => i).find((i) => !m.isSelected(i))!;
    m.select(outside, "toggle");
    expect(m.isSelected(outside)).toBe(true);
    expect(store.get("grid-rows")).toMatchObject({ include: [m.keyAt(outside)] });
    // Toggled again, it leaves `include` and goes in no list.
    m.select(outside, "toggle");
    expect(m.isSelected(outside)).toBe(false);
    expect(store.get("grid-rows")).toMatchObject({ include: [], except: [] });
  });

  it("select rows one by one only where the source has keys", async () => {
    const data = requests(100);
    const m = model(memorySource(data), {});
    await settle();
    await settle();
    m.select(0);
    expect(m.selectedCount).toBe(0);
    expect(m.message?.text).toMatch(/no key/);
    m.selectAll();
    expect(m.isSelected(0)).toBe(true);
  });

  it("dispose, aborting requests and dropping answers on their way", async () => {
    const { source, pending } = controlled();
    const m = model(source);
    await settle();
    m.dispose();
    // Aborted once the command is over.
    await Promise.resolve();
    expect(pending[0]!.signal.aborted).toBe(true);
    pending[0]!.reject(new DOMException("aborted", "AbortError"));
    await settle();
    expect(m.status.loading).toBe(0);
  });

  it("ask again for windows when a column needs a field they lack", async () => {
    const { source, pending, answerAll } = controlled();
    const m = model(source, { columns: [{ field: "id" }] as never });
    await settle();
    expect(pending[0]!.request.fields).toEqual(["id"]);
    await answerAll();
    m.setColumns([{ field: "id" }, { field: "ms" }] as never);
    expect(m.row(0).kind).toBe("placeholder");
    await settle();
    expect(pending[0]!.request.fields).toEqual(["id", "ms"]);
    await answerAll();
    expect(m.textAt(1, 1)).toBe("37");
  });
});

describe("remote grids, at the edges", () => {
  it("take an answer past the end, as a new query shorter than the last gives", async () => {
    const { source, pending, answerAll } = controlled(10_000);
    const m = model(source, { settleDelay: 0 });
    await settle();
    await answerAll();
    m.scrollTo({ top: 5000 * 28 });
    await settle();
    await answerAll();
    m.setQuery({ filter: ["<", ["field", "id"], 100] });
    await settle();
    // The first request is where the grid was scrolled: past the new end.
    expect(pending[0]!.request).toMatchObject({ offset: 5000, snapshot: null });
    await answerAll();
    expect(m.status).toMatchObject({ error: null, failed: 0, total: 100 });
    expect(m.rowCount).toBe(100);
    expect(m.textAt(99, 0)).toBe("99");
    // Grouped otherwise, the grid starts from no rows.
    m.setQuery({ group: { by: ["host"], aggregate: [] } });
    await settle();
    expect(pending[0]!.request).toMatchObject({ offset: 0, parent: [] });
    await answerAll();
    expect([m.rowCount, m.status.error]).toEqual([3, null]);
  });

  it("keep only the fields asked for, whatever else an answer holds", async () => {
    const { source, answer } = controlled();
    const m = model(source);
    await settle();
    await answer(0, (w) => ({
      ...w,
      columns: { ...w.columns, rowid: Int32Array.from({ length: w.length }) as never },
    }));
    expect(m.status.error).toBeNull();
    expect(m.textAt(1, 0)).toBe("1");
    expect(m.row(1)).toMatchObject({ kind: "row", key: 1 });
  });

  it("refuse keys that are neither strings nor safe integers, and bad group counts or repeats", async () => {
    const cases: [string, (w: RowsWindow) => RowsWindow, GridQuery["group"]?][] = [
      [
        "safe integers",
        (w) => ({
          ...w,
          columns: { ...w.columns, id: (w.columns.id as Float64Array).map((x) => x + 0.5) },
        }),
      ],
      [
        "group count of NaN",
        (w) =>
          w.kind === "groups" ? { ...w, childCounts: w.childCounts.map(() => Number.NaN) } : w,
        { by: ["host"], aggregate: [] },
      ],
      [
        "repeats a group",
        (w) =>
          w.kind === "groups"
            ? { ...w, columns: { host: { codes: new Int32Array(w.length), dictionary: ["web"] } } }
            : w,
        { by: ["host"], aggregate: [] },
      ],
    ];
    for (const [problem, change, group] of cases) {
      const { source, answer } = controlled();
      const m = model(source, group ? { query: { group } as never } : {});
      await settle();
      await answer(0, change);
      expect(m.status.error?.message, problem).toContain(problem);
      expect(m.row(0).kind).toBe("placeholder");
    }
  });

  it("show rows not loaded of an expired snapshot as failed, not loading", async () => {
    const { source, pending, answer } = controlled(10_000);
    const m = model(source, { settleDelay: 0 });
    await settle();
    await answer();
    pending.shift()!.reject(new GridSourceError("snapshot-expired", "gone"));
    await settle();
    m.scrollTo({ top: 5000 * 28 });
    await settle();
    expect(m.row(5000)).toMatchObject({ kind: "placeholder", state: "failed" });
    expect(m.textAt(5000, 0)).toBe("Couldn't load rows");
  });

  it("release a snapshot whose first answer arrived for no one", async () => {
    const { source, pending, answer, answerAll, released } = controlled(10_000);
    const m = model(source, { settleDelay: 0 });
    await settle();
    await answerAll();
    m.setSort([{ field: "ms" }]);
    await settle();
    // Gone before its first answer: the request is aborted, but the source answers anyway.
    m.scrollTo({ top: 5000 * 28 });
    await settle();
    expect(pending[0]!.signal.aborted).toBe(true);
    await answer(0);
    expect(released).toContain("s2");
    await answerAll();
    expect(m.status.error).toBeNull();
  });

  it("go back to the focused record after queries one after another, aborting locates replaced", async () => {
    const { source, answerAll, locates } = controlled();
    const m = model(source);
    await settle();
    await answerAll();
    m.focusCell(7, "ms");
    m.setSort([{ field: "ms" }]);
    m.setSort([{ field: "ms", order: "descending" }]);
    await settle();
    await answerAll();
    await settle();
    expect(m.keyAt(m.focus!.rowIndex)).toBe(7);
    // A locate under way is aborted by the next query.
    const waiting: AbortSignal[] = [];
    source.locate = (_, signal) => {
      waiting.push(signal);
      return new Promise(() => {});
    };
    m.setSort([{ field: "host" }]);
    await settle();
    await answerAll();
    expect(waiting).toHaveLength(1);
    m.setSort([{ field: "id" }]);
    await Promise.resolve();
    expect(waiting[0]!.aborted).toBe(true);
    expect(locates.length).toBeGreaterThan(0);
  });

  it("count the cache's bytes over the blocks besides those the view wants", async () => {
    const { source, answerAll } = controlled(10_000);
    // A block of 50 rows holds about a kilobyte: room for three besides the view's two.
    const m = model(source, { settleDelay: 0, cachedBlocks: 100, cacheBytes: 3 * 1100 });
    for (const row of [0, 500, 1000, 1500, 2000, 2500, 3000, 3500]) {
      m.scrollTo({ top: row * 28 });
      await settle();
      await answerAll();
    }
    const one = m.status.bytes / m.status.blocks;
    expect(one).toBeGreaterThan(900);
    expect(one).toBeLessThan(1100);
    expect(m.status.blocks).toBe(2 + 3);
  });
});

describe("remote grids, second review", () => {
  it("release the snapshot of a first answer refused", async () => {
    const { source, answer, released } = controlled();
    const m = model(source);
    await settle();
    await answer(0, (w) => ({ ...w, offset: w.offset + 1 }));
    expect(m.status.error?.message).toMatch(/another place/);
    expect(released).toEqual(["s1"]);
  });

  it("read no rows again when a selection's fields come and go", async () => {
    const { source, pending, answerAll } = controlled();
    const store = remoteSelectionStore(source.schema);
    const m = model(source, { selectionStore: store, columns: [{ field: "id" }] as never });
    await settle();
    await answerAll();
    store.set("grid-rows", selectMatching(col("ms").gt(50)));
    await settle();
    await answerAll();
    let asked = 0;
    for (let round = 0; round < 3; round++) {
      store.set("grid-rows", { kind: "keys", keys: [1] });
      await settle();
      store.set("grid-rows", selectMatching(col("ms").gt(50)));
      await settle();
      asked += pending.length;
      await answerAll();
    }
    expect(asked).toBe(0);
    expect(m.isSelected(2)).toBe(true);
  });

  it("follow a located record only to places the lists have and groups that are its own", async () => {
    const { source, answerAll } = controlled(300);
    const m = model(source, {
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    m.setExpanded(["db"], true);
    await settle();
    await answerAll();
    const rows = m.rowCount;
    m.focusCell(2, "id");
    expect(m.keyAt(2)).toBe(2);
    // A locate answer putting record 2's group, "db", where "api" is.
    source.locate = async (request) => ({
      revision: request.revision,
      snapshot: request.snapshot,
      address: { parent: ["db"], offset: 0 },
      ancestors: [{ parent: [], offset: 0 }],
    });
    m.setSort([{ field: "id", order: "descending" }]);
    await settle();
    await answerAll();
    await settle();
    expect(m.focus!.rowIndex).toBe(-1);
    expect(m.rowCount).toBe(rows);
    expect(m.row(0)).toMatchObject({ key: ["api"], expanded: false });
  });
});

describe("remote grids, third review", () => {
  it("never show one group in two places, however the source places it", async () => {
    const { source, answerAll } = controlled(1000);
    const m = model(source, { query: { group: { by: ["id"], aggregate: [] } } as never });
    m.setExpanded([3], true);
    await settle();
    await answerAll();
    expect(m.rowCount).toBe(1001);
    m.focusCell(4, "id");
    expect(m.keyAt(4)).toBe(3);
    // A locate answer putting group [3] at place 900, where nothing is loaded.
    source.locate = async (request) => ({
      revision: request.revision,
      snapshot: request.snapshot,
      address: { parent: [3], offset: 0 },
      ancestors: [{ parent: [], offset: 900 }],
    });
    m.setSort([{ field: "ms" }]);
    await settle();
    await answerAll();
    await settle();
    expect([m.rowCount, m.focus!.rowIndex]).toEqual([1001, -1]);
    m.setExpanded([3], false);
    expect(m.rowCount).toBe(1000);
    // Answers that move a group expanded elsewhere move its rows with it.
    const moving = controlled(1000);
    const n = model(moving.source, { query: { group: { by: ["id"], aggregate: [] } } as never });
    n.setExpanded([3], true);
    await settle();
    await moving.answer();
    expect(n.row(3)).toMatchObject({ key: [3], expanded: true });
    // The block ahead says group [3] is at place 60.
    const ahead = () =>
      moving.pending.findIndex(
        ({ request }) => request.parent.length === 0 && request.offset === 50,
      );
    while (ahead() < 0) await moving.answer();
    await moving.answer(ahead(), (w) => {
      if (w.kind !== "groups") return w;
      const id = (w.columns.id as Float64Array).slice();
      id[10] = 3;
      return { ...w, columns: { id } };
    });
    expect(n.row(60)).toMatchObject({ kind: "group", key: [3], expanded: true });
    expect(n.row(3)).toMatchObject({ kind: "group", key: [3], expanded: false });
    n.setExpanded([3], false);
    expect(n.rowCount).toBe(1000);
  });
});

describe("remote grids, fourth review", () => {
  it("give each group its own rows when a block read again swaps their places", async () => {
    const { source, pending, answer, answerAll } = controlled(1000);
    const m = model(source, {
      query: { group: { by: ["id"], aggregate: [] } } as never,
      cachedBlocks: 1,
      settleDelay: 0,
    });
    m.setExpanded([3], true);
    m.setExpanded([4], true);
    await settle();
    await answerAll();
    expect([m.row(3), m.row(5)]).toMatchObject([
      { key: [3], expanded: true },
      { key: [4], expanded: true },
    ]);
    // Far away and back: the first block is read again, with [3] and [4] swapped.
    m.scrollTo({ top: 900 * 28 });
    await settle();
    await answerAll();
    m.scrollTo({ top: 0 });
    await settle();
    const first = pending.findIndex(
      ({ request }) => request.parent.length === 0 && request.offset === 0,
    );
    expect(first).toBeGreaterThanOrEqual(0);
    await answer(first, (w) => {
      if (w.kind !== "groups") return w;
      const id = (w.columns.id as Float64Array).slice();
      [id[3], id[4]] = [4, 3];
      return { ...w, columns: { id } };
    });
    await answerAll();
    expect([m.row(3), m.row(5)]).toMatchObject([
      { key: [4], expanded: true },
      { key: [3], expanded: true },
    ]);
    expect(m.row(4)).toMatchObject({ kind: "row", key: 4 });
    m.setExpanded([4], false);
    expect(m.row(3)).toMatchObject({ key: [4], expanded: false });
    m.setExpanded([4], true);
    expect(m.row(3)).toMatchObject({ key: [4], expanded: true });
  });
});

describe("remote grids, Sol's review", () => {
  it("count groups expanded before they load against the limit", async () => {
    const { source, answerAll } = controlled(300);
    const m = model(source, {
      query: { group: { by: ["host"], aggregate: [] } } as never,
      maxExpanded: 1,
    });
    m.setExpanded(["web"], true);
    m.setExpanded(["api"], true);
    expect([m.isExpanded(["web"]), m.isExpanded(["api"])]).toEqual([true, false]);
    expect(m.message?.text).toMatch(/At most 1 group/);
    await settle();
    await answerAll();
    expect(m.rowCount).toBe(3 + 100);
  });

  it("refuse dictionaries holding anything but labels, and leave no row loading", async () => {
    const { source, answer } = controlled();
    const m = model(source);
    await settle();
    await answer(0, (w) => ({
      ...w,
      columns: {
        ...w.columns,
        host: { ...(w.columns.host as never as object), dictionary: [null, "a", "b"] } as never,
      },
    }));
    expect(m.status).toMatchObject({ loading: 0, failed: 1 });
    expect(m.status.error?.message).toMatch(/label that is no string/);
  });

  it("keep selections from changing when the condition given to them does", () => {
    const store = remoteSelectionStore(memorySource(requests(1), { key: "id" }).schema);
    const where: [">", ["field", string], number] = [">", ["field", "ms"], 5];
    store.set("rows", { kind: "matching", where, include: [], except: [] });
    where[2] = 50;
    expect(selectionCondition(store.get("rows")!, "id")).toEqual([">", ["field", "ms"], 5]);
    store.set("rows", { kind: "keys", keys: [1, 1, 2] });
    expect(store.get("rows")).toEqual({ kind: "keys", keys: [1, 2] });
  });

  it("show groups selected from the records loaded now, whoever selected them", async () => {
    const n = 300;
    const data = table({
      id: Float64Array.from({ length: n }, (_, i) => i),
      ms: Float64Array.from({ length: n }, (_, i) => (i * 37) % 101),
      host: category(Array.from({ length: n }, (_, i) => ["web", "api", "db"][i % 3]!)),
    });
    const source = memorySource(data, { key: "id" });
    const store = remoteSelectionStore(source.schema);
    const m = model(source, {
      selectionStore: store,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    m.setExpanded(["db"], true);
    await settle();
    await settle();
    // Selected elsewhere after the rows loaded: db's record 2.
    store.set("grid-rows", { kind: "keys", keys: [2] });
    expect(m.selectionState(1)).toBe("some");
    expect(m.selectionState(0)).toBe("none");
    // The record moves to another group where the data lives: after a refresh it counts there.
    data.replace("host", 2, ["web"] as never);
    m.refresh();
    m.setExpanded(["web"], true);
    await settle();
    await settle();
    await settle();
    const web = Array.from({ length: m.rowCount }, (_, i) => i).find(
      (i) =>
        m.row(i).kind === "group" && (m.row(i) as { key: readonly unknown[] }).key[0] === "web",
    )!;
    // Its rows come into view.
    m.scrollTo({ top: web * 28 });
    await settle();
    await settle();
    expect(m.selectionState(web)).toBe("some");
    expect(m.selectionState(1)).toBe("none");
  });

  it("show a group holding the group selected partly selected, and say so before telling listeners", async () => {
    const n = 300;
    const data = table({
      id: Float64Array.from({ length: n }, (_, i) => i),
      region: category(Array.from({ length: n }, (_, i) => (i % 2 ? "eu" : "us"))),
      host: category(Array.from({ length: n }, (_, i) => ["web", "api", "db"][i % 3]!)),
    });
    const source = memorySource(data, { key: "id" });
    const m = model(source, {
      columns: [{ field: "id" }, { field: "host" }] as never,
      query: { group: { by: ["region", "host"], aggregate: [] } } as never,
    });
    m.setExpanded(["eu"], true);
    await settle();
    await settle();
    expect(m.row(0)).toMatchObject({ key: ["eu"], expanded: true });
    const seen: string[] = [];
    m.subscribe(() => seen.push(m.selectionState(1)));
    m.select(1);
    expect(seen[0]).toBe("all");
    expect(m.selectionState(0)).toBe("some");
    expect(m.selectionState(4)).toBe("none");
    // Cleared, nothing shows selected.
    m.clearSelection();
    expect([m.selectionState(0), m.selectionState(1)]).toEqual(["none", "none"]);
  });
});

describe("remote grids, Sol's second review", () => {
  it("refuse numbers JSON cannot carry in filters and selections", () => {
    const schema = memorySource(requests(1), { key: "id" }).schema;
    expect(() =>
      validateGridQuery(
        { version: 1, source: "memory", filter: ["in", ["field", "ms"], Number.POSITIVE_INFINITY] },
        schema,
      ),
    ).toThrow(/finite numbers/);
    const store = remoteSelectionStore(schema);
    expect(() => store.set("rows", selectMatching([">", ["field", "ms"], Number.NaN]))).toThrow(
      /finite numbers/,
    );
  });

  it("keep a group's rows its own when the key path given is changed later", async () => {
    const { source, pending, answerAll } = controlled(300);
    const m = model(source, { query: { group: { by: ["host"], aggregate: [] } } as never });
    await settle();
    await answerAll();
    const path = ["api"];
    m.setExpanded(path, true);
    path[0] = "db";
    await settle();
    expect(pending[0]!.request.parent).toEqual(["api"]);
    await answerAll();
    expect(m.row(1)).toMatchObject({ kind: "row", key: 1 });
  });

  it("refuse a dictionary with a label twice", async () => {
    const { source, answer } = controlled();
    const m = model(source);
    await settle();
    await answer(0, (w) => {
      const host = w.columns.host as { codes: Int32Array; dictionary: readonly string[] };
      return {
        ...w,
        columns: {
          ...w.columns,
          host: { ...host, dictionary: [...host.dictionary, host.dictionary[0]!] },
        },
      };
    });
    expect(m.status.error?.message).toMatch(/repeats a label/);
  });

  it("ignore locate results that do not hold together", async () => {
    const { source, answerAll } = controlled(300);
    const m = model(source, { query: { group: { by: ["host"], aggregate: [] } } as never });
    m.setExpanded(["api"], true);
    await settle();
    await answerAll();
    m.focusCell(1, "id");
    source.locate = async (request) =>
      ({
        revision: request.revision,
        snapshot: request.snapshot,
        address: { parent: ["api"], offset: 0 },
        ancestors: null,
      }) as never;
    const unhandled: unknown[] = [];
    const listener = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", listener);
    m.setSort([{ field: "ms" }]);
    await settle();
    await answerAll();
    await settle();
    process.off("unhandledRejection", listener);
    expect(unhandled).toEqual([]);
    expect(m.focus!.rowIndex).toBe(-1);
  });

  it("show an ancestor partly selected once a record within the group selected is taken out", async () => {
    const n = 60;
    const data = table({
      id: Float64Array.from({ length: n }, (_, i) => i),
      region: category(Array.from({ length: n }, () => "eu")),
      host: category(Array.from({ length: n }, () => "api")),
    });
    const source = memorySource(data, { key: "id" });
    const m = model(source, {
      columns: [{ field: "id" }, { field: "host" }] as never,
      query: { group: { by: ["region", "host"], aggregate: [] } } as never,
    });
    m.setExpanded(["eu"], true);
    m.setExpanded(["eu", "api"], true);
    await settle();
    await settle();
    await settle();
    m.select(1);
    expect([m.selectionState(0), m.selectionState(1)]).toEqual(["all", "all"]);
    m.select(2, "toggle");
    expect([m.selectionState(0), m.selectionState(1)]).toEqual(["some", "some"]);
  });

  it("ask by the deadline however a drag goes on, and at once for a new query", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { source, pending, answer } = controlled(1_000_000);
    const m = model(source, { settleDelay: 100 });
    const step = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    await step(0);
    const answered = answer();
    await step(10);
    await answered;
    pending.length = 0;
    m.scrollTo({ top: 300_000 * 28 });
    for (const at of [99, 198, 297]) {
      await step(99);
      m.scrollTo({ top: (300_000 + at) * 28 });
    }
    await step(5);
    expect(pending.filter(({ signal }) => !signal.aborted).length).toBeGreaterThan(0);
    // Regrouped meanwhile: the new query's first request goes at once.
    pending.length = 0;
    m.scrollTo({ top: 600_000 * 28 });
    await step(10);
    m.setQuery({ group: { by: ["host"], aggregate: [] } });
    await step(0);
    expect(pending.map(({ request }) => request.snapshot)).toEqual([null]);
  });
});

describe("remote grids, Sol's third review", () => {
  it("read a column added only once its blocks have its field", async () => {
    const { source, answerAll } = controlled();
    const m = model(source, { columns: [{ field: "id" }] as never });
    await settle();
    await answerAll();
    const texts: string[] = [];
    m.subscribe(() => texts.push(m.textAt(1, m.columnIndex("ms") >= 0 ? m.columnIndex("ms") : 0)));
    m.setColumns([{ field: "id" }, { field: "ms" }] as never);
    expect(texts.at(-1)).toBe("");
    await settle();
    await answerAll();
    expect(m.textAt(1, 1)).toBe("37");
  });

  it("keep failed blocks within the cache's limits", async () => {
    const { source, pending, answer } = controlled(1_000_000);
    const m = model(source, { settleDelay: 0, cachedBlocks: 1 });
    await settle();
    await answer();
    for (let i = 1; i <= 20; i++) {
      m.scrollTo({ top: i * 40_000 * 28 });
      await settle();
      while (pending.length > 0)
        pending.shift()!.reject(new GridSourceError("unavailable", "down"));
      await settle();
    }
    expect(m.status.failed).toBeLessThanOrEqual(1 + 2);
  });

  it("follow no located record to a collapsed group's place holding another group", async () => {
    const { source, answerAll } = controlled(300);
    const m = model(source, { query: { group: { by: ["host"], aggregate: [] } } as never });
    m.setExpanded(["api"], true);
    await settle();
    await answerAll();
    m.focusCell(1, "id");
    // Record 1 is api's; the answer puts api where db is, and api is collapsed by then.
    source.locate = async (request) => {
      m.setExpanded(["api"], false);
      return {
        revision: request.revision,
        snapshot: request.snapshot,
        address: { parent: ["api"], offset: 0 },
        ancestors: [{ parent: [], offset: 1 }],
      };
    };
    m.setSort([{ field: "ms" }]);
    await settle();
    await answerAll();
    await settle();
    expect(m.focus!.rowIndex).toBe(-1);
  });
});

describe("remote grids, Sol's fourth review", () => {
  it("drop blocks a smaller view no longer wants", async () => {
    const { source, answerAll } = controlled(1000);
    const m = model(source, { blockSize: 1, cachedBlocks: 1, settleDelay: 0 });
    m.setViewport(400, 560);
    await settle();
    await answerAll();
    const before = m.status.blocks;
    // A row in view: it, the block ahead, and the ten rows mounted below it stay, and one more.
    m.setViewport(400, 28);
    await settle();
    expect(m.status.blocks).toBeLessThan(before);
    expect(m.status.blocks).toBeLessThanOrEqual(1 + 10 + 1 + 1);
  });

  it("follow a locate answer only to the record located", async () => {
    const { source, answerAll } = controlled();
    const m = model(source);
    await settle();
    await answerAll();
    m.focusCell(1, "id");
    // The source answers with a place where another record is.
    source.locate = async (request) => ({
      revision: request.revision,
      snapshot: request.snapshot,
      address: { parent: [], offset: 3 },
      ancestors: [],
    });
    m.setSort([{ field: "id" }]);
    await settle();
    await answerAll();
    await settle();
    expect(m.keyAt(3)).toBe(3);
    expect(m.focus!.rowIndex).toBe(-1);
  });
});

describe("remote grids, Sol's fifth review", () => {
  it("start a query a listener sets while the cache drops blocks", async () => {
    const { source, pending, answerAll } = controlled(1000);
    const m = model(source, { blockSize: 1, cachedBlocks: 1, settleDelay: 0 });
    m.setViewport(400, 560);
    await settle();
    await answerAll();
    let once = true;
    m.subscribe(() => {
      if (!once) return;
      once = false;
      m.setSort([{ field: "ms" }]);
    });
    // Scrolled on, smaller: blocks out of view go, and new ones are wanted.
    m.setViewport(400, 280);
    m.scrollTo({ top: 30 * 28 });
    await settle();
    await answerAll();
    expect(pending).toHaveLength(0);
    expect(m.status).toMatchObject({ loading: 0, error: null });
    expect(m.row(30).kind).toBe("row");
    expect(m.query.sort).toEqual([{ field: "ms" }]);
  });

  it("keep a field named __proto__", async () => {
    const data = table({
      id: Float64Array.of(0, 1, 2),
      ["__proto__"]: Float64Array.of(7, 8, 9),
    } as never);
    const m = model(memorySource(data as never, { key: "id" }), {
      columns: [{ field: "id" }, { field: "__proto__" }] as never,
    });
    await settle();
    await settle();
    expect([m.status.error, m.textAt(1, 1)]).toEqual([null, "8"]);
  });

  it("take keys of the key field's kind only", () => {
    const store = remoteSelectionStore(memorySource(requests(1), { key: "id" }).schema);
    expect(() => store.set("rows", { kind: "keys", keys: [1, "2"] })).toThrow(/safe integers/);
    const labelled = memorySource(table({ name: category(["a", "b"]) }), { key: "name" });
    expect(() =>
      remoteSelectionStore(labelled.schema).set("rows", { kind: "keys", keys: [1] }),
    ).toThrow(/strings/);
  });
});

describe("remote grids, Sol's sixth review", () => {
  it("ask for a column's field though a listener sets a query as the column comes", async () => {
    const { source, pending, answerAll } = controlled();
    const m = model(source, { columns: [{ field: "id" }] as never });
    await settle();
    await answerAll();
    let once = true;
    m.subscribe(() => {
      if (!once) return;
      once = false;
      m.setSort([{ field: "id", order: "descending" }]);
    });
    m.setColumns([{ field: "id" }, { field: "ms" }] as never);
    await settle();
    expect(pending[0]!.request.fields).toEqual(["id", "ms"]);
    await answerAll();
    expect(m.textAt(0, 1)).toBe(String((999 * 37) % 101));
  });

  it("wait for jumps to settle though the cache drops blocks as they go", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { source, pending, answer } = controlled(1_000_000);
    const m = model(source, { settleDelay: 100, cachedBlocks: 1 });
    const step = (ms: number) => vi.advanceTimersByTimeAsync(ms);
    await step(0);
    const answered = answer();
    await step(10);
    await answered;
    while (pending.length > 0) {
      const next = answer();
      await step(10);
      await next;
    }
    for (const row of [200_000, 400_000, 600_000]) {
      m.scrollTo({ top: row * 28 });
      await step(15);
    }
    // None asked for, not even to be aborted.
    expect(pending).toHaveLength(0);
    await step(120);
    expect(pending.map(({ request }) => request.offset)).toContain(600_000);
  });
});

describe("remote grids, Sol's seventh review", () => {
  it("tell listeners of a new query once it is in place, and keep a query they set then", async () => {
    const { source, answerAll, released } = controlled();
    const m = model(source);
    await settle();
    await answerAll();
    m.focusCell(2, "id");
    const seen: unknown[] = [];
    let once = true;
    m.subscribe(() => {
      seen.push(m.query.sort);
      if (!once) return;
      once = false;
      m.setSort([{ field: "id", order: "descending" }]);
    });
    m.setSort([{ field: "ms" }]);
    expect(seen[0]).toEqual([{ field: "ms" }]);
    expect(m.query.sort).toEqual([{ field: "id", order: "descending" }]);
    await settle();
    await answerAll();
    expect(new Set(released).size).toBe(released.length);
  });

  it("put the focus back on its record only where listeners leave it", async () => {
    const { source, memory, answerAll } = controlled();
    let located = false;
    source.locate = (request, signal) =>
      memory.locate(request, signal).then((result) => {
        located = true;
        return result;
      });
    const m = model(source);
    await settle();
    await answerAll();
    m.focusCell(8, "id");
    // A listener that moves the focus once it sees the record located but the focus still on the header.
    let acted = false;
    m.subscribe(() => {
      if (located && !acted && m.focus!.rowIndex === -1) {
        acted = true;
        m.focusCell(0, "id");
      }
    });
    m.setSort([{ field: "id", order: "descending" }]);
    await settle();
    await answerAll();
    await settle();
    // Either listeners never see that moment, or the focus stays where they put it.
    if (acted) expect(m.focus!.rowIndex).toBe(0);
    else expect(m.keyAt(m.focus!.rowIndex)).toBe(8);
  });

  it("count groups' selected records again when the cache drops blocks", async () => {
    const n = 300;
    const data = table({
      id: Float64Array.from({ length: n }, (_, i) => i),
      host: category(Array.from({ length: n }, (_, i) => (i < 30 ? "web" : "api"))),
    });
    const source = memorySource(data, { key: "id" });
    const store = remoteSelectionStore(source.schema);
    const m = model(source, {
      selectionStore: store,
      blockSize: 1,
      cachedBlocks: 1,
      settleDelay: 0,
      columns: [{ field: "id" }, { field: "host" }] as never,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    m.setExpanded(["web"], true);
    m.setViewport(400, 32 * 28);
    for (let i = 0; i < 6; i++) await settle();
    const web = 1;
    expect(m.row(web)).toMatchObject({ key: ["web"], expanded: true });
    store.set("grid-rows", { kind: "keys", keys: Array.from({ length: 30 }, (_, i) => i) });
    expect(m.selectionState(web)).toBe("all");
    m.setViewport(400, 28);
    for (let i = 0; i < 3; i++) await settle();
    expect(m.selectionState(web)).toBe("some");
  });
});

describe("remote grids, Sol's eighth review", () => {
  it("tell listeners of a Shift move once its range is selected", async () => {
    const { source, answerAll } = controlled(300);
    const m = model(source, { query: { group: { by: ["host"], aggregate: [] } } as never });
    m.setExpanded(["api"], true);
    await settle();
    await answerAll();
    m.focusCell(5, "id");
    let collapsed = false;
    m.subscribe(() => {
      if (collapsed) return;
      collapsed = true;
      m.setExpanded(["api"], false);
    });
    expect(() => m.moveFocus("down", { extend: true })).not.toThrow();
    expect(m.isExpanded(["api"])).toBe(false);
  });

  it("give a group's scope only to the publication that selected it", async () => {
    const { source, answerAll } = controlled(300);
    const store = remoteSelectionStore(source.schema);
    let replaced = false;
    // A listener of the store that runs before the model's, and replaces what it is given.
    store.subscribe(() => {
      if (replaced) return;
      replaced = true;
      store.set("grid-rows", { kind: "matching", where: false, include: [], except: [] });
    });
    const m = model(source, {
      selectionStore: store,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    await settle();
    await answerAll();
    m.select(1);
    expect(store.get("grid-rows")).toMatchObject({ where: false });
    expect(m.selectionState(1)).toBe("none");
  });

  it("show a group selected to store listeners that run before the model's", async () => {
    const { source, answerAll } = controlled(300);
    const store = remoteSelectionStore(source.schema);
    const seen: string[] = [];
    let m: ReturnType<typeof model> | undefined;
    store.subscribe(() => seen.push(m!.selectionState(1)));
    m = model(source, {
      selectionStore: store,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    await settle();
    await answerAll();
    m.select(1);
    expect(seen).toEqual(["all"]);
  });
});

describe("remote grids, Sol's ninth review", () => {
  it("keep a group's scope though another channel changes as it is selected", async () => {
    const { source, answerAll } = controlled(300);
    const store = remoteSelectionStore(source.schema);
    let once = true;
    store.subscribe(() => {
      if (!once) return;
      once = false;
      store.set("chart-brush", { kind: "keys", keys: [1] });
    });
    const m = model(source, {
      selectionStore: store,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    await settle();
    await answerAll();
    m.select(1);
    expect(m.selectionState(1)).toBe("all");
    // Toggling it clears it.
    m.select(1, "toggle");
    expect(store.get("grid-rows")).toBeNull();
  });

  it("tell listeners when dropping blocks changes what a group shows selected", async () => {
    const n = 300;
    const data = table({
      id: Float64Array.from({ length: n }, (_, i) => i),
      host: category(Array.from({ length: n }, (_, i) => (i < 30 ? "web" : "api"))),
    });
    const source = memorySource(data, { key: "id" });
    const store = remoteSelectionStore(source.schema);
    const m = model(source, {
      selectionStore: store,
      blockSize: 1,
      cachedBlocks: 1,
      settleDelay: 0,
      columns: [{ field: "id" }, { field: "host" }] as never,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    m.setExpanded(["web"], true);
    m.setViewport(400, 32 * 28);
    for (let i = 0; i < 6; i++) await settle();
    store.set("grid-rows", { kind: "keys", keys: Array.from({ length: 30 }, (_, i) => i) });
    const told: string[] = [];
    m.subscribe(() => told.push(m.selectionState(1)));
    m.setViewport(400, 28);
    for (let i = 0; i < 3; i++) await settle();
    expect(told.at(-1)).toBe("some");
  });
});

describe("remote grids, Sol's tenth review", () => {
  it("keep count of requests whatever a source does as one is aborted", async () => {
    const { source, pending, answer, answerAll } = controlled(100_000);
    const m = model(source, { maxRequests: 1, settleDelay: 0 });
    await settle();
    await answer();
    // The block ahead is in flight; its abort listener sets a query.
    expect(pending.map(({ request }) => request.offset)).toEqual([50]);
    pending[0]!.signal.addEventListener("abort", () =>
      m.setSort([{ field: "id", order: "descending" }]),
    );
    // A jump far away aborts it.
    m.scrollTo({ top: 50_000 * 28 });
    await settle();
    expect(m.status.loading).toBe(1);
    expect(pending.filter(({ signal }) => !signal.aborted)).toHaveLength(1);
    expect(m.query.sort).toEqual([{ field: "id", order: "descending" }]);
    await answerAll();
    expect(m.status).toMatchObject({ loading: 0, error: null });
  });
});

describe("remote grids, Sol's eleventh review", () => {
  it("refresh though the source's release changes the columns", async () => {
    const { source, answerAll } = controlled();
    const m = model(source, { columns: [{ field: "id" }, { field: "ms" }] as never });
    await settle();
    await answerAll();
    m.focusCell(2, "id");
    source.release = () => m.setColumns([{ field: "ms" }] as never);
    expect(() => m.refresh()).not.toThrow();
    await settle();
    await answerAll();
    expect(m.columns.map(({ id }) => id)).toEqual(["ms"]);
  });

  it("show a group expanded again by an abort listener of its collapse", async () => {
    const { source, pending, answerAll } = controlled(300);
    const m = model(source, { query: { group: { by: ["host"], aggregate: [] } } as never });
    await settle();
    await answerAll();
    m.setExpanded(["web"], true);
    await settle();
    expect(pending[0]!.request.parent).toEqual(["web"]);
    pending[0]!.signal.addEventListener("abort", () => m.setExpanded(["web"], true));
    m.setExpanded(["web"], false);
    await settle();
    await answerAll();
    expect(m.isExpanded(["web"])).toBe(true);
    expect(m.row(2)).toMatchObject({ key: ["web"], expanded: true });
  });

  it("stay whole whatever a source's hooks do when they run", async () => {
    const { source, pending, answerAll } = controlled(10_000);
    const m = model(source, {
      maxRequests: 1,
      settleDelay: 0,
      columns: [{ field: "id" }] as never,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    // Every hook of the source runs a command of the model, a few times over.
    let meddled = 0;
    const meddle = () => {
      if (meddled++ > 40) return;
      const commands = [
        () => m.setSort([{ field: "ms", order: meddled % 2 ? "ascending" : "descending" }]),
        () => m.setQuery({}),
        () => m.refresh(),
        () => m.setColumns([{ field: "id" }, { field: "ms" }] as never),
        () => m.setExpanded(["web"], meddled % 2 === 0),
        () => m.scrollTo({ top: ((meddled * 997) % 9000) * 28 }),
      ];
      commands[meddled % commands.length]!();
    };
    const rows = source.rows;
    source.rows = (request, signal) => {
      signal.addEventListener("abort", meddle);
      meddle();
      return rows(request, signal);
    };
    source.release = meddle;
    const locate = source.locate!;
    source.locate = (request, signal) => {
      meddle();
      return locate(request, signal);
    };
    await settle();
    m.setExpanded(["api"], true);
    m.focusCell(1, "id");
    m.setSort([{ field: "id" }]);
    for (let round = 0; round < 10; round++) {
      await settle();
      await answerAll();
    }
    // Requests in flight are as many as it says, none past its limit.
    const live = pending.filter(({ signal }) => !signal.aborted).length;
    expect(m.status.loading).toBe(live);
    expect(m.status.loading).toBeLessThanOrEqual(1);
    for (let i = 0; i < m.rowCount && i < 20; i++)
      for (let c = 0; c < m.columnLayout.length; c++) m.textAt(i, c);
  });
});

describe("remote selections across queries", () => {
  it("show a condition selected with the fields it reads, though no column shows them", async () => {
    const { source, pending, answerAll } = controlled();
    const store = remoteSelectionStore(source.schema);
    const m = model(source, {
      selectionStore: store,
      columns: [{ field: "id" }] as never,
      query: { filter: [">", ["field", "ms"], 50] },
    });
    await settle();
    await answerAll();
    m.selectAll();
    m.setQuery({});
    await settle();
    expect(pending[0]!.request.fields).toEqual(["id", "ms"]);
    await answerAll();
    // Record 2 has a latency of 74, record 1 of 37.
    expect([m.isSelected(2), m.isSelected(1)]).toEqual([true, false]);
  });

  it("keep a group selected only while its selection and grouping are those it was selected in", async () => {
    const n = 300;
    const data = table({
      id: Float64Array.from({ length: n }, (_, i) => i),
      ms: Float64Array.from({ length: n }, (_, i) => (i * 37) % 101),
      host: category(Array.from({ length: n }, (_, i) => ["web", "api", "db"][i % 3]!)),
      other: category(Array.from({ length: n }, (_, i) => ["web", "api"][i % 2]!)),
    });
    const source = memorySource(data, { key: "id" });
    const store = remoteSelectionStore(source.schema);
    const m = model(source, {
      selectionStore: store,
      query: { group: { by: ["host"], aggregate: [] } } as never,
    });
    await settle();
    await settle();
    const web = 2;
    expect(m.row(web)).toMatchObject({ key: ["web"] });
    m.select(web);
    expect(m.selectionState(web)).toBe("all");
    // Another selection, made elsewhere, then a row toggled in it: not the group's.
    store.set("grid-rows", selectMatching(col("ms").gt(90)));
    m.setExpanded(["web"], true);
    await settle();
    await settle();
    m.select(web + 1, "toggle");
    expect(m.selectionState(web)).not.toBe("all");
    // Selected again, then grouped by another field with the same label.
    m.select(web);
    m.setQuery({ group: { by: ["other"], aggregate: [] } });
    await settle();
    await settle();
    const other = Array.from({ length: m.rowCount }, (_, i) => i).find(
      (i) => (m.row(i) as { key?: unknown }).key?.toString() === "web",
    )!;
    expect(m.selectionState(other)).toBe("none");
  });
});

describe("grouped remote grids", () => {
  const GROUP = {
    group: {
      by: ["host"],
      aggregate: [
        { op: "count", as: "n" },
        { op: "mean", field: "ms", as: "latency" },
      ],
    },
  } as const;

  it("show groups, expanded ones followed by their rows, loaded as they come into view", async () => {
    const { source, pending, answerAll } = controlled(300);
    const m = model(source, {
      query: GROUP as never,
      columns: [
        { field: "host" },
        { field: "id" },
        { field: "ms", aggregate: "latency", format: { maximumFractionDigits: 1 } },
      ] as never,
    });
    await settle();
    expect(pending[0]!.request).toMatchObject({ parent: [], fields: [] });
    await answerAll();
    expect(m.grouped).toBe(true);
    expect(texts(m, 0, 0, 3)).toEqual(["api (100)", "db (100)", "web (100)"]);
    let sum = 0;
    for (let i = 1; i < 300; i += 3) sum += (i * 37) % 101;
    expect(m.textAt(0, 2)).toBe((Math.round((sum / 100) * 10) / 10).toString());
    expect(m.row(1)).toMatchObject({
      kind: "group",
      key: ["db"],
      rows: 100,
      expanded: false,
      level: 1,
      setIndex: 1,
      setSize: 3,
    });
    m.setExpanded(["db"], true);
    expect(m.rowCount).toBe(103);
    expect(m.row(2)).toMatchObject({ kind: "placeholder", level: 2, indent: 0, setSize: 100 });
    await settle();
    expect(pending[0]!.request.parent).toEqual(["db"]);
    await answerAll();
    expect(texts(m, 1, 2, 5)).toEqual(["2", "5", "8"]);
    expect(m.row(2)).toMatchObject({ kind: "row", key: 2, level: 2, setIndex: 0 });
    expect(m.row(102)).toMatchObject({ kind: "group", key: ["web"] });
    // Left from a row goes to its group; Left there collapses it.
    m.focusCell(4, "host");
    m.moveFocus("left");
    expect(m.focus!.rowIndex).toBe(1);
    m.moveFocus("left");
    expect(m.isExpanded(["db"])).toBe(false);
    expect(m.rowCount).toBe(3);
  });

  it("expand groups not loaded yet once they are, and keep expansion across sorts", async () => {
    const { source, answerAll } = controlled(300);
    const m = model(source, { query: GROUP as never });
    m.setExpanded(["web"], true);
    await settle();
    await answerAll();
    expect(m.rowCount).toBe(103);
    expect(m.row(3)).toMatchObject({ kind: "row", key: 0 });
    m.setSort([{ field: "ms", order: "descending" }]);
    await settle();
    await answerAll();
    expect(m.isExpanded(["web"])).toBe(true);
    expect(m.row(2)).toMatchObject({ kind: "group", key: ["web"], expanded: true });
    // Grouped otherwise, groups start collapsed.
    m.setQuery({ group: { by: ["ms"], aggregate: [] } });
    expect(m.isExpanded(["web"])).toBe(false);
  });

  it("select a group as the rows matching it, and count records selected within", async () => {
    const { source, answerAll } = controlled(300);
    const store = remoteSelectionStore(source.schema);
    const m = model(source, {
      query: { ...GROUP, filter: [">", ["field", "ms"], 0] } as never,
      selectionStore: store,
    });
    await settle();
    await answerAll();
    m.select(1);
    expect(store.get("grid-rows")).toEqual({
      kind: "matching",
      where: ["and", [">", ["field", "ms"], 0], ["==", ["field", "host"], "db"]],
      include: [],
      except: [],
    });
    expect(m.selectionState(1)).toBe("all");
    expect(m.selectionState(0)).toBe("none");
    m.setExpanded(["db"], true);
    await settle();
    await answerAll();
    expect(m.isSelected(2)).toBe(true);
    m.select(2, "toggle");
    expect(m.selectionState(1)).toBe("some");
    m.select(1, "toggle");
    expect(m.selectionState(1)).toBe("all");
    m.select(1, "toggle");
    // A record by itself: its group is partly selected.
    m.select(3);
    expect(m.selectionState(1)).toBe("some");
    expect(m.selectionState(0)).toBe("none");
    m.select(0, "range");
    expect(m.message?.text).toMatch(/one group/);
  });

  it("refuse to expand more groups than allowed, saying so", async () => {
    const { source, answerAll } = controlled(300);
    const m = model(source, { query: GROUP as never, maxExpanded: 1 });
    await settle();
    await answerAll();
    m.setExpanded(["api"], true);
    m.setExpanded(["db"], true);
    expect(m.isExpanded(["db"])).toBe(false);
    expect(m.message?.text).toMatch(/At most 1 group/);
  });

  it("abort a collapsed group's requests and drop their answers", async () => {
    const { source, pending, answer, answerAll } = controlled(300);
    const m = model(source, { query: GROUP as never });
    await settle();
    await answerAll();
    m.setExpanded(["api"], true);
    await settle();
    const request = pending[0]!;
    expect(request.request.parent).toEqual(["api"]);
    m.setExpanded(["api"], false);
    await Promise.resolve();
    expect(request.signal.aborted).toBe(true);
    await answer();
    expect(m.rowCount).toBe(3);
  });
});

describe("the in-memory source", () => {
  it("expires snapshots when its table changes, and releases them", async () => {
    const data = requests(10) as unknown as Table;
    const source = memorySource(data, { key: "id" });
    const request: RowsRequest = {
      query: { version: 1, source: "memory" },
      revision: 1,
      schemaVersion: "1",
      snapshot: null,
      parent: [],
      offset: 0,
      limit: 5,
      fields: ["id"],
    };
    const signal = new AbortController().signal;
    const first = await source.rows(request, signal);
    expect(first.snapshot).toBe("s1");
    data.append({ id: [10], ms: [1], host: ["web"] } as never);
    await expect(source.rows({ ...request, snapshot: "s1" }, signal)).rejects.toMatchObject({
      code: "snapshot-expired",
    });
    const second = await source.rows(request, signal);
    source.release(second.snapshot);
    await expect(
      source.rows({ ...request, snapshot: second.snapshot }, signal),
    ).rejects.toMatchObject({ code: "snapshot-expired" });
    await expect(
      source.rows({ ...request, query: { ...request.query, sort: [{ field: "nope" }] } }, signal),
    ).rejects.toMatchObject({ code: "invalid-query" });
    await expect(source.rows({ ...request, schemaVersion: "0" }, signal)).rejects.toMatchObject({
      code: "schema-changed",
    });
  });

  it("wait out its latency unless aborted, and count its requests", async () => {
    const source = memorySource(requests(10), { latency: 1000 });
    const controller = new AbortController();
    const answer = source.rows(
      {
        query: { version: 1, source: "memory" },
        revision: 1,
        schemaVersion: "1",
        snapshot: null,
        parent: [],
        offset: 0,
        limit: 5,
        fields: [],
      },
      controller.signal,
    );
    controller.abort();
    await expect(answer).rejects.toMatchObject({ name: "AbortError" });
    expect(source.stats).toEqual({ requests: 1, answered: 0, failed: 0, aborted: 1 });
  });

  it("copies windows out with dictionaries of their own labels", async () => {
    const source = memorySource(requests(100), { key: "id" });
    const window = await source.rows(
      {
        query: { version: 1, source: "memory" },
        revision: 1,
        schemaVersion: "1",
        snapshot: null,
        parent: [],
        offset: 3,
        limit: 1,
        fields: ["host"],
      },
      new AbortController().signal,
    );
    expect(window.columns.host).toEqual({ codes: Int32Array.of(0), dictionary: ["web"] });
    expect((window.columns.id as Float64Array).buffer.byteLength).toBe(8);
  });
});

/** A window's columns cut to `length` rows. */
function cut(window: RowsWindow, length: number): RowsWindow["columns"] {
  return Object.fromEntries(
    Object.entries(window.columns).map(([name, column]) => [
      name,
      column instanceof Float64Array
        ? column.slice(0, length)
        : { ...column, codes: column.codes.slice(0, length) },
    ]),
  );
}
