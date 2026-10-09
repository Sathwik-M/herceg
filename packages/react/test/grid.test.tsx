import { rowView, table } from "herceg";
import { createGridModel, type Grid as HercegGrid } from "herceg/grid";
import { act, Profiler, StrictMode, useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { Grid } from "../src/grid.tsx";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const frames = async () => {
  await frame();
  await frame();
};

function requests(rows: number) {
  return table({
    id: Float64Array.from({ length: rows }, (_, i) => i),
    ms: Float64Array.from({ length: rows }, (_, i) => (i * 37) % 500),
  });
}

const grid = () => host.querySelector<HTMLElement>("[role=grid]")!;
const firstCells = () =>
  [...host.querySelectorAll(".hg-body [role=row]")].map(
    (row) => row.querySelector("[role=gridcell]")!.textContent,
  );

describe("<Grid>", () => {
  it("draws its model, and applies changed props without a new grid", () => {
    const model = createGridModel({
      data: rowView(requests(100)),
      columns: [{ field: "id" }, { field: "ms" }],
    });
    act(() => root.render(<Grid model={model} ariaLabel="Requests" style={{ height: 300 }} />));
    expect(grid().getAttribute("aria-label")).toBe("Requests");
    expect(grid().getAttribute("aria-rowcount")).toBe("101");
    expect(firstCells().slice(0, 3)).toEqual(["0", "1", "2"]);
    const element = grid();
    act(() =>
      root.render(<Grid model={model} ariaLabel="Latest" theme="dark" style={{ height: 300 }} />),
    );
    expect(grid()).toBe(element);
    expect(grid().getAttribute("aria-label")).toBe("Latest");
    const surface = () =>
      host.querySelector<HTMLElement>(".herceg-grid")!.style.getPropertyValue("--hg-surface");
    expect(surface()).toBe("#1b1f28");
    // A theme no longer passed is the default again.
    act(() => root.render(<Grid model={model} ariaLabel="Latest" style={{ height: 300 }} />));
    expect(surface()).toBe("#ffffff");
  });

  it("never renders React for data changes, scrolling, focus, or selection", async () => {
    const data = requests(1000);
    const model = createGridModel({
      data: rowView(data),
      columns: [{ field: "id" }, { field: "ms" }],
    });
    let commits = 0;
    act(() =>
      root.render(
        <Profiler id="grid" onRender={() => commits++}>
          <Grid model={model} ariaLabel="Requests" style={{ height: 300 }} />
        </Profiler>,
      ),
    );
    expect(commits).toBe(1);
    data.append({ id: [1000], ms: [1] });
    grid().scrollTop = 28 * 500;
    await frames();
    expect(grid().getAttribute("aria-rowcount")).toBe("1002");
    expect(firstCells()).toContain("500");
    await userEvent.click(host.querySelector(".hg-body [role=gridcell]")!);
    await userEvent.keyboard("{ArrowDown} ");
    await userEvent.click(host.querySelector("[role=columnheader]")!);
    await frames();
    expect(model.selectedCount).toBe(2);
    expect(model.sort).toEqual([{ field: "id", order: "ascending" }]);
    expect(commits).toBe(1);
  });

  it("makes a new grid for a new model and keeps its ref current", () => {
    const first = createGridModel({ data: rowView(requests(10)), columns: [{ field: "id" }] });
    const second = createGridModel({ data: rowView(requests(20)), columns: [{ field: "ms" }] });
    const ref = { current: null as HercegGrid<never> | null };
    const view = (model: typeof first) => (
      <Grid model={model} ariaLabel="Requests" ref={ref as never} />
    );
    act(() => root.render(view(first)));
    expect(ref.current?.model).toBe(first);
    act(() => root.render(view(second)));
    expect(ref.current?.model).toBe(second);
    expect(host.querySelectorAll("[role=grid]")).toHaveLength(1);
    expect(grid().getAttribute("aria-rowcount")).toBe("21");
  });

  it("mounts once under StrictMode's double effects, and leaves nothing on unmount", () => {
    const model = createGridModel({ data: rowView(requests(10)), columns: [{ field: "id" }] });
    act(() =>
      root.render(
        <StrictMode>
          <Grid model={model} ariaLabel="Requests" />
        </StrictMode>,
      ),
    );
    expect(host.querySelectorAll("[role=grid]")).toHaveLength(1);
    // Without a height, 320 pixels.
    expect(host.querySelector(".herceg-grid")!.getBoundingClientRect().height).toBe(320);
    act(() => root.render(null));
    expect(host.querySelector("[role=grid]")).toBeNull();
  });

  it("follows its table with a model made as the README makes it, under StrictMode", async () => {
    const data = requests(3);
    function Requests() {
      const model = useMemo(
        () => createGridModel({ data: rowView(data), columns: [{ field: "id" }, { field: "ms" }] }),
        [],
      );
      return <Grid model={model} ariaLabel="Requests" style={{ height: 300 }} />;
    }
    act(() =>
      root.render(
        <StrictMode>
          <Requests />
        </StrictMode>,
      ),
    );
    expect(grid().getAttribute("aria-rowcount")).toBe("4");
    data.append({ id: [3], ms: [1] });
    await frames();
    expect(grid().getAttribute("aria-rowcount")).toBe("5");
  });
});
