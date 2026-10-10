// Remote grids in the browser: ten million rows that live elsewhere,
// placeholders marked busy while windows load, the keyboard over them, and
// failures shown, announced, and tried again.

import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { createRemoteGrid, type RemoteGrid } from "../../src/dom/grid-remote.ts";
import { memorySource } from "../../src/grid/memory.ts";
import { createRemoteGridModel, type RemoteGridModel } from "../../src/grid/remote.ts";
import { remoteSelectionStore } from "../../src/grid/remote-selection.ts";
import {
  type GridSource,
  GridSourceError,
  type RowsRequest,
  type RowsWindow,
} from "../../src/grid/source.ts";
import { collectGarbage } from "./helpers.ts";

const COMMAND = navigator.platform.startsWith("Mac") ? "Meta" : "Control";
const HOSTS = ["web", "api", "db"];

/**
 * `rows` rows computed from their place, never stored: an id (the key), a
 * value, and a host. Answers can be paused; `fail` refuses requests.
 */
function synthetic(rows: number, fail?: (request: RowsRequest) => boolean) {
  const requests: RowsRequest[] = [];
  const pending = new Set<() => void>();
  let paused = false;
  let snapshots = 0;
  const source: GridSource = {
    schema: {
      source: "synthetic",
      version: "1",
      fields: { id: "number", v: "number", host: "category" },
      key: "id",
    },
    rows: (request, signal) =>
      new Promise<RowsWindow>((resolve, reject) => {
        requests.push(request);
        const answer = () => {
          pending.delete(answer);
          signal.removeEventListener("abort", abort);
          if (fail?.(request)) {
            reject(new GridSourceError("unavailable", "The server is down"));
            return;
          }
          const length = Math.max(0, Math.min(request.limit, rows - request.offset));
          const id = Float64Array.from({ length }, (_, i) => request.offset + i);
          resolve({
            kind: "rows",
            revision: request.revision,
            snapshot: request.snapshot ?? `s${++snapshots}`,
            parent: request.parent,
            offset: request.offset,
            length,
            total: rows,
            columns: {
              id,
              v: id.map((x) => (x * 7919) % 1000),
              host: { codes: Int32Array.from(id, (x) => x % 3), dictionary: HOSTS },
            },
          });
        };
        const abort = () => {
          pending.delete(answer);
          reject(new DOMException("aborted", "AbortError"));
        };
        signal.addEventListener("abort", abort, { once: true });
        pending.add(answer);
        queueMicrotask(() => {
          if (!paused && pending.has(answer)) answer();
        });
      }),
  };
  return {
    source,
    requests,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
      for (const answer of pending) answer();
    },
  };
}

const grids: { destroy(): void; root: HTMLElement }[] = [];
const models: { dispose(): void }[] = [];
afterEach(() => {
  for (const grid of grids.splice(0)) {
    const host = grid.root.parentElement;
    grid.destroy();
    host?.remove();
  }
  for (const model of models.splice(0)) model.dispose();
});

