import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { lineDrawing } from "../../src/draw/line.ts";
import { rectDrawing } from "../../src/draw/rect.ts";
import { textDrawing } from "../../src/draw/text.ts";
import { specToPDF, specToSVG } from "../../src/from-spec.ts";
import { estimateText } from "../../src/layout/text.ts";
import { Polyline } from "../../src/lod/polyline.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { custom } from "../../src/marks/custom.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { type PdfOptions, renderToPDF } from "../../src/pdf.ts";
import { cssColor } from "../../src/render/css-color.ts";
import { cellRepeat, renderPdf } from "../../src/render/pdf.ts";
import { encodeText, standardFont, textWidth } from "../../src/render/pdf-fonts.ts";
import type {
  Geometry,
  LineGeometry,
  RectGeometry,
  Scene,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { LIGHT } from "../../src/theme.ts";

interface PdfObject {
  dictionary: string;
  /** Decoded stream data, for stream objects. */
  stream?: Buffer;
}

interface ParsedPdf {
  objects: Map<number, PdfObject>;
  trailer: string;
  /** The page's content stream as text. */
  content: string;
  page: string;
  catalog: string;
  info: string;
}

const ref = (dictionary: string, key: string): number => {
  const match = new RegExp(`/${key} (\\d+) 0 R`).exec(dictionary);
  if (!match) throw new Error(`no /${key} reference in ${dictionary}`);
  return Number(match[1]);
};

/**
 * Reads a PDF strictly: header, cross-reference offsets, every object's
 * framing, stream lengths and compression, and the references between objects.
 */
function readPdf(bytes: Uint8Array): ParsedPdf {
  const text = Buffer.from(bytes).toString("latin1");
  expect(text.startsWith("%PDF-1.4\n%âãÏÓ\n")).toBe(true);
  const end = /startxref\n(\d+)\n%%EOF\n$/.exec(text);
  expect(end).not.toBeNull();
  const xref = Number(end![1]);
  const header = /^xref\n0 (\d+)\n/.exec(text.slice(xref));
  expect(header).not.toBeNull();
  const size = Number(header![1]);
  let at = xref + header![0].length;
  const offsets: number[] = [];
  for (let id = 0; id < size; id++) {
    const entry = text.slice(at, at + 20);
    if (id === 0) expect(entry).toBe("0000000000 65535 f\r\n");
    else expect(entry).toMatch(/^\d{10} 00000 n\r\n$/);
    offsets.push(Number(entry.slice(0, 10)));
    at += 20;
  }
  const trailer = text.slice(at);
  expect(trailer).toMatch(
    new RegExp(`^trailer\\n<< /Size ${size} /Root \\d+ 0 R /Info \\d+ 0 R >>\\n`),
  );

  const objects = new Map<number, PdfObject>();
  for (let id = 1; id < size; id++) {
    const start = offsets[id]!;
    const opening = `${id} 0 obj\n`;
    expect(text.slice(start, start + opening.length), `object ${id}`).toBe(opening);
    const body = start + opening.length;
    const streamAt = text.indexOf("\nstream\n", body);
    const endAt = text.indexOf("\nendobj\n", body);
    if (streamAt >= 0 && streamAt < endAt) {
      const dictionary = text.slice(body, streamAt);
      const length = Number(/\/Length (\d+)/.exec(dictionary)![1]);
      const dataAt = streamAt + "\nstream\n".length;
      expect(text.slice(dataAt + length, dataAt + length + 18), `stream ${id} length`).toBe(
        "\nendstream\nendobj\n",
      );
      const raw = Buffer.from(bytes.subarray(dataAt, dataAt + length));
      expect(dictionary).toContain("/Filter /FlateDecode");
      objects.set(id, { dictionary, stream: inflateSync(raw) });
    } else {
      objects.set(id, { dictionary: text.slice(body, endAt) });
    }
  }
  for (const { dictionary } of objects.values()) {
    for (const [, id] of dictionary.matchAll(/(\d+) 0 R/g))
      expect(objects.has(Number(id))).toBe(true);
  }

  const catalog = objects.get(ref(trailer, "Root"))!.dictionary;
  expect(catalog).toContain("/Type /Catalog");
  const pages = objects.get(ref(catalog, "Pages"))!.dictionary;
  const kids = /\/Type \/Pages \/Kids \[(\d+) 0 R\] \/Count 1/.exec(pages);
  expect(kids).not.toBeNull();
  const page = objects.get(Number(kids![1]))!.dictionary;
  expect(page).toContain("/Type /Page ");
  const content = objects.get(ref(page, "Contents"))!.stream!.toString("latin1");
  const info = objects.get(ref(trailer, "Info"))!.dictionary;
  return { objects, trailer, content, page, catalog, info };
}

/** Index just past the "Q" that restores the graphics state saved on the line at `at`. */
function closing(content: string, at: number): number {
  let depth = 0;
  let index = content.lastIndexOf("\n", at) + 1;
  for (const line of content.slice(index).split("\n")) {
    index += line.length + 1;
    if (line === "q" || line.startsWith("q ")) depth++;
    if (line === "Q" || line.endsWith(" Q")) depth--;
    if (depth === 0) return index;
  }
  throw new Error("unbalanced q and Q");
}

/** UTF-16BE hex of a text string, as PDF writes metadata. */
const utf16 = (text: string) =>
  `<FEFF${[...text].map((c) => c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase()).join("")}>`;

const start = Date.UTC(2026, 9, 7, 8);
const metrics = table({
  t: time(Float64Array.from({ length: 12 }, (_, i) => start + i * 300_000)),
  api: [120, 135, 128, 150, 162, 158, 171, 166, 180, 175, 190, 186],
  db: [80, 82, null, 90, 95, 92, 99, 101, 98, 105, 110, 108],
});

const latency: PdfOptions = {
  width: 480,
  height: 240,
  title: "Latency é",
  description: "API and database latency.",
  timeZone: "UTC",
  locale: "en-US",
  marks: [line(metrics, { x: "t", y: ["api", "db"] }), rule({ y: 150, label: "SLO" })],
  y: { label: "ms" },
};

describe("renderPdf", () => {
  it("writes a known scene as these operators", () => {
    const path = new Polyline();
    path.push(10, 40);
    path.push(50, 10);
    path.push(90, 30);
    // A run of one point draws nothing, as in SVG.
    path.break();
    path.push(60, 60);
    const lineMark: LineGeometry = {
      kind: "line",
      key: "line",
      draw: lineDrawing,
      stroke: "#ff0000",
      strokeWidth: 2,
      dash: [4, 2],
      path,
    };
    const bars: RectGeometry = {
      kind: "rect",
      key: "bars",
      draw: rectDrawing,
      fill: "blue",
      fillOpacity: 0.5,
      rects: Float32Array.of(20, 30, 10, 15),
      count: 1,
    };
    const labels: TextGeometry = {
      kind: "text",
      key: "labels",
      draw: textDrawing,
      fill: "#000000",
      anchor: "middle",
      halo: true,
      coords: Float32Array.of(50, 20),
      labels: ["Hi"],
      count: 1,
    };
    const marks: Geometry[] = [lineMark, bars, labels];
    const scene: Scene = {
      width: 100,
      height: 50,
      pixelRatio: 1,
      theme: { ...LIGHT, background: "#ffffff" },
      title: undefined,
      panels: [
        {
          key: "",
          plot: { x: 10, y: 5, width: 80, height: 40 },
          grid: { x: [], y: [25] },
          axes: [],
          marks,
        },
      ],
      legend: [],
      colorLegend: undefined,
      vertices: 0,
    };
    const pdf = readPdf(renderPdf(scene));
    // "Hi" is 0.944 em wide in Helvetica; centered at x = 50, on a baseline 0.35 em below y = 20.
    expect(pdf.content).toBe(
      [
        "0.75 0 0 -0.75 0 37.5 cm",
        "q 1 1 1 rg",
        "0 0 100 50 re",
        "f",
        "Q",
        "q 0.882 0.878 0.851 RG 1 w 0 J 0 j 4 M",
        "10 25.5 m",
        "90 25.5 l",
        "S",
        "Q",
        "q 10 5 80 40 re W n",
        "q 1 0 0 RG 2 w 1 J 1 j [4 2] 0 d",
        "10 40 m",
        "50 10 l",
        "90 30 l",
        "S",
        "Q",
        "q /GS1 gs 0 0 1 rg",
        "20 30 10 15 re",
        "f",
        "Q",
        "Q",
        "q 0 0 0 rg 1 1 1 RG 3 w 1 j",
        "/Span << /ActualText () >> BDC BT /F1 12 Tf 1 Tr 1 0 0 -1 44.34 24.2 Tm (Hi) Tj ET EMC",
        "BT /F1 12 Tf 0 Tr 1 0 0 -1 44.34 24.2 Tm (Hi) Tj ET",
        "Q",
        "",
      ].join("\n"),
    );
    expect(pdf.page).toContain("/MediaBox [0 0 75 37.5]");
    expect(pdf.page).toContain("/ExtGState << /GS1 << /ca 0.5 /CA 1 >> >>");
    const font = pdf.objects.get(ref(pdf.page, "F1"))!.dictionary;
    expect(font).toBe(
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    );
    expect(pdf.info).toBe("<< /Producer (Herceg) >>");
  });

  it("refuses geometry it does not know and colors it cannot read", () => {
    const scene = (marks: Geometry[]): Scene => ({
      width: 10,
      height: 10,
      pixelRatio: 1,
      theme: LIGHT,
      title: undefined,
      panels: [
        {
          key: "",
          plot: { x: 0, y: 0, width: 10, height: 10 },
          grid: { x: [], y: [] },
          axes: [],
          marks,
        },
      ],
      legend: [],
      colorLegend: undefined,
      vertices: 0,
    });
    const unknown = { kind: "sparkle", key: "s", draw: rectDrawing } as unknown as Geometry;
    expect(() => renderPdf(scene([unknown]))).toThrow("cannot draw sparkle geometry");
    const rect: RectGeometry = {
      kind: "rect",
      key: "r",
      draw: rectDrawing,
      fill: "var(--accent)",
      fillOpacity: 1,
      rects: Float32Array.of(0, 0, 5, 5),
      count: 1,
    };
    expect(() => renderPdf(scene([rect]))).toThrow('cannot read the color "var(--accent)"');
  });
});

describe("renderToPDF", () => {
  it("writes a valid one-page document sized to the chart in points", () => {
    const pdf = readPdf(renderToPDF(latency));
    expect(pdf.page).toContain("/MediaBox [0 0 360 180]");
    expect(pdf.info).toBe(
      `<< /Producer (Herceg) /Title ${utf16("Latency é")} /Subject ${utf16("API and database latency.")} >>`,
    );
    expect(pdf.catalog).toContain("/Lang (en-US)");
    expect(pdf.catalog).toContain("/DisplayDocTitle true");
  });

  it("draws the chart as vector paths and real text", () => {
    const { content, page, objects } = readPdf(renderToPDF(latency));
    // The title in bold (WinAnsi é is octal 351), labels in regular Helvetica.
    expect(content).toMatch(/BT \/F2 14 Tf 0 Tr 1 0 0 -1 [\d.]+ [\d.]+ Tm \(Latency \\351\) Tj ET/);
    for (const label of ["08:00", "160", "SLO", "api", "db"]) {
      expect(content).toMatch(new RegExp(`BT /F1 12 Tf .*\\(${label}\\) Tj ET`));
    }
    // The y axis title reads bottom to top.
    expect(content).toMatch(/0 -1 -1 0 [\d.]+ [\d.]+ Tm \(ms\) Tj/);
    // Lines have round joins and caps and a subpath per run: db has a gap.
    const db = content.indexOf("q 0.922 0.408 0.204 RG 1.5 w 1 J 1 j\n");
    expect(db).toBeGreaterThan(0);
    expect(content.slice(db, content.indexOf("\nS\n", db)).match(/ m\n/g)).toHaveLength(2);
    // Data is clipped to the plot; the rule and its label come after the clip.
    const clip = content.indexOf(" re W n\n");
    const clipEnd = closing(content, clip);
    expect(clip).toBeLessThan(db);
    expect(db).toBeLessThan(clipEnd);
    expect(content.indexOf("(SLO) Tj")).toBeGreaterThan(clipEnd);
    const fonts = [...page.matchAll(/\/F\d (\d+) 0 R/g)].map(
      ([, id]) => /\/BaseFont \/([\w-]+)/.exec(objects.get(Number(id))!.dictionary)![1],
    );
    expect(fonts).toEqual(["Helvetica", "Helvetica-Bold"]);
  });

  it("is deterministic", () => {
    expect(Buffer.from(renderToPDF(latency))).toEqual(Buffer.from(renderToPDF(latency)));
  });

  it("uses opacity states for translucent marks and separate fills for translucent points", () => {
    const pts = table({ x: [1, 1, 2], y: [1, 1, 2] });
    const { content, page } = readPdf(
      renderToPDF({
        width: 200,
        height: 100,
        marks: [
          point(pts, { x: "x", y: "y", fillOpacity: 0.5 }),
          area(table({ x: [1, 2], y: [1, 2] }), { x: "x", y: "y" }),
        ],
      }),
    );
    expect(page).toMatch(/\/ExtGState << \/GS1 << \/ca 0.5 \/CA 1 >>/);
    // Three circles of four curves each, each filled on its own so overlaps darken.
    const points = content.slice(content.indexOf("/GS1 gs"));
    expect(points.split("Q")[0]!.match(/ c\n/g)).toHaveLength(12);
    expect(points.split("Q")[0]!.match(/^f$/gm)).toHaveLength(3);
  });

  it("embeds heatmaps as compressed images, with a soft mask for missing cells", () => {
    const render = (x: number[], y: number[], v: (number | null)[]) =>
      readPdf(
        renderToPDF({
          width: 300,
          height: 200,
          locale: "en-US",
          marks: [heatmap(table({ x, y, v }), { x: "x", y: "y", value: "v" })],
        }),
      );
    const size = (dictionary: string) =>
      /\/Width (\d+) \/Height (\d+)/.exec(dictionary)!.slice(1).map(Number) as [number, number];

    const full = render([0, 1, 0, 1], [0, 0, 1, 1], [1, 2, 3, 4]);
    const image = full.objects.get(ref(full.page, "Im1"))!;
    expect(image.dictionary).toMatch(
      /\/Subtype \/Image \/Width \d+ \/Height \d+ \/BitsPerComponent 8 \/Interpolate false \/ColorSpace \/DeviceRGB \/Filter \/FlateDecode/,
    );
    expect(image.dictionary).not.toContain("/SMask");
    // Placed with its first row at the top of the cells.
    const placed = /q ([\d.]+) 0 0 -([\d.]+) [\d.]+ [\d.]+ cm \/Im1 Do Q/.exec(full.content);
    expect(placed).not.toBeNull();
    // Cells wider than a pixel repeat their pixel about twice per CSS pixel,
    // so viewers that smooth images blur only cell edges.
    const [width, height] = size(image.dictionary);
    expect(width).toBe(2 * Math.ceil((Number(placed![1]) / 2) * 2));
    expect(height).toBe(2 * Math.ceil((Number(placed![2]) / 2) * 2));
    expect(image.stream).toHaveLength(width * height * 3);
    const pixel = (x: number, y: number) =>
      [...image.stream!.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)].join(",");
    expect(pixel(0, 0)).toBe(pixel(width / 2 - 1, height / 2 - 1));
    expect(pixel(0, 0)).not.toBe(pixel(width / 2, 0));
    // The color legend's ramp is an axial shading clipped to a rounded rectangle.
    expect(full.content).toMatch(/W n \/Sh1 sh Q/);
    const shading = full.objects.get(ref(full.page, "Sh1"))!.dictionary;
    expect(shading).toContain("/ShadingType 2 /ColorSpace /DeviceRGB");
    expect(shading).toContain("/FunctionType 3");

    // The missing cell is bottom right: bands of numbers run bottom to top.
    const gaps = render([0, 1, 0, 1], [0, 0, 1, 1], [1, null, 3, 4]);
    const masked = gaps.objects.get(ref(gaps.page, "Im1"))!;
    const mask = gaps.objects.get(ref(masked.dictionary, "SMask"))!;
    expect(mask.dictionary).toContain("/ColorSpace /DeviceGray");
    const [w, h] = size(mask.dictionary);
    const alpha = mask.stream!;
    expect([alpha[0], alpha[w - 1], alpha[(h - 1) * w], alpha[h * w - 1]]).toEqual([
      255, 255, 255, 0,
    ]);

    // Cells narrower than a pixel stay one pixel each.
    const columns = Array.from({ length: 1000 }, (_, i) => i);
    const fine = render(
      columns,
      columns.map(() => 0),
      columns,
    );
    expect(size(fine.objects.get(ref(fine.page, "Im1"))!.dictionary)[0]).toBe(1000);
  });

  it("keeps repeated heatmap images within their pixel budget", () => {
    const budget = 4_194_304;
    expect(cellRepeat(300, 200, 2, 2)).toEqual([300, 200]);
    expect(cellRepeat(300, 200, 1000, 1)).toEqual([1, 400]);
    // At the cell limit, a single row or column cannot repeat at all.
    expect(cellRepeat(400, 200, budget, 1)).toEqual([1, 1]);
    expect(cellRepeat(400, 200, 1, budget)).toEqual([1, 1]);
    // Wide cells in one direction shrink until the image fits.
    for (const [columns, rows] of [
      [10, 100_000],
      [100_000, 10],
      [3, 3],
      [2048, 2048],
    ] as const) {
      const [across, down] = cellRepeat(5000, 5000, columns, rows);
      expect(across * down * columns * rows).toBeLessThanOrEqual(Math.max(budget, columns * rows));
      expect(Math.min(across, down)).toBeGreaterThanOrEqual(1);
    }
  });

  it("draws custom shapes, with arcs as curves", () => {
    const { content } = readPdf(
      renderToPDF({
        width: 200,
        height: 100,
        x: { domain: [0, 1] },
        y: { domain: [0, 1] },
        marks: [
          custom({
            draw({ circle, text }) {
              circle(50, 50, 10, { fill: "rebeccapurple", stroke: "#000", opacity: 0.5 });
              text(50, 20, "note", { anchor: "start" });
            },
          }),
        ],
      }),
    );
    expect(content).toContain("/GS1 gs 0.4 0.2 0.6 rg 0 0 0 RG 1 w 0 J 0 j 4 M");
    // Filled, then stroked: "B" would knock the fill out under the translucent stroke.
    expect(content).toMatch(/(.* m\n(.* c\n){4}h\n)f\n\1S\nQ/);
    expect(content).toContain("(note) Tj");
  });

  it("keeps bar values readable with a halo that is read once", () => {
    const sales = table({ region: category(["N", "S"]), q1: [10, 20] });
    const { content } = readPdf(
      renderToPDF({
        width: 300,
        height: 150,
        marks: [bar(sales, { x: "region", y: "q1", labels: true })],
      }),
    );
    expect(content).toMatch(
      /\/Span << \/ActualText \(\) >> BDC BT [^\n]+ 1 Tr [^\n]+\(10\) Tj ET EMC/,
    );
  });

  it("renders specs like specToSVG", () => {
    const spec = {
      width: 300,
      height: 150,
      title: "Spec",
      data: { d: { columns: { x: [1, 2, 3], y: [4, 5, 6] } } },
      marks: [{ type: "line" as const, data: "d", x: "x", y: "y" }],
    };
    const pdf = readPdf(specToPDF(spec));
    expect(pdf.page).toContain("/MediaBox [0 0 225 112.5]");
    expect(specToSVG(spec)).toContain('width="300"');
    expect(pdf.content).toContain("(Spec) Tj");
  });
});

