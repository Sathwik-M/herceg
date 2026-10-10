// In-page side of the remote grid benchmark (run.ts drives it). Both grids
// read the same synthetic source: ten million rows computed from their
// place (an id, which each grid shows unformatted, and two more fields),
// never stored, answering after a fixed latency on a timer (also at 0 ms).
// It counts the requests it starts, those aborted, and those answered.
//
// Herceg: `herceg/grid/remote` with its defaults (blocks of 128 rows, two
// requests at once, 16 blocks cached besides those wanted, jumps waiting
// 50 ms to settle, or `settle` ms). AG Grid Community: the infinite row
// model with the same block size, requests, and cache
// (`cacheBlockSize` 128, `maxConcurrentDatasourceRequests` 2,
// `maxBlocksInCache` 16) and `blockLoadDebounceMillis` 50 or `settle`, which
// delays every block it loads where Herceg's delays only jumps; it cannot
// abort a request, so its datasource answers every one. Each grid is moved
// through its own API for showing a row at the top.
//
// A jump starts when the harness asks the grid to show a row at the top
// (`model.scrollTo`, `api.ensureIndexVisible`) and ends with the first frame
// whose rows inside the viewport all show their ids (checked just before
// the frame paints, as in the grid suite). A trace moves the top row on
// every frame at a speed in rows per second and records, per frame, whether
// every row in view showed its id.

import {
  createGrid as createAgGrid,
  type GridApi,
  type IDatasource,
  InfiniteRowModelModule,
  ModuleRegistry,
  ScrollApiModule,
  themeQuartz,
} from "ag-grid-community";
import {
  createRemoteGrid,
  createRemoteGridModel,
  type GridSource,
  type RemoteGridModel,
} from "herceg/grid/remote";
import { checkedFrame, settle } from "../frames.ts";

ModuleRegistry.registerModules([InfiniteRowModelModule, ScrollApiModule]);

export const ROWS = 10_000_000;
const ROW_HEIGHT = 28;
const WIDTH = 1200;
const HEIGHT = 600;
const HEADER = 32;
const HOSTS = ["web", "api", "db"];

export interface Counts {
  started: number;
  aborted: number;
  answered: number;
}