function mount(
  source: GridSource,
  columns: { field: string; id?: string }[] = [{ field: "id" }, { field: "v" }, { field: "host" }],
): { grid: RemoteGrid; model: RemoteGridModel } {
  const host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
  const model = createRemoteGridModel({ source, columns } as never) as unknown as RemoteGridModel;
  const grid = createRemoteGrid(host, { model, ariaLabel: "Requests" }) as unknown as RemoteGrid;
  grids.push(grid);
  models.push(model);
  return { grid, model };
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Frames until `ready` holds, at most `ms`. */
async function until(ready: () => boolean, ms = 3000): Promise<void> {
  const start = performance.now();
  while (!ready()) {
    if (performance.now() - start > ms) throw new Error("timed out");
    await frame();
  }
}

const scrollerOf = (grid: RemoteGrid) => grid.root.querySelector<HTMLElement>(".hg-scroller")!;
/** Mounted body rows in DOM order, with their row index, busy state, and first cell's text. */
const rows = (grid: RemoteGrid) =>
  [...grid.root.querySelectorAll<HTMLElement>(".hg-body [role=row]")].map((row) => ({
    index: Number(row.getAttribute("aria-rowindex")) - 2,
    busy: row.getAttribute("aria-busy"),
    state: row.dataset.state ?? null,
    text: row.querySelector('[aria-colindex="1"]')?.textContent ?? "",
  }));
const said = (grid: RemoteGrid) => grid.root.querySelector("[aria-live]")!.textContent?.trim();

describe("remote grids in the browser", () => {
  it("scroll ten million rows while loading: placeholders marked busy, then rows", async () => {
    const { source, requests, pause, resume } = synthetic(10_000_000);
    pause();
    const { grid, model } = mount(source);
    const scroller = scrollerOf(grid);
    // At mount, the grid waits for its first rows, each a busy placeholder.
    expect(scroller.getAttribute("aria-busy")).toBe("true");
    expect(rows(grid)[0]).toMatchObject({ busy: "true", state: "loading", text: "Loading…" });
    resume();
    await until(() => rows(grid)[0]!.text === "0");
    expect(scroller.hasAttribute("aria-busy")).toBe(false);
    expect(rows(grid)[0]!.busy).toBeNull();
    expect(scroller.getAttribute("aria-rowcount")).toBe("10000001");
    // Nothing failed: the notice takes no room.
    expect(getComputedStyle(grid.root.querySelector(".hg-status")!).display).toBe("none");
    // Halfway down: keep answers pending until the placeholders are checked.
    pause();
    scroller.scrollTop = scroller.scrollHeight / 2;
    await until(() => rows(grid).some(({ state }) => state === "loading"));
    const first = Math.floor(model.top / model.rowHeight);
    expect(first).toBeGreaterThan(4_000_000);
    resume();
    await until(() => rows(grid).every(({ state }) => state === null));
    const shown = rows(grid).find(({ index }) => index === first)!;
    expect(shown.text).toBe(first.toLocaleString("en-US"));
    // A handful of requests, not one per row or per frame.
    expect(requests.length).toBeLessThan(12);
    expect(model.status.blocks).toBeLessThanOrEqual(16 + 3);
  });

  it("move the focus and select by keyboard over rows still loading", async () => {
    const { source, pause, resume } = synthetic(10_000_000);
    const { grid, model } = mount(source);
    await until(() => rows(grid)[0]!.text === "0");
    scrollerOf(grid).focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown} ");
    expect(model.focus).toMatchObject({ rowIndex: 1, column: "id" });
    expect(said(grid)).toBe("1 row selected");
    const row = grid.root.querySelector('[aria-rowindex="3"]')!;
    expect(row.getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard(`{${COMMAND}>}a{/${COMMAND}}`);
    expect(said(grid)).toBe("Matching rows selected");
    // The last row: a placeholder, focused at once and filled when it loads.
    pause();
    await userEvent.keyboard(`{${COMMAND}>}{End}{/${COMMAND}}`);
    expect(model.focus!.rowIndex).toBe(9_999_999);
    const focused = document.activeElement as HTMLElement;
    expect(focused.getAttribute("role")).toBe("gridcell");
    expect(focused.parentElement!.getAttribute("aria-rowindex")).toBe("10000001");
    expect(focused.parentElement!.getAttribute("aria-busy")).toBe("true");
    // Loading cannot finish during the keyboard action or a later frame.
    await frame();
    expect(document.activeElement).toBe(focused);
    expect(focused.parentElement!.getAttribute("aria-busy")).toBe("true");
    resume();
    await until(() => focused.parentElement?.getAttribute("aria-busy") === null);
    const cell = document.activeElement as HTMLElement;
    expect(cell).toBe(focused);
    expect(model.row(9_999_999).kind).toBe("row");
    expect(cell.parentElement!.getAttribute("aria-busy")).toBeNull();
    expect(model.textAt(9_999_999, 2)).toBe(HOSTS[9_999_999 % 3]);
    // Selected by the condition: rows loaded later are selected too.
    expect(cell.parentElement!.getAttribute("aria-selected")).toBe("true");
  });

  it("show and announce failures, and try again", async () => {
    let failing = true;
    const { source } = synthetic(1000, () => failing);
    const { grid, model } = mount(source);
    await until(() => rows(grid)[0]!.state === "failed");
    expect(rows(grid)[0]).toMatchObject({ busy: null, text: "Couldn't load rows" });
    expect(said(grid)).toBe("Rows could not load: The server is down");
    const notice = grid.root.querySelector<HTMLElement>(".hg-status")!;
    expect(notice.hidden).toBe(false);
    const button = notice.querySelector("button")!;
    expect(button.textContent).toBe("Try again");
    // Under the rows, not over them.
    const scroller = scrollerOf(grid);
    await frame();
    expect(scroller.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      notice.getBoundingClientRect().top + 0.5,
    );
    expect(await violations(grid.root)).toEqual([]);
    failing = false;
    await userEvent.click(button);
    await until(() => rows(grid)[0]!.text === "0");
    expect(notice.hidden).toBe(true);
    expect(scroller.style.bottom).toBe("");
    expect(model.status.error).toBeNull();
    // The focus went back to the grid, not to the page.
    expect(scroller.contains(document.activeElement)).toBe(true);
  });

  it("try again where the rows failed, keeping the grid there", async () => {
    let failing = true;
    const { source } = synthetic(10_000, (request) => failing && request.offset >= 500);
    // Wider than the grid: twelve columns of 120 pixels in 600.
    const columns = Array.from({ length: 12 }, (_, i) => ({ field: "v", id: `v${i}` }));
    const { grid, model } = mount(source, [{ field: "id" }, ...columns]);
    await until(() => rows(grid)[0]!.text === "0");
    scrollerOf(grid).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(model.focus!.rowIndex).toBe(0);
    model.scrollTo({ top: 600 * model.rowHeight, left: 800 });
    await until(() => rows(grid).some(({ state }) => state === "failed"));
    const [top, left] = [model.top, model.left];
    expect(left).toBe(800);
    failing = false;
    await userEvent.click(grid.root.querySelector(".hg-status button")!);
    await until(() => model.row(605).kind === "row");
    expect([model.top, model.left]).toEqual([top, left]);
    // The focus is back in the grid, on a row and column in view.
    expect(scrollerOf(grid).contains(document.activeElement)).toBe(true);
    expect(model.focus!.rowIndex).toBeGreaterThanOrEqual(600);
    expect(model.focus!.column).not.toBe("id");
  });

  it("refresh after an expired snapshot back to a record in view", async () => {
    let expired = true;
    const { source } = synthetic(10_000);
    const expiring: GridSource = {
      ...source,
      rows: (request, signal) =>
        expired && request.snapshot !== null && request.offset >= 500
          ? Promise.reject(new GridSourceError("snapshot-expired", "The data changed"))
          : source.rows(request, signal),
      // Rows are in key order: a record's place is its key.
      locate: async (request) => ({
        revision: request.revision,
        snapshot: request.snapshot,
        address: { parent: [], offset: request.key as number },
        ancestors: [],
      }),
    };
    const columns = Array.from({ length: 12 }, (_, i) => ({ field: "v", id: `v${i}` }));
    const { grid, model } = mount(expiring, [{ field: "id" }, ...columns]);
    await until(() => rows(grid)[0]!.text === "0");
    scrollerOf(grid).focus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    model.scrollTo({ top: 600 * model.rowHeight, left: 800 });
    await until(() => rows(grid).some(({ state }) => state === "failed"));
    const button = grid.root.querySelector<HTMLButtonElement>(".hg-status button")!;
    expect(button.textContent).toBe("Refresh");
    expired = false;
    await userEvent.click(button);
    // The focus goes back to its record in the new snapshot, and the grid stays where it was.
    await until(() => model.focus!.rowIndex === 1);
    expect(model.focus!.column).not.toBe("id");
    expect([model.top, model.left]).toEqual([600 * model.rowHeight, 800]);
    expect(scrollerOf(grid).contains(document.activeElement)).toBe(true);
  });

  it("write placeholders' text where the first column is after columns move", async () => {
    const { source, pause } = synthetic(1000);
    pause();
    const { grid, model } = mount(source);
    await frame();
    model.moveColumn("host", "id");
    grid.render();
    const first = grid.root.querySelector('.hg-body [role=row] [aria-colindex="1"]')!;
    const second = grid.root.querySelector('.hg-body [role=row] [aria-colindex="2"]')!;
    expect([first.textContent, second.textContent]).toEqual(["Loading…", ""]);
  });

  it("click rows of a group collapsed and expanded again before a frame", async () => {
    const memory = memorySource(
      table({
        id: Float64Array.from({ length: 30 }, (_, i) => i),
        v: Float64Array.from({ length: 30 }, (_, i) => i),
        host: category(Array.from({ length: 30 }, (_, i) => HOSTS[i % 3]!)),
      }),
      { key: "id" },
    );
    const host = document.createElement("div");
    host.style.cssText = "width:600px;height:300px";
    document.body.append(host);
    const model = createRemoteGridModel({
      source: memory,
      columns: [{ field: "id" }, { field: "host" }],
      query: { group: { by: ["host"], aggregate: [] } },
    }) as unknown as RemoteGridModel;
    const grid = createRemoteGrid(host, { model, ariaLabel: "Requests" }) as unknown as RemoteGrid;
    grids.push(grid);
    models.push(model);
    model.setExpanded(["api"], true);
    await until(() => model.rowCount === 13 && model.row(1).kind === "row");
    grid.render();
    model.setExpanded(["api"], false);
    model.setExpanded(["api"], true);
    await until(() => model.row(1).kind === "row");
    grid.render();
    const cell = grid.root.querySelector<HTMLElement>(
      '.hg-body [aria-rowindex="3"] [aria-colindex="1"]',
    )!;
    await userEvent.click(cell);
    expect(model.isSelected(1)).toBe(true);
  });

  it("keep the rows above the notice as it grows with a narrower grid", async () => {
    const { source } = synthetic(1000);
    const refusing: GridSource = {
      ...source,
      rows: () =>
        Promise.reject(
          new GridSourceError(
            "unsupported-query",
            "This source cannot sort by that field, filter by that condition, or group by that field at once",
          ),
        ),
    };
    const { grid } = mount(refusing);
    await until(() => rows(grid)[0]!.state === "failed");
    const notice = grid.root.querySelector<HTMLElement>(".hg-status")!;
    const scroller = scrollerOf(grid);
    grid.root.parentElement!.style.width = "160px";
    await until(
      () =>
        notice.offsetHeight > 40 &&
        scroller.getBoundingClientRect().bottom <= notice.getBoundingClientRect().top + 0.5,
    );
    expect(notice.offsetHeight).toBeGreaterThan(40);
    expect(scroller.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      notice.getBoundingClientRect().top + 0.5,
    );
  });

  it("let go of a grid and its model once destroyed and disposed", async () => {
    // Mounted in a function of its own, so the test keeps no reference to them.
    const refs = await (async () => {
      const { source } = synthetic(1000, () => true);
      const { grid, model } = mount(source);
      await until(() => rows(grid)[0]!.state === "failed");
      grids.splice(grids.indexOf(grid), 1);
      models.splice(models.indexOf(model), 1);
      const host = grid.root.parentElement!;
      grid.destroy();
      model.dispose();
      host.remove();
      return { grid: new WeakRef(grid), model: new WeakRef(model) };
    })();
    // Read only after: `deref` keeps what it returns until the page's task
    // ends, which in Firefox, and in WebKit at times, outlasts a collection.
    for (let i = 0; i < 3; i++) {
      await frame();
      await collectGarbage();
    }
    expect([refs.grid.deref(), refs.model.deref()]).toEqual([undefined, undefined]);
  });

  it("let go of a model no one keeps, though never disposed", async () => {
    const { source } = synthetic(1000);
    const store = remoteSelectionStore(source.schema);
    const ref = await (async () => {
      const model = createRemoteGridModel({
        source,
        selectionStore: store,
        columns: [{ field: "id" }],
      }) as unknown as RemoteGridModel;
      model.setViewport(400, 280);
      await until(() => model.row(0).kind === "row");
      return new WeakRef(model);
    })();
    // Read only after collecting; see the test above.
    for (let i = 0; i < 3; i++) {
      await frame();
      await collectGarbage();
    }
    // The store it listened to stays, and holds it no longer.
    expect(store.revision).toBe(0);
    expect(ref.deref()).toBeUndefined();
  });

  it("click a row whose group a focus listener collapses", async () => {
    const memory = memorySource(
      table({
        id: Float64Array.from({ length: 30 }, (_, i) => i),
        v: Float64Array.from({ length: 30 }, (_, i) => i),
        host: category(Array.from({ length: 30 }, (_, i) => HOSTS[i % 3]!)),
      }),
      { key: "id" },
    );
    const host = document.createElement("div");
    host.style.cssText = "width:600px;height:300px";
    document.body.append(host);
    const model = createRemoteGridModel({
      source: memory,
      columns: [{ field: "id" }, { field: "host" }],
      query: { group: { by: ["host"], aggregate: [] } },
    }) as unknown as RemoteGridModel;
    const grid = createRemoteGrid(host, { model, ariaLabel: "Requests" }) as unknown as RemoteGrid;
    grids.push(grid);
    models.push(model);
    model.setExpanded(["api"], true);
    await until(() => model.row(3).kind === "row");
    grid.render();
    model.focusCell(3, "id");
    model.subscribe(() => {
      if (model.isExpanded(["api"]) && model.focus!.rowIndex === 3)
        model.setExpanded(["api"], false);
    });
    const cell = grid.root.querySelector<HTMLElement>(
      '.hg-body [aria-rowindex="5"] [aria-colindex="1"]',
    )!;
    await userEvent.click(cell);
    expect(model.isExpanded(["api"])).toBe(false);
  });

  it("say a group expanded though a listener moves it", async () => {
    const memory = memorySource(
      table({
        id: Float64Array.from({ length: 30 }, (_, i) => i),
        region: category(Array.from({ length: 30 }, () => "eu")),
        host: category(Array.from({ length: 30 }, (_, i) => HOSTS[i % 3]!)),
      }),
      { key: "id" },
    );
    const host = document.createElement("div");
    host.style.cssText = "width:600px;height:300px";
    document.body.append(host);
    const model = createRemoteGridModel({
      source: memory,
      columns: [{ field: "id" }, { field: "host" }],
      query: { group: { by: ["region", "host"], aggregate: [] } },
    }) as unknown as RemoteGridModel;
    const grid = createRemoteGrid(host, { model, ariaLabel: "Requests" }) as unknown as RemoteGrid;
    grids.push(grid);
    models.push(model);
    model.setExpanded(["eu"], true);
    await until(() => model.row(3).kind === "group");
    grid.render();
    // Expanding eu's db group collapses eu.
    model.subscribe(() => {
      if (model.isExpanded(["eu", "db"]) && model.isExpanded(["eu"]))
        model.setExpanded(["eu"], false);
    });
    model.focusCell(3, "id");
    grid.render();
    (document.activeElement as HTMLElement | null)?.blur();
    scrollerOf(grid).focus();
    await userEvent.keyboard("{Enter}");
    expect(said(grid)).toMatch(/^web \(10\) expanded$/);
  });

  it("offer no retry for a query the source refuses", async () => {
    const { source } = synthetic(1000);
    const refusing: GridSource = {
      ...source,
      rows: () => Promise.reject(new GridSourceError("unsupported-query", "No grouping here")),
    };
    const { grid } = mount(refusing);
    await until(() => rows(grid)[0]!.state === "failed");
    const notice = grid.root.querySelector<HTMLElement>(".hg-status")!;
    expect(notice.textContent).toContain("The source refused the query: No grouping here");
    expect(notice.querySelector("button")!.hidden).toBe(true);
  });

  it("announce what the model refuses", async () => {
    const { source } = synthetic(100_000);
    const { grid, model } = mount(source);
    await until(() => rows(grid)[0]!.text === "0");
    model.select(0);
    model.scrollTo({ top: 50_000 * model.rowHeight });
    await until(() => model.row(50_005).kind === "row");
    model.select(50_005, "range");
    grid.render();
    expect(said(grid)).toBe("A range selects only rows loaded; scroll through it first");
  });

  it("pass an accessibility audit while loading", async () => {
    const { source, pause } = synthetic(1000);
    pause();
    const { grid } = mount(source);
    await frame();
    expect(rows(grid)[0]!.busy).toBe("true");
    expect(await violations(grid.root)).toEqual([]);
  });
});

/** axe's violations in `element` (WCAG 2.1 A and AA, best practices). */
async function violations(element: Element): Promise<string[]> {
  const results = await axe.run(element, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: { region: { enabled: false }, "page-has-heading-one": { enabled: false } },
  });
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations.flatMap((v) =>
    v.nodes.map((node) => `${v.id}: ${node.target.join(" ")}`),
  );
}