describe("PDF text", () => {
  it("measures Helvetica as the static layout estimate does, without its padding", () => {
    for (const text of ["08:00", "1,234.5", "Latency (ms)", "W@M_{}~"]) {
      expect(textWidth(encodeText(text), "Helvetica") * 12 * 1.1).toBeCloseTo(
        estimateText(text, "12px sans-serif"),
        6,
      );
    }
  });

  it("encodes text in WinAnsi, replacing what it lacks", () => {
    expect(encodeText("café €5 – 10…")).toBe("caf\xe9 \x805 \x96 10\x85");
    // Minus signs and narrow spaces from number and time formatting.
    expect(encodeText("−5 AM")).toBe("-5 AM");
    expect(encodeText("日本​")).toBe("??");
  });

  it("chooses the standard font closest to the theme's family", () => {
    expect(standardFont(LIGHT.font, false)).toBe("Helvetica");
    expect(standardFont(LIGHT.font, true)).toBe("Helvetica-Bold");
    expect(standardFont('Georgia, "Times New Roman", serif', false)).toBe("Times-Roman");
    expect(standardFont("ui-monospace, Menlo, monospace", true)).toBe("Courier-Bold");
    expect(standardFont("12px Inter, sans-serif", false)).toBe("Helvetica");
    expect(standardFont("Fancy", false)).toBe("Helvetica");
  });

  it("reads CSS colors", () => {
    expect(cssColor("#abc")).toEqual([170, 187, 204, 1]);
    expect(cssColor("#11223380")).toEqual([17, 34, 51, 128 / 255]);
    expect(cssColor(" SteelBlue ")).toEqual([70, 130, 180, 1]);
    expect(cssColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30, 0.5]);
    expect(cssColor("transparent")).toEqual([0, 0, 0, 0]);
    expect(cssColor("currentColor")).toBeUndefined();
    // Hues in any unit and direction, saturation and lightness with or without "%".
    const rounded = (color: string) => cssColor(color)?.map((c) => Math.round(c));
    for (const blue of ["hsl(-120, 100%, 50%)", "hsl(240deg 100 50)", "hsl(0.6667turn 100% 50%)"])
      expect(rounded(blue)).toEqual([0, 0, 255, 1]);
    for (const cyan of [
      "hsl(0.5turn 100% 50%)",
      "hsl(200grad 100% 50%)",
      "hsl(3.14159265rad 100% 50%)",
    ])
      expect(rounded(cyan)).toEqual([0, 255, 255, 1]);
    expect(cssColor("hsla(480, 100%, 25%, 50%)")).toEqual([0, 127.5, 0, 0.5]);
    // Out-of-range values clamp, as in CSS; other syntax is not read.
    expect(cssColor("rgb(300 -5 20 / 2)")).toEqual([255, 0, 20, 1]);
    expect(cssColor("hsl(120foo, 100%, 50%)")).toBeUndefined();
    expect(cssColor("rgb(1px, 2, 3)")).toBeUndefined();
    expect(cssColor("rgb(1, 2, 3, 4, 5)")).toBeUndefined();
  });
});