/** The source's rows, computed: what a server would answer. */
function rowsAt(offset: number, length: number) {
  const id = Float64Array.from({ length }, (_, i) => offset + i);
  return {
    id,
    v: id.map((x) => (x * 7919) % 1000),
    host: Int32Array.from(id, (x) => x % 3),
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

interface Mounted {
  scrollToRow(row: number): void;
  /** Problems with the frame: rows in view not showing their ids; "" when right. */
  check(top: number): string;
  heldBytes(): number;
  destroy(): void;
}

function box(): HTMLElement {
  const element = document.createElement("div");
  element.style.cssText = `width:${WIDTH}px;height:${HEIGHT}px;position:relative;overflow:hidden;font:13px Arial,sans-serif`;
  document.getElementById("stage")!.append(element);
  return element;
}

function mountHerceg(
  element: HTMLElement,
  latency: number,
  settle: number,
  counts: Counts,
): Mounted {
  let snapshots = 0;
  const source: GridSource = {
    schema: {
      source: "synthetic",
      version: "1",
      fields: { id: "number", v: "number", host: "category" },
      key: "id",
    },
    async rows(request, signal) {
      counts.started++;
      try {
        await delay(latency, signal);
      } catch (error) {
        counts.aborted++;
        throw error;
      }
      counts.answered++;
      const length = Math.max(0, Math.min(request.limit, ROWS - request.offset));
      const { id, v, host } = rowsAt(request.offset, length);
      return {
        kind: "rows",
        revision: request.revision,
        snapshot: request.snapshot ?? `s${++snapshots}`,
        parent: request.parent,
        offset: request.offset,
        length,
        total: ROWS,
        columns: { id, v, host: { codes: host, dictionary: HOSTS } },
      };
    },
  };
  const model = createRemoteGridModel({
    source,
    columns: [{ field: "id", format: { useGrouping: false } }, { field: "v" }, { field: "host" }],
    settleDelay: settle,
  }) as unknown as RemoteGridModel;
  const grid = createRemoteGrid(element, { model, ariaLabel: "Rows" });
  return {
    scrollToRow: (row) => model.scrollTo({ top: row * ROW_HEIGHT }),
    check(top) {
      const scroller = element.querySelector(".hg-scroller")!;
      const view = scroller.getBoundingClientRect();
      return checkRows(
        element.querySelectorAll<HTMLElement>(".hg-body [role=row]"),
        (row) => Number(row.getAttribute("aria-rowindex")) - 2,
        (row) => row.querySelector('[aria-colindex="1"]')?.textContent,
        view.top + HEADER,
        view.top + scroller.clientHeight,
        top,
      );
    },
    heldBytes: () => model.status.bytes,
    destroy() {
      grid.destroy();
      model.dispose();
    },
  };
}

function mountAgGrid(
  element: HTMLElement,
  latency: number,
  settle: number,
  counts: Counts,
): Mounted {
  const datasource: IDatasource = {
    rowCount: ROWS,
    async getRows(params) {
      counts.started++;
      await delay(latency);
      counts.answered++;
      const length = Math.max(0, Math.min(params.endRow, ROWS) - params.startRow);
      const { id, v, host } = rowsAt(params.startRow, length);
      const rows = Array.from({ length }, (_, i) => ({
        id: id[i],
        v: v[i],
        host: HOSTS[host[i]!],
      }));
      params.successCallback(rows, ROWS);
    },
  };
  const api: GridApi = createAgGrid(element, {
    theme: themeQuartz.withParams({
      fontFamily: "Arial, sans-serif",
      fontSize: 13,
      rowHeight: ROW_HEIGHT,
      headerHeight: HEADER,
      wrapperBorder: false,
    }),
    rowModelType: "infinite",
    datasource,
    cacheBlockSize: 128,
    maxConcurrentDatasourceRequests: 2,
    maxBlocksInCache: 16,
    blockLoadDebounceMillis: settle,
    infiniteInitialRowCount: ROWS,
    rowBuffer: 10,
    animateRows: false,
    getRowId: (params) => String(params.data.id),
    columnDefs: [{ field: "id" }, { field: "v" }, { field: "host" }].map((column) => ({
      ...column,
      width: 120,
      sortable: false,
    })),
  });
  return {
    scrollToRow: (row) => api.ensureIndexVisible(row, "top"),
    check(top) {
      // One element scrolls both ways; the header sticks at its top.
      const viewport = element.querySelector(".ag-grid-viewport");
      const header = element.querySelector(".ag-grid-pinned-top-rows");
      if (!viewport || !header) return "not built yet";
      return checkRows(
        element.querySelectorAll<HTMLElement>(".ag-grid-scrolling-container .ag-row"),
        (row) => Number(row.getAttribute("row-index")),
        (row) => row.querySelector('[col-id="id"]')?.textContent?.trim(),
        header.getBoundingClientRect().bottom,
        viewport.getBoundingClientRect().top + viewport.clientHeight,
        top,
      );
    },
    heldBytes: () => Number.NaN,
    destroy: () => api.destroy(),
  };
}

/**
 * What is wrong with the rows between the viewport's edges, `top` the row
 * asked for at its top; "" when nothing is. That row must be within a row
 * of the top edge (a grid scrolling scaled may leave it a few pixels off),
 * and every row covering the viewport from the top edge to the bottom
 * must be there, 28 px below the one before, showing its id.
 */
function checkRows(
  elements: Iterable<HTMLElement>,
  indexOf: (row: HTMLElement) => number,
  textOf: (row: HTMLElement) => string | null | undefined,
  edge: number,
  bottom: number,
  top: number,
): string {
  const placed = new Map<number, HTMLElement>();
  for (const row of elements) placed.set(indexOf(row), row);
  const asked = placed.get(top);
  if (!asked) return `row ${top} is not shown`;
  const offset = asked.getBoundingClientRect().top - edge;
  if (Math.abs(offset) >= ROW_HEIGHT) return `row ${top} is at ${offset} px`;
  // The rows covering the viewport, from the one at its top edge.
  const first = Math.max(0, top - (offset > 0 ? 1 : 0));
  for (let index = first; index < ROWS; index++) {
    const y = offset + (index - top) * ROW_HEIGHT;
    if (y >= bottom - edge) break;
    const row = placed.get(index);
    if (!row) return `row ${index} is not shown`;
    const at = row.getBoundingClientRect().top - edge;
    if (Math.abs(at - y) > 1) return `row ${index} is at ${at} px, not ${y}`;
    const text = textOf(row);
    if (text !== String(index)) return `row ${index} shows "${text}"`;
  }
  return "";
}

let mounted: (Mounted & { element: HTMLElement }) | null = null;
export const counts: Counts = { started: 0, aborted: 0, answered: 0 };

/** Waits for frames until `check` passes, at most 30 s; the time from `start` to that frame. */
async function correct(top: number, start: number): Promise<number> {
  let problem = "";
  for (;;) {
    const frame = await checkedFrame(() => mounted!.check(top));
    if (frame.observed && frame.value === "") return frame.time - start;
    problem = frame.value ?? problem;
    if (performance.now() - start > 30_000) throw new Error(`incorrect: ${problem}`);
  }
}

export const remoteBench = {
  async mount(library: string, latency: number, settle = 50): Promise<number> {
    const element = box();
    Object.assign(counts, { started: 0, aborted: 0, answered: 0 });
    const start = performance.now();
    const grid = (library === "herceg" ? mountHerceg : mountAgGrid)(
      element,
      latency,
      settle,
      counts,
    );
    mounted = { ...grid, element };
    return correct(0, start);
  },

  /** Shows `row` at the top; the time to the first frame with every row in view loaded. */
  async jump(row: number): Promise<{ time: number; requests: number }> {
    // A pause first, as between the grid suite's samples: right after a frame
    // that changed nothing, Chrome waits for the display's refresh to make
    // the next one, which would add up to a refresh interval to the jump.
    await settle();
    const before = counts.started;
    const start = performance.now();
    mounted!.scrollToRow(row);
    const time = await correct(row, start);
    return { time, requests: counts.started - before };
  },

  /**
   * Moves the top row at `speed` rows a second for `ms`, then waits for the
   * rows to settle: requests started and aborted, frames, and frames in
   * which some row in view was not loaded.
   */
  async trace(from: number, speed: number, ms: number) {
    await settle();
    const before = { ...counts };
    let frames = 0;
    let incomplete = 0;
    const start = performance.now();
    for (;;) {
      const elapsed = performance.now() - start;
      if (elapsed >= ms) break;
      const top = from + Math.floor((elapsed / 1000) * speed);
      mounted!.scrollToRow(top);
      const frame = await checkedFrame(() => mounted!.check(top));
      frames++;
      if (!frame.observed || frame.value !== "") incomplete++;
    }
    const seconds = (performance.now() - start) / 1000;
    // Where the trace ended, shown in full before the next trial.
    const end = from + Math.floor((ms / 1000) * speed);
    mounted!.scrollToRow(end);
    await correct(end, performance.now());
    return {
      seconds,
      started: counts.started - before.started,
      aborted: counts.aborted - before.aborted,
      frames,
      incomplete,
    };
  },

  heldBytes: () => mounted!.heldBytes(),
  domNodes: () => mounted!.element.querySelectorAll("*").length,

  destroy() {
    mounted?.destroy();
    mounted?.element.remove();
    mounted = null;
  },
};

declare global {
  interface Window {
    remoteBench: typeof remoteBench;
  }
}
window.remoteBench = remoteBench;
