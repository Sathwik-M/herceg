// Supplied fonts in a live chart: text measured with them, their faces
// registered with the document once, and PNG exports drawn in them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { svgToPng } from "../../src/dom/png-export.ts";
import { prepareFonts } from "../../src/fonts.ts";
import { bar } from "../../src/marks/bar.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const fixture = async (name: string) =>
  new Uint8Array(
    await (
      await fetch(new URL(`../fixtures/pdf-fonts/${name}.ttf`, import.meta.url))
    ).arrayBuffer(),
  );

const sites = table({ site: ["Alpha", "Bravo", "Charlie"], gain: [3, 5, 4] });

describe("fonts", () => {
  it("measure a live chart's text, and register their faces once for every chart", async () => {
    const fonts = prepareFonts([
      { family: "Fixture", data: await fixture("sans") },
      { family: "Fixture", weight: "bold", data: await fixture("sans-bold") },
    ]);
    const options = {
      theme: { style: { text: { font: "Fixture, sans-serif" } } },
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts,
    };
    const first = createChart(host, options);
    const second = createChart(host.appendChild(document.createElement("div")), options);
    expect(first.loading).toBeInstanceOf(Promise);
    await first.loading;
    expect(first.loading).toBeUndefined();
    const faces = [...document.fonts].filter((face) => face.family.replace(/"/g, "") === "Fixture");
    expect(faces.map((face) => [face.weight, face.status])).toEqual([
      ["400", "loaded"],
      ["700", "loaded"],
    ]);
    // The y labels' room is what the fonts measure, not what a canvas does.
    const css = modelOf(first).theme.style.tickLabel.css;
    const widest = Math.max(...["Alpha", "Bravo", "Charlie"].map((s) => fonts.measure(s, css)));
    const plot = modelOf(first).panels()[0]!.plot;
    const label = [...host.querySelectorAll("text")].find((t) => t.textContent === "Charlie")!;
    expect(Number(label.getAttribute("x"))).toBeLessThan(plot.x);
    expect(plot.x - widest).toBeGreaterThan(0);
    expect(document.fonts.check("12px Fixture", "Charlie")).toBe(true);
    first.destroy();
    second.destroy();
    // Faces stay registered for other charts and the page.
    expect(
      [...document.fonts].filter((face) => face.family.replace(/"/g, "") === "Fixture"),
    ).toHaveLength(2);
  });

  it("measure text they lack as the browser draws it, rather than refusing it", async () => {
    const fonts = prepareFonts([{ family: "Fixture", data: await fixture("sans") }]);
    const chart = createChart(host, {
      theme: { style: { text: { font: "Fixture, sans-serif" } } },
      title: "雪 report",
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts,
    });
    expect(() => fonts.measure("雪", "12px Fixture")).toThrow(/do not cover/);
    expect(host.textContent).toContain("雪 report");
    chart.destroy();
  });

  it("go into PNG exports, which see none of the page's fonts", async () => {
    const data = await fixture("sans");
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><text x="2" y="15" font-family="Fixture">Wi</text></svg>';
    const png = await svgToPng(svg, 40, 20, document, { scale: 1 }, [{ family: "Fixture", data }]);
    expect(png.type).toBe("image/png");
    expect(png.size).toBeGreaterThan(100);
  });

  it("draw unkerned, refuse another file for a family on the page, and go into the chart's PDF", async () => {
    const sans = await fixture("sans");
    const bold = await fixture("sans-bold");
    const fonts = prepareFonts([{ family: "Shared", data: sans }]);
    const theme = { style: { text: { font: "Shared, sans-serif" } } };
    const chart = createChart(host, {
      theme,
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts,
    });
    expect(chart.root.style.fontKerning).toBe("none");
    expect(chart.toSVG()).toContain('style="font-kerning:none;font-variant-ligatures:none"');
    // The same file again is the same face; another file for the family is refused.
    const again = createChart(host.appendChild(document.createElement("div")), {
      theme,
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts: prepareFonts([{ family: "Shared", data: sans.slice() }]),
    });
    expect(() =>
      createChart(host.appendChild(document.createElement("div")), {
        theme,
        marks: [],
        fonts: prepareFonts([{ family: "Shared", data: bold }]),
        errorMode: "throw",
      }),
    ).toThrow('chart fonts: the page already has a normal "Shared" face from another file');
    // Adapters comparing options as JSON see fonts by name, not their bytes.
    expect(JSON.stringify({ fonts })).toMatch(/^\{"fonts":"fonts \d+"\}$/);
    expect(JSON.stringify(fonts)).not.toBe(
      JSON.stringify(prepareFonts([{ family: "X", data: sans }])),
    );
    const { renderToPDF } = await import("../../src/pdf.ts");
    const pdf = new TextDecoder("latin1").decode(renderToPDF(chart));
    expect(pdf).toContain("/FontFile2");
    expect(() =>
      renderToPDF(chart, { fonts: prepareFonts([{ family: "Shared", data: sans }]) }),
    ).toThrow("renderToPDF fonts: a chart measures its text with other fonts");
    chart.destroy();
    again.destroy();
  });

  it("refused for another file of a family leave the chart and the page's faces as they were", async () => {
    const sans = await fixture("sans");
    const bold = await fixture("sans-bold");
    const theme = { style: { text: { font: "Kept, sans-serif" } } };
    const marks = [bar(sites, { x: "gain", y: "site" })];
    const first = createChart(host, {
      theme,
      marks,
      fonts: prepareFonts([{ family: "Kept", data: sans }]),
    });
    const chart = createChart(host.appendChild(document.createElement("div")), { theme, marks });
    const before = chart.toSVG();
    // "Fresh" is new to the page, but "Kept" comes from another file: neither is taken.
    const refused = prepareFonts([
      { family: "Fresh", data: bold },
      { family: "Kept", data: bold },
    ]);
    expect(() => chart.update({ fonts: refused, errorMode: "throw" })).toThrow(
      'a normal "Kept" face from another file',
    );
    expect(chart.toSVG()).toBe(before);
    const fresh = createChart(host.appendChild(document.createElement("div")), {
      theme,
      marks,
      fonts: prepareFonts([{ family: "Fresh", data: sans }]),
    });
    fresh.destroy();
    chart.destroy();
    first.destroy();
  });

  it("measure text they do not cover as the chart draws it, without kerning or ligatures", async () => {
    const chart = createChart(host, {
      theme: { style: { text: { font: "serif" } } },
      title: { text: "AVAV ffi ffi", style: { fontSize: 40, background: { fill: "#eeeeee" } } },
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts: prepareFonts([{ family: "Fixture", data: await fixture("sans") }]),
    });
    await chart.loading;
    // The title's box is as wide as the text was measured; the text as wide as it is drawn.
    expect(drawnAndMeasured(host, "AVAV ffi ffi")).toBeLessThan(1);
    chart.destroy();
  });

  it("measure text that needs shaping as the browser shapes it", async () => {
    const chart = createChart(host, {
      theme: { style: { text: { font: "serif" } } },
      title: { text: "سلام عليكم", style: { fontSize: 40, background: { fill: "#eeeeee" } } },
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts: prepareFonts([{ family: "Fixture", data: await fixture("sans") }]),
    });
    await chart.loading;
    expect(drawnAndMeasured(host, "سلام عليكم")).toBeLessThan(1);
    // Text that mixes both: the shaped run whole, the rest glyph by glyph.
    chart.update({
      title: { text: "سلام ffi ffi", style: { fontSize: 40, background: { fill: "#eeeeee" } } },
    });
    chart.render();
    expect(drawnAndMeasured(host, "سلام ffi ffi")).toBeLessThan(1);
    // Shaped words whose glyphs kern, which some canvases kern whatever they are told.
    chart.update({
      title: { text: "مرحبا ffi عليكم", style: { fontSize: 40, background: { fill: "#eeeeee" } } },
    });
    chart.render();
    expect(drawnAndMeasured(host, "مرحبا ffi عليكم")).toBeLessThan(1);
    chart.destroy();
  });

  it("lay out again charts without fonts whose text another chart's faces now draw", async () => {
    const theme = { style: { text: { font: "LaterPlain, monospace" } } };
    const many = table({
      name: Array.from({ length: 30 }, (_, i) => `Category ${String(i).padStart(2, "0")}`),
      value: Array.from({ length: 30 }, (_, i) => i),
    });
    const options = {
      theme,
      title: { text: "Wide title", style: { fontSize: 40, background: { fill: "#eeeeee" } } },
      marks: [bar(many, { x: "name", y: "value" })],
    };
    const plain = createChart(host, options);
    const labels = (root: Element) =>
      [...root.querySelectorAll('text[text-anchor="middle"]')].map((t) => t.textContent);
    // Another chart brings the family; it is gone before its faces load.
    const other = createChart(host.appendChild(document.createElement("div")), {
      theme,
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts: prepareFonts([{ family: "LaterPlain", data: await fixture("sans") }]),
    });
    const loading = other.loading;
    other.destroy();
    await loading;
    plain.render();
    expect(drawnAndMeasured(plain.root, "Wide title")).toBeLessThan(1);
    // Its category labels are spaced as a chart made now spaces them.
    const fresh = createChart(host.appendChild(document.createElement("div")), options);
    expect(labels(plain.root)).toEqual(labels(fresh.root));
    fresh.destroy();
    plain.destroy();
  });

  it("measure again what another chart's faces now draw", async () => {
    const theme = { style: { text: { font: "Later, monospace" } } };
    const title = { text: "Wide title", style: { fontSize: 40, background: { fill: "#eeeeee" } } };
    const first = createChart(host, {
      theme,
      title,
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts: prepareFonts([{ family: "Fixture", data: await fixture("sans") }]),
    });
    await first.loading;
    // Another chart brings the family the first one's text falls back from.
    const second = createChart(host.appendChild(document.createElement("div")), {
      theme,
      marks: [bar(sites, { x: "gain", y: "site" })],
      fonts: prepareFonts([{ family: "Later", data: await fixture("sans-bold") }]),
    });
    await second.loading;
    first.render();
    expect(drawnAndMeasured(first.root, "Wide title")).toBeLessThan(1);
    second.destroy();
    first.destroy();
  });
});

/** How far the drawn width of the boxed text `text` in `root` is from its box's. */
function drawnAndMeasured(root: Element, text: string): number {
  const drawn = [...root.querySelectorAll("text")].find((t) => t.textContent === text)!;
  const box = drawn.previousElementSibling!;
  expect(box.tagName).toBe("rect");
  return Math.abs(drawn.getComputedTextLength() - Number(box.getAttribute("width")));
}