// Independent readers, where installed: the structural checks above do not
// depend on them.
function installed(tool: string): boolean {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("PDF readers", () => {
  const directory = mkdtempSync(join(tmpdir(), "herceg-pdf-"));
  afterAll(() => rmSync(directory, { recursive: true, force: true }));
  // Text, translucent fills, and a clipped panel; an image with a soft mask and a gradient.
  const chart = join(directory, "chart.pdf");
  writeFileSync(
    chart,
    renderToPDF({
      ...latency,
      marks: [...latency.marks, area(metrics, { x: "t", y: "db", fillOpacity: 0.2 })],
    }),
  );
  const cells = join(directory, "heatmap.pdf");
  writeFileSync(
    cells,
    renderToPDF({
      width: 300,
      height: 200,
      marks: [
        heatmap(table({ x: [0, 1], y: [0, 0], v: [1, null] }), { x: "x", y: "y", value: "v" }),
      ],
    }),
  );

  it.skipIf(!installed("qpdf"))("pass qpdf --check", () => {
    for (const file of [chart, cells]) {
      const output = execFileSync("qpdf", ["--check", file], { encoding: "utf8" });
      expect(output).toContain("No syntax or stream encoding errors");
    }
  });

  it.skipIf(!installed("mutool"))("render with MuPDF without warnings", () => {
    for (const file of [chart, cells]) {
      const result = spawnSync("mutool", ["draw", "-o", join(directory, "page.png"), file], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).not.toMatch(/warning|error/i);
    }
  });

  it.skipIf(!installed("pdftotext"))("extract the chart's text with Poppler", () => {
    const text = execFileSync("pdftotext", [chart, "-"], { encoding: "utf8" });
    for (const label of ["Latency é", "08:00", "SLO", "ms"]) expect(text).toContain(label);
  });
});
