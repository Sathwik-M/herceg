// What a chart shows and reports when it cannot draw: a box of its size in
// place of a frame, a banner over a last frame that is still right, an
// "error" event, `onError`, and `ready`; or with errorMode "throw", errors
// thrown where they are made.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { showFailure } from "../../src/dom/errors.ts";
import { line } from "../../src/marks/line.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { ChartError, errorInfo } from "../../src/spec/errors.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => host.remove());

const data = () => table({ t: [0, 1, 2], v: [1, 2, 3], kind: ["a", "a", "a"] });
const alert = () => host.querySelector<HTMLElement>('[role="alert"]');
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("charts that cannot draw", () => {
  it("show options they refuse in their place, at their size, and report them", async () => {
    const errors: ChartError[] = [];
    // Two marks of one id.
    const twice = [
      line(data(), { x: "t", y: "v", id: "a" }),
      line(data(), { x: "t", y: "v", id: "a" }),
    ];
    const chart = createChart(host, { marks: twice, onError: (error) => errors.push(error) });
    await expect(chart.ready).rejects.toBeInstanceOf(ChartError);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.phase).toBe("validate");
    expect(alert()!.textContent).toMatch(/^Chart could not be rendered\n.*"a" names two marks/);
    expect(alert()!.getBoundingClientRect()).toMatchObject({ width: 600, height: 300 });
    // The chart's own drawing is hidden, from input and assistive technology too.
    expect(getComputedStyle(host.querySelector("svg")!).visibility).toBe("hidden");
    expect(getComputedStyle(alert()!).visibility).toBe("visible");
    // An update fixing the options draws the chart, and the box goes.
    chart.update({ marks: twice.slice(0, 1) });
    chart.render();
    expect(alert()).toBeNull();
    expect(chart.getPanels()).toHaveLength(1);
    expect(host.querySelector("svg path")).not.toBeNull();
    chart.destroy();
  });

  it("show the chart again once an export draws options it takes", async () => {
    const twice = [
      line(data(), { x: "t", y: "v", id: "a" }),
      line(data(), { x: "t", y: "v", id: "a" }),
    ];
    const errors: ChartError[] = [];
    const chart = createChart(host, { marks: twice, onError: (error) => errors.push(error) });
    expect(alert()).not.toBeNull();
    // Options refused export nothing in their place, and are told once.
    expect(() => chart.toSVG()).toThrow(/"a" names two marks/);
    expect(errors).toHaveLength(1);
    // An update refused too is what an export refuses then.
    chart.update({ marks: twice.slice(0, 1), animation: { duration: -1 } });
    expect(() => chart.toSVG()).toThrow(/expected 0 or more ms/);
    expect(errors).toHaveLength(2);
    chart.update({ marks: twice.slice(0, 1) });
    // Drawn by the export, not a frame of the chart's own.
    expect(chart.toSVG()).toContain("<path");
    expect(alert()).toBeNull();
    expect(chart.root.style.visibility).toBe("");
    chart.destroy();
  });

  it("show and tell of a frame an export draws and cannot, and draw again after an export fails", async () => {
    const rows = table({ t: [0, 1], v: [1, 2], kind: ["a", "a"], g: ["p", "p"] });
    const errors: string[] = [];
    const chart = createChart(host, {
      marks: [line(rows, { x: "t", y: "v", series: "g", color: "kind" })],
      onError: (error) => errors.push(error.code),
    });
    await chart.ready;
    rows.append({ t: [2], v: [3], kind: ["b"], g: ["p"] });
    expect(() => chart.toSVG()).toThrow('changes within series "p"');
    expect(errors).toEqual(["series-varies"]);
    expect(alert()).not.toBeNull();
    // Data that draws, then an export that fails after drawing it: the chart shows.
    rows.reset({ t: [0, 1], v: [1, 2], kind: ["a", "a"], g: ["p", "p"] });
    expect(() => renderToPDF(chart, { pageSize: "A4", margin: 1000 })).toThrow(
      "no usable page area",
    );
    expect(alert()).toBeNull();
    expect(chart.root.style.visibility).toBe("");
    chart.destroy();
  });

  it("keep the last frame under a banner when an update is refused", async () => {
    const heard: string[] = [];
    const chart = createChart(host, { marks: [line(data(), { x: "t", y: "v" })] });
    await chart.ready;
    chart.on("error", ({ error }) => heard.push(error.message));
    const path = host.querySelector("svg path")!.getAttribute("d");
    chart.update({ animation: { duration: -1 } });
    expect(heard).toEqual([expect.stringContaining("expected 0 or more ms")]);
    expect(alert()!.textContent).toMatch(
      /^Chart update failed; showing previous data\.\n.*expected 0 or more ms/,
    );
    // The frame is the options it kept: it still draws and answers.
    chart.render();
    expect(host.querySelector("svg path")!.getAttribute("d")).toBe(path);
    expect(chart.root.style.visibility).toBe("");
    chart.update({ animation: { duration: 100 } });
    chart.render();
    expect(alert()).toBeNull();
    chart.destroy();
  });

  it("show a frame that fails on new data in its place, once, and recover with later data", async () => {
    const rows = table({ t: [0, 1], v: [1, 2], kind: ["a", "a"], g: ["p", "p"] });
    const errors: ChartError[] = [];
    const chart = createChart(host, {
      marks: [line(rows, { x: "t", y: "v", series: "g", color: "kind" })],
      onError: (error) => errors.push(error),
    });
    await chart.ready;
    // A row of another kind in series "p": a line takes one color per series.
    rows.append({ t: [2], v: [3], kind: ["b"], g: ["p"] });
    chart.render();
    expect(errors.map((e) => [e.code, e.phase])).toEqual([["series-varies", "render"]]);
    expect(alert()!.textContent).toMatch(
      /^Chart could not be rendered\n.*changes within series "p"/,
    );
    // Frames drawn again for the same data fail as quietly as the first was loud.
    chart.render();
    await frame();
    expect(errors).toHaveLength(1);
    rows.reset({ t: [0, 1], v: [1, 2], kind: ["b", "b"], g: ["p", "p"] });
    chart.render();
    expect(alert()).toBeNull();
    chart.destroy();
  });

  it("show the configuration a lazy compiler refuses, and settle ready with the first frame", async () => {
    const chart = createChart(host, {
      marks: [line(data(), { x: "t", y: "v", color: "stie" as never })],
    });
    const failed = await chart.ready.then(
      () => undefined,
      (error: ChartError) => errorInfo(error),
    );
    // Refused as it loads, or at once where a chart of the page loaded it.
    expect(failed).toMatchObject({ code: "invalid-option" });
    expect(alert()!.textContent).toContain('"stie" is neither a field nor a color');
    expect(() => chart.toSVG()).toThrow('"stie" is neither a field nor a color');
    const fine = createChart(host.appendChild(document.createElement("div")), {
      marks: [line(data(), { x: "t", y: "v", color: "kind", markers: true })],
    });
    await fine.ready;
    expect(fine.root.querySelector("svg path")).not.toBeNull();
    fine.destroy();
    chart.destroy();
  });

  it("show interaction options the controller refuses as it loads, and draw again once fixed", async () => {
    const errors: ChartError[] = [];
    const twice = { gesture: { type: "pinch" }, action: { type: "zoom" } } as const;
    const chart = createChart(host, {
      interaction: { zoom: "x", bindings: [twice, twice] },
      marks: [line(data(), { x: "t", y: "v" })],
      onError: (error) => errors.push(error),
    });
    await expect(chart.loading).rejects.toThrow("duplicates binding 0");
    expect(errors.map((e) => [e.code, e.phase])).toEqual([["invalid-option", "validate"]]);
    expect(alert()!.textContent).toMatch(/^Chart could not be rendered\n.*duplicates binding 0/);
    chart.update({ interaction: { zoom: "x" } });
    chart.render();
    expect(alert()).toBeNull();
    await chart.loading;
    chart.destroy();
  });

  it("keep fonts they refused when made out of updates, and take fonts given later", () => {
    const errors: ChartError[] = [];
    const chart = createChart(host, {
      marks: [line(data(), { x: "t", y: "v" })],
      fonts: {} as never,
      onError: (error) => errors.push(error),
    });
    expect(alert()!.textContent).toMatch(/^Chart could not be rendered\n.*fonts/);
    // The options kept still hold the fonts: the update is refused, and shown.
    expect(() => chart.update({ width: 500 })).not.toThrow();
    expect(errors).toHaveLength(2);
    expect(() => chart.toSVG()).toThrow(errors[1]!.message);
    chart.update({ fonts: undefined });
    expect(chart.toSVG()).toContain("<path");
    expect(alert()).toBeNull();
    chart.destroy();
  });

  it("tell of panels that do not fit as a layout's failure", () => {
    const errors: ChartError[] = [];
    host.style.cssText = "width:50px;height:50px";
    const chart = createChart(host, {
      panels: panels([{ id: "a" }, { id: "b" }]),
      marks: [
        line(data(), { x: "t", y: "v", panel: "a" }),
        line(data(), { x: "t", y: "v", panel: "b" }),
      ],
      onError: (error) => errors.push(error),
    });
    chart.render();
    expect(errors.map((e) => [e.code, e.phase])).toEqual([["layout-failed", "layout"]]);
    expect(() => chart.toSVG()).toThrow(expect.objectContaining({ code: "layout-failed" }));
    chart.destroy();
  });

  it("write the message as text", () => {
    const shown = showFailure(host, new Error('<img src=x onerror="alert(1)">'));
    expect(shown.querySelector("img")).toBeNull();
    expect(shown.textContent).toContain('<img src=x onerror="alert(1)">');
    shown.remove();
  });

  it("throw, made to, and report failures later than making and updating them", async () => {
    expect(() =>
      createChart(host, {
        marks: [line(data(), { x: "t", y: "v" })],
        animation: { duration: -1 },
        errorMode: "throw",
      }),
    ).toThrow(ChartError);
    expect(host.childElementCount).toBe(0);
    const rows = table({ t: [0, 1], v: [1, 2], kind: ["a", "a"], g: ["p", "p"] });
    const errors: string[] = [];
    const chart = createChart(host, {
      marks: [line(rows, { x: "t", y: "v", series: "g", color: "kind" })],
      errorMode: "throw",
      onError: (error) => errors.push(error.code),
    });
    await chart.ready;
    expect(() => chart.update({ animation: { duration: -1 } })).toThrow(ChartError);
    rows.append({ t: [2], v: [3], kind: ["b"], g: ["p"] });
    chart.render();
    expect(errors).toEqual(["series-varies"]);
    expect(alert()).toBeNull();
    chart.destroy();
  });
});
