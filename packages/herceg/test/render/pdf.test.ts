import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { fromGeoJSON } from "../../src/data/geojson.ts";
import { table } from "../../src/data/table.ts";
import { lineDrawing } from "../../src/draw/line.ts";
import { rectDrawing } from "../../src/draw/rect.ts";
import { textDrawing } from "../../src/draw/text.ts";
import { specToPDF, specToSVG } from "../../src/from-spec.ts";
import { estimateText } from "../../src/layout/text.ts";
import { Polyline } from "../../src/lod/polyline.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { custom } from "../../src/marks/custom.ts";
import { dendrogram } from "../../src/marks/dendrogram.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { graph } from "../../src/marks/graph.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { radar } from "../../src/marks/radar.ts";
import { rug } from "../../src/marks/rug.ts";
import { rule } from "../../src/marks/rule.ts";
import { text } from "../../src/marks/text.ts";
import { violin } from "../../src/marks/violin.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { ChartModel, STATIC_RASTER_RATIO } from "../../src/model/model.ts";
import { rangeNavigator } from "../../src/model/navigator.ts";
import { panels } from "../../src/model/panels.ts";
import { type PdfOptions, pdfFonts, renderToPDF } from "../../src/pdf.ts";
import { NO_PAGE } from "../../src/render/fallbacks.ts";
import { cellRepeat, renderPdf } from "../../src/render/pdf.ts";
import { num } from "../../src/render/pdf-document.ts";
import { fontChecksum } from "../../src/render/pdf-font-binary.ts";
import { PdfFontResolver, type PdfFontSource } from "../../src/render/pdf-font-resolver.ts";
import { subsetTrueType, writeSfnt } from "../../src/render/pdf-font-subset.ts";
import { encodeText, measurePdfText, standardFont, textWidth } from "../../src/render/pdf-fonts.ts";
import { parseTrueType } from "../../src/render/pdf-truetype.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import { cssColor } from "../../src/scale/css-color.ts";
import type {
  Geometry,
  LineGeometry,
  RectGeometry,
  Scene,
  TextGeometry,
} from "../../src/scene/scene.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";
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
  pages: { id: number; page: string; content: string }[];
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
  const kids = /\/Kids \[(.*?)\] \/Count (\d+)/.exec(pages)!;
  expect(kids).not.toBeNull();
  const parsedPages = [...kids[1]!.matchAll(/(\d+) 0 R/g)].map((match) => {
    const id = Number(match[1]);
    const page = objects.get(id)!.dictionary;
    expect(page).toContain("/Type /Page ");
    expect(ref(page, "Parent")).toBe(ref(catalog, "Pages"));
    const content = objects.get(ref(page, "Contents"))!.stream!.toString("latin1");
    assertPdfNumbers(content);
    return { id, page, content };
  });
  expect(parsedPages).toHaveLength(Number(kids[2]));
  const { page, content } = parsedPages[0]!;
  const info = objects.get(ref(trailer, "Info"))!.dictionary;
  return { objects, trailer, content, page, catalog, info, pages: parsedPages };
}

/** The standard font and size `text` is written in (it must appear once, in parentheses). */
function fontOf(pdf: ParsedPdf, text: string): [string, number] {
  const shown = new RegExp(`BT /(F\\d+) ([\\d.]+) Tf [^\\n]*\\(${text}\\) Tj ET`).exec(pdf.content);
  expect(shown, text).not.toBeNull();
  const id = new RegExp(`/${shown![1]} (\\d+) 0 R`).exec(pdf.page)![1];
  const font = /\/BaseFont \/([\w-]+)/.exec(pdf.objects.get(Number(id))!.dictionary)![1]!;
  return [font, Number(shown![2])];
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
  `<FEFF${text
    .split("")
    .map((c) => c.charCodeAt(0).toString(16).padStart(4, "0").toUpperCase())
    .join("")}>`;

/** PDF tokens outside literal and hex strings; names keep their leading slash. */
function* contentTokens(content: string, strings = false): Generator<string> {
  const delimiter = /[\s\0()[\]<>/%]/;
  for (let at = 0; at < content.length; ) {
    const char = content[at]!;
    if (/[\s\0]/.test(char)) {
      at++;
    } else if (char === "%") {
      while (at < content.length && !/[\r\n]/.test(content[at]!)) at++;
    } else if (char === "(") {
      const start = at;
      let depth = 1;
      at++;
      while (at < content.length && depth > 0) {
        const next = content[at++]!;
        if (next === "\\")
          at++; // Escaped parentheses do not change nesting.
        else if (next === "(") depth++;
        else if (next === ")") depth--;
      }
      if (depth !== 0) throw new Error("Unterminated PDF literal string");
      if (strings) yield content.slice(start, at);
    } else if (char === "<" && content[at + 1] !== "<") {
      const end = content.indexOf(">", at + 1);
      if (end < 0) throw new Error("Unterminated PDF hex string");
      at = end + 1;
    } else if (content.startsWith("<<", at) || content.startsWith(">>", at)) {
      yield content.slice(at, at + 2);
      at += 2;
    } else if (delimiter.test(char) && char !== "/") {
      yield char;
      at++;
    } else {
      const start = at++;
      while (at < content.length && !delimiter.test(content[at]!)) at++;
      yield content.slice(start, at);
    }
  }
}

/** PDF numbers forbid exponent notation, unlike JavaScript Number parsing. */
function assertPdfNumbers(content: string): void {
  for (const token of contentTokens(content)) {
    if (/^[+\-.\d]/.test(token) || /^(?:NaN|Infinity)$/.test(token))
      expect(token, "PDF numeric token").toMatch(/^[+-]?(?:\d+\.?\d*|\.\d+)$/);
  }
}

const paintingOperators = [
  "f",
  "S",
  "B",
  "b",
  "f*",
  "B*",
  "b*",
  "s",
  "Do",
  "sh",
  "Tj",
  "TJ",
  "'",
  '"',
];

/** Every paint belongs to one top-level Artifact or Figure, with balanced scopes. */
function assertMarkedContent(content: string): void {
  const scopes: string[] = [];
  const containers: string[] = [];
  let operands: string[] = [];
  let figures = 0;
  for (const token of contentTokens(content)) {
    if (token === "<<" || token === "[") {
      containers.push(token);
    } else if (token === ">>" || token === "]") {
      expect(containers.pop(), "PDF dictionary/array balance").toBe(token === ">>" ? "<<" : "[");
      operands.push(token);
      continue;
    } else if (
      containers.length === 0 &&
      !token.startsWith("/") &&
      !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(token) &&
      !["true", "false", "null"].includes(token)
    ) {
      if (token === "BMC" || token === "BDC") {
        const tag = operands[0]!;
        expect(tag).toMatch(/^\//);
        if (tag === "/Artifact" && scopes.includes("/Figure"))
          throw new Error("Artifact is nested inside Figure");
        if (tag === "/Artifact" || tag === "/Figure") {
          if (scopes.length !== 0) throw new Error(`${tag} must be a top-level scope`);
          if (tag === "/Figure") {
            expect(token).toBe("BDC");
            expect(operands).toEqual(["/Figure", "<<", "/MCID", "0", ">>"]);
            figures++;
          }
        }
        scopes.push(tag);
      } else if (token === "EMC") {
        if (scopes.length === 0) throw new Error("Unmatched EMC");
        scopes.pop();
      } else if (paintingOperators.includes(token)) {
        const owners = scopes.filter((tag) => tag === "/Artifact" || tag === "/Figure");
        if (owners.length !== 1 || scopes[0] !== owners[0])
          throw new Error(`Unscoped painting operator ${token}`);
      }
      operands = [];
      continue;
    }
    operands.push(token);
  }
  if (scopes.length !== 0) throw new Error("Unclosed marked-content scope");
  expect(containers, "PDF dictionary/array balance").toEqual([]);
  expect(figures, "one Figure marked-content sequence").toBe(1);
}

function figureIds(pdf: ParsedPdf): number[] {
  const root = pdf.objects.get(ref(pdf.catalog, "StructTreeRoot"))!.dictionary;
  const document = pdf.objects.get(ref(root, "K"))!.dictionary;
  const children = /\/K (\[.*?\]|\d+ 0 R)/.exec(document)![1]!;
  return [...children.matchAll(/(\d+) 0 R/g)].map((match) => Number(match[1]));
}

function figureDictionary(pdf: ParsedPdf, index = 0): string {
  return pdf.objects.get(figureIds(pdf)[index]!)!.dictionary;
}

/** Follows both directions of every structure/content link; returns one Figure's alternative. */
function figureAlt(pdf: ParsedPdf, index = 0): string {
  expect(pdf.catalog).toContain("/MarkInfo << /Marked true >>");
  const rootId = ref(pdf.catalog, "StructTreeRoot");
  const root = pdf.objects.get(rootId)!.dictionary;
  expect(root).toContain("/Type /StructTreeRoot");
  expect(root).toContain(`/ParentTreeNextKey ${pdf.pages.length}`);
  const documentId = ref(root, "K");
  const document = pdf.objects.get(documentId)!.dictionary;
  expect(document).toContain("/Type /StructElem /S /Document");
  expect(ref(document, "P")).toBe(rootId);
  expect(
    [...pdf.objects.values()].filter((o) => /\/S \/Document\b/.test(o.dictionary)),
  ).toHaveLength(1);
  const figures = figureIds(pdf);
  expect(figures).toHaveLength(pdf.pages.length);
  expect([...pdf.objects.values()].filter((o) => /\/S \/Figure\b/.test(o.dictionary))).toHaveLength(
    pdf.pages.length,
  );
  const entries = pdf.pages.map(({ id, page, content }, i) => {
    const figure = pdf.objects.get(figures[i]!)!.dictionary;
    expect(figure).toContain("/Type /StructElem /S /Figure");
    expect(ref(figure, "P")).toBe(documentId);
    expect(ref(figure, "Pg")).toBe(id);
    expect(figure).toMatch(/\/K 0\b/);
    expect(page).toContain(`/StructParents ${i} `);
    assertMarkedContent(content);
    return `${i} [${figures[i]} 0 R]`;
  });
  const parents = pdf.objects.get(ref(root, "ParentTree"))!.dictionary;
  expect(parents).toBe(`<< /Nums [${entries.join(" ")}] >>`);
  const alt = /\/Alt <FEFF([\dA-F]*)>/.exec(figureDictionary(pdf, index))!;
  return Buffer.from(alt[1]!, "hex").swap16().toString("utf16le");
}

const fontFixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`../fixtures/pdf-fonts/${name}.ttf`, import.meta.url)));
const embeddedFonts: PdfFontSource[] = [
  { family: "Fixture", data: fontFixture("sans") },
  { family: "Fixture", weight: "bold", data: fontFixture("sans-bold") },
  { family: "Symbols", data: fontFixture("symbols") },
];
const unicodeText = "é Δ Ω Мир 𝌀";

function fontTableOffset(data: Uint8Array, tag: string): number {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < view.getUint16(4); i++) {
    const at = 12 + i * 16;
    if (String.fromCharCode(...data.subarray(at, at + 4)) === tag) return view.getUint32(at + 8);
  }
  throw new Error(`Missing ${tag}`);
}

function embeddingFlags(flags: number): Uint8Array {
  const data = fontFixture("sans");
  new DataView(data.buffer).setUint16(fontTableOffset(data, "OS/2") + 8, flags);
  return data;
}

function unicodeScene(text = unicodeText): Scene {
  return {
    width: 320,
    height: 120,
    pixelRatio: 1,
    theme: { ...LIGHT, font: "Fixture", background: "white" },
    title: undefined,
    headers: [{ text, x: 160, y: 60, anchor: "middle", angle: 0 }],
    panels: [],
    legend: [],
    colorLegends: [],
    glyphLegends: [],
    vertices: 0,
  };
}

function embeddedPrograms(pdf: ParsedPdf): Uint8Array[] {
  return [...pdf.objects.values()]
    .filter((obj) => obj.dictionary.includes("/Length1 "))
    .map((obj) => obj.stream!);
}

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
  y: { title: "ms" },
};

describe("PDF marked-content assertions", () => {
  const valid = String.raw`
    /Artifact BMC 0 0 10 10 re f EMC
    /Figure << /MCID 0 >> BDC
    % EMC /Artifact BMC Do
    BT (EMC (BMC) \(BDC\) \\ Tj) Tj [<BDC> 0 (EMC)] TJ ET
    /Span << /ActualText (EMC) >> BDC (text) Tj EMC
    EMC
  `;

  it("skips strings, escaped parentheses, hex strings, and comments", () => {
    expect(() => assertMarkedContent(valid)).not.toThrow();
  });

  it("rejects deliberately malformed content streams", () => {
    for (const operator of paintingOperators)
      expect(() => assertMarkedContent(`${operator}\n${valid}`)).toThrow(
        `Unscoped painting operator ${operator}`,
      );
    expect(() => assertMarkedContent("/Figure << /MCID 0 >> BDC /Artifact BMC f EMC EMC")).toThrow(
      "Artifact is nested inside Figure",
    );
    expect(() => assertMarkedContent("/Artifact BMC /Figure << /MCID 0 >> BDC f EMC EMC")).toThrow(
      "/Figure must be a top-level scope",
    );
    expect(() => assertMarkedContent("/Span BMC f EMC")).toThrow("Unscoped painting operator f");
    expect(() => assertMarkedContent(`${valid}\nEMC`)).toThrow("Unmatched EMC");
    expect(() => assertMarkedContent("/Figure << /MCID 0 >> BDC f")).toThrow(
      "Unclosed marked-content scope",
    );
  });
});

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
      headers: [],
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
      colorLegends: [],
      glyphLegends: [],
      vertices: 0,
    };
    const pdf = readPdf(renderPdf(scene));
    // "Hi" is 0.944 em wide in Helvetica; centered at x = 50, on a baseline 0.35 em below y = 20.
    expect(pdf.content).toBe(
      [
        "0.75 0 0 -0.75 0 37.5 cm",
        "/Artifact BMC",
        "q 1 1 1 rg",
        "0 0 100 50 re",
        "f",
        "Q",
        "q 0.91 0.922 0.941 RG 1 w 0 J 0 j 4 M",
        "10 25.5 m",
        "90 25.5 l",
        "S",
        "Q",
        "EMC",
        "/Figure << /MCID 0 >> BDC",
        "q 10 5 80 40 re W n",
        "q 1 0 0 RG 2 w 1 J 1 j [4 2] 0 d",
        "10 40 m",
        "50 10 l",
        "90 30 l",
        "60 60 m",
        "60 60 l",
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
        "EMC",
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
    expect(figureAlt(pdf)).toBe("");
  });

  it("refuses geometry it does not know and colors it cannot read", () => {
    const scene = (marks: Geometry[]): Scene => ({
      width: 10,
      height: 10,
      headers: [],
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
      colorLegends: [],
      glyphLegends: [],
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
  it("exports dense navigator bars as column envelopes", () => {
    const data = table({
      t: Float64Array.from({ length: 5000 }, (_, i) => i),
      v: Float64Array.from({ length: 5000 }, (_, i) => (i % 2 ? -10 : 15)),
    });
    const options = {
      width: 600,
      height: 300,
      marks: [bar(data, { x: "t", y: "v" })],
      x: { show: false },
      y: { domain: [-20, 20] as const },
    };
    const empty = readPdf(renderToPDF({ ...options, navigator: rangeNavigator({ marks: [] }) }));
    const drawn = readPdf(renderToPDF({ ...options, navigator: rangeNavigator() }));
    const rectangles = (pdf: ParsedPdf) => pdf.content.match(/ re\n/g)?.length ?? 0;
    // Both PDFs draw the same 5,000 main bars and strip frame. Only the
    // overview differs: at most one rectangle per sign and CSS column.
    const added = rectangles(drawn) - rectangles(empty);
    expect(added).toBeGreaterThan(500);
    expect(added).toBeLessThanOrEqual(1200);
  });

  it.each([false, true])(
    "exports signed stack colors and proportions with reversed y=%s",
    (reversed) => {
      const data = table({
        t: Float64Array.from({ length: 5000 }, (_, i) => i),
        a: Float64Array.from({ length: 5000 }, (_, i) => [6, 1, -4, -8][i % 4]!),
        b: Float64Array.from({ length: 5000 }, (_, i) => [4, 8, -7, -1][i % 4]!),
      });
      const options = {
        width: 600,
        height: 300,
        marks: [bar(data, { x: "t", y: ["a", "b"], stack: true })],
        x: { show: false },
        y: { show: false, domain: (reversed ? [20, -20] : [-20, 20]) as [number, number] },
        navigator: rangeNavigator(),
        theme: { palette: ["#ff0000", "#0000ff"] },
        legend: false as const,
      };
      const model = new ChartModel(options);
      model.setSize(600, 300, 1);
      const strip = model.scene(estimateText).panels.find((p) => p.key === "navigator")!;
      const bars = strip.marks.filter((g): g is RectGeometry => g.kind === "rect");
      expect(bars.map((g) => g.fill)).toEqual(["#ff0000", "#0000ff"]);
      const pdf = readPdf(renderToPDF(options));
      const clip = `${[strip.plot.x, strip.plot.y, strip.plot.width, strip.plot.height].map((v) => num(v)).join(" ")} re W n`;
      const start = pdf.content.lastIndexOf(clip);
      expect(start).toBeGreaterThan(0);
      const content = pdf.content.slice(start);
      const fills = [
        ...content.matchAll(/q [^\n]*?([01] [01] [01]) rg\n((?:[-\d. ]+ re\n)+)f\nQ/g),
      ];
      expect(fills.map((match) => match[1])).toEqual(["1 0 0", "0 0 1"]);
      bars.forEach((g, i) => {
        const rectangles = Array.from(
          { length: g.count },
          (_, row) =>
            `${Array.from(g.rects.subarray(row * 4, row * 4 + 4), (v) => num(v)).join(" ")} re\n`,
        ).join("");
        expect(fills[i]![2]).toBe(rectangles);
      });
    },
  );

  it.each([false, true])(
    "tags the full chart with its DOM description (embedded fonts: %s)",
    (embedded) => {
      const options: PdfOptions = {
        ...latency,
        title: "Latency é (EMC)",
        // Metadata must retain Unicode even when standard fonts replace visible glyphs.
        description: "API (requests) \\ Δ 𝌀.\nDatabase latency.",
        theme: { font: "Fixture", background: "white" },
        ...(embedded && { fonts: pdfFonts(embeddedFonts, { fallback: ["Symbols"] }) }),
      };
      const model = new ChartModel(options, NO_PAGE);
      model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
      model.scene(options.fonts?.createResolver().measure ?? measurePdfText);
      const pdf = readPdf(renderToPDF(options));
      expect(figureAlt(pdf)).toBe(`${options.title} ${describeChart(model)}`);
      expect(pdf.catalog).toContain("/Lang (en-US)");
      const decoration = /\/Artifact BMC\n([\s\S]*?)EMC\n/.exec(pdf.content)![1]!;
      expect(decoration).toContain("0 0 480 240 re\n");
      expect(decoration).toContain(`RG 1 w 0 J 0 j 4 M\n`);
      expect(decoration).not.toMatch(/\/MCID|\bBT\b|\bDo\b/);
      const drawing = /\/Figure << \/MCID 0 >> BDC\n([\s\S]*)EMC\n$/.exec(pdf.content)![1]!;
      expect(drawing).toContain(" re W n\n");
      expect(drawing).toContain(" Tj ET\n");
      expect([...pdf.objects.values()].some((o) => o.dictionary.includes("/Subtype /Type0"))).toBe(
        embedded,
      );
    },
  );

  it.each([false, true])(
    "sets the language of English summaries (embedded fonts: %s)",
    (embedded) => {
      for (const locale of ["fr-FR", "en-GB", "EN-gb", undefined]) {
        const pdf = readPdf(
          renderToPDF({
            width: 300,
            height: 150,
            ...(locale !== undefined && { locale }),
            marks: [line(metrics, { x: "t", y: "api" })],
            theme: { font: "Fixture" },
            ...(embedded && { fonts: pdfFonts(embeddedFonts) }),
          }),
        );
        expect(figureAlt(pdf)).toMatch(/^Line chart with 1 series\./);
        if (locale) expect(pdf.catalog).toContain(`/Lang (${locale})`);
        else expect(pdf.catalog).not.toContain("/Lang");
        if (locale?.toLowerCase() === "en-gb") expect(figureDictionary(pdf)).not.toContain("/Lang");
        else expect(figureDictionary(pdf)).toContain("/Lang (en)");
      }
      const empty = readPdf(
        renderToPDF({ width: 100, height: 50, marks: [], title: "Vide", locale: "fr-FR" }),
      );
      expect(figureAlt(empty)).toBe("Vide");
      expect(figureDictionary(empty)).not.toContain("/Lang");
    },
  );

  it.each([false, true])(
    "keeps raster heatmaps and ramps inside the Figure (embedded fonts: %s)",
    (embedded) => {
      const pdf = readPdf(
        renderToPDF({
          width: 300,
          height: 200,
          title: "Heatmap (EMC)",
          marks: [
            heatmap(table({ x: [0, 1], y: [0, 0], v: [1, null] }), {
              x: "x",
              y: "y",
              color: "v",
            }),
          ],
          theme: { font: "Fixture" },
          ...(embedded && { fonts: pdfFonts(embeddedFonts) }),
        }),
      );
      expect(figureAlt(pdf)).toContain("Heatmap (EMC)");
      expect(pdf.content).toContain("/Im1 Do");
      expect(pdf.content).toContain("/Sh1 sh");
    },
  );

  it.each([false, true])("keeps label halos inside the Figure (embedded fonts: %s)", (embedded) => {
    const pdf = readPdf(
      renderToPDF({
        width: 300,
        height: 150,
        title: "Values (EMC)",
        marks: [
          bar(table({ region: category(["N", "S"]), q1: [10, 20] }), {
            x: "region",
            y: "q1",
            labels: true,
          }),
        ],
        theme: { font: "Fixture" },
        ...(embedded && { fonts: pdfFonts(embeddedFonts) }),
      }),
    );
    expect(figureAlt(pdf)).toContain("Values (EMC)");
    expect(pdf.content).toContain("/Span << /ActualText () >> BDC BT");
    expect(pdf.content).toContain(" 1 Tr ");
  });

  it.each([false, true])("keeps subplots in one Figure (embedded fonts: %s)", (embedded) => {
    const pdf = readPdf(
      renderToPDF({
        width: 400,
        height: 300,
        title: "Subplots (EMC)",
        marks: [
          line(metrics, { x: "t", y: "api", panel: "api" }),
          line(metrics, { x: "t", y: "db", panel: "db" }),
        ],
        panels: panels([
          { id: "api", title: "API" },
          { id: "db", title: "Database" },
        ]),
        theme: { font: "Fixture" },
        ...(embedded && { fonts: pdfFonts(embeddedFonts) }),
      }),
    );
    const alt = figureAlt(pdf);
    expect(alt).toContain("Subplots (EMC)");
    expect(alt).toContain("Panels: API, Database.");
    expect(pdf.content.match(/ re W n\n/g)).toHaveLength(2);
  });

  it.each([false, true])(
    "keeps facets in one figure with the complete summary (embedded fonts: %s)",
    (embedded) => {
      const data = table({
        x: [0, 1, 0, 1],
        y: [1, 2, 3, 4],
        region: category(["North", "North", "South", "South"]),
      });
      const options: PdfOptions = {
        width: 400,
        height: 300,
        title: "Sales (EMC)",
        locale: "fr-FR",
        marks: [line(data, { x: "x", y: "y" })],
        facet: facet({ row: "region" }),
        theme: { font: "Fixture", background: "transparent" },
        ...(embedded && { fonts: pdfFonts(embeddedFonts) }),
      };
      const model = new ChartModel(options, NO_PAGE);
      model.setSize(options.width, options.height, 1, STATIC_RASTER_RATIO);
      model.scene(options.fonts?.createResolver().measure ?? measurePdfText);
      const pdf = readPdf(renderToPDF(options));
      const alt = figureAlt(pdf);
      expect(alt).toBe(`${options.title} ${describeChart(model)}`);
      expect(alt).toContain("North");
      expect(alt).toContain("South");
      expect(pdf.content.match(/ re W n\n/g)).toHaveLength(2);
      expect(pdf.catalog).toContain("/Lang (fr-FR)");
      expect(figureDictionary(pdf)).toContain("/Lang (en)");
    },
  );

  it("describes an untitled chart and tags an empty chart", () => {
    const { title: _title, description: _description, ...untitled } = latency;
    expect(figureAlt(readPdf(renderToPDF(untitled)))).toMatch(/^Line chart with 2 series\./);
    const empty = readPdf(renderToPDF({ width: 100, height: 50, marks: [], title: "Empty" }));
    expect(figureAlt(empty)).toBe("Empty");
    expect(empty.catalog).not.toContain("/Lang");
  });

  it("paints transparent themes with light text dark, as pages are white", () => {
    const background = (theme: NonNullable<PdfOptions["theme"]>) =>
      /\/Artifact BMC\n(q [\d. ]+ rg)\n0 0 100 50 re\nf\n/.exec(
        readPdf(renderToPDF({ width: 100, height: 50, marks: [], theme })).content,
      )?.[1];
    for (const text of ["#ffffff", "white", "hsl(0 0% 95%)"])
      expect(background({ extends: "dark", background: "transparent", text }), text).toBe(
        "q 0 0 0 rg",
      );
    expect(background({ background: "transparent" })).toBeUndefined();
    expect(background({ background: "#123456", text: "black" })).toBe("q 0.071 0.204 0.337 rg");
  });

  it("writes a valid one-page document sized to the chart in points", () => {
    const pdf = readPdf(renderToPDF(latency));
    expect(pdf.page).toContain("/MediaBox [0 0 360 180]");
    expect(pdf.info).toBe(
      `<< /Producer (Herceg) /Title ${utf16("Latency é")} /Subject ${utf16("API and database latency.")} >>`,
    );
    expect(pdf.catalog).toContain("/Lang (en-US)");
    expect(pdf.catalog).toContain("/DisplayDocTitle true");
  });

  it("draws facet headers in bold, row headers reading top to bottom", () => {
    const sales = table({
      x: [0, 1, 0, 1],
      y: [1, 2, 3, 4],
      region: category(["North", "North", "South", "South"]),
      product: category(["A", "B", "A", "B"]),
    });
    const { content } = readPdf(
      renderToPDF({
        marks: [line(sales, { x: "x", y: "y" })],
        facet: facet({ row: "region", column: "product" }),
        width: 400,
        height: 300,
      }),
    );
    expect(content).toMatch(/BT \/F2 12 Tf 0 Tr 1 0 0 -1 [\d.]+ [\d.]+ Tm \(A\) Tj ET/);
    expect(content).toMatch(/BT \/F2 12 Tf 0 Tr 0 1 1 0 [\d.]+ [\d.]+ Tm \(North\) Tj ET/);
  });

  it("draws the chart as vector paths and real text", () => {
    const { content, page, objects } = readPdf(renderToPDF(latency));
    // The title in bold (WinAnsi é is octal 351), labels in regular Helvetica.
    expect(content).toMatch(/BT \/F2 15 Tf 0 Tr 1 0 0 -1 [\d.]+ [\d.]+ Tm \(Latency \\351\) Tj ET/);
    for (const label of ["08:00", "160", "SLO", "api", "db"]) {
      expect(content).toMatch(new RegExp(`BT /F1 12 Tf .*\\(${label}\\) Tj ET`));
    }
    // The y axis title reads bottom to top.
    expect(content).toMatch(/0 -1 -1 0 [\d.]+ [\d.]+ Tm \(ms\) Tj/);
    // Lines have round joins and caps and a subpath per run: db has a gap.
    const db = content.indexOf("q 0.925 0.416 0.173 RG 2 w 1 J 1 j\n");
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

  it("draws encoded points, symbol swatches, keys, and diverging ramps as the SVG does", () => {
    const pts = table({
      x: [1, 2, 3, 4],
      y: [1, 2, 3, 4],
      s: [10, 20, 40, 80],
      v: [-1, 0, 1, 3],
      kind: ["a", "b", "a", "b"],
    });
    const { content, objects } = readPdf(
      renderToPDF({
        width: 400,
        height: 240,
        locale: "en-US",
        marks: [
          point(pts, { x: "x", y: "y", size: "s", color: "v", colorMidpoint: 0, symbol: "kind" }),
        ],
      }),
    );
    // One opaque fill per color: four values, four colors.
    const fills = content.match(/^q [\d.]+ [\d.]+ [\d.]+ rg\n(?:[^q]*?)f\nQ$/gm) ?? [];
    expect(fills.length).toBeGreaterThanOrEqual(4);
    // The square of "b" is straight lines; the circle of "a" is curves.
    expect(content).toMatch(/ l\n/);
    expect(content).toMatch(/ c\n/);
    // Size and shape keys label their glyphs.
    for (const label of ["s", "kind", "a", "b"]) expect(content).toContain(`(${label}) Tj`);
    // The diverging ramp puts its middle stop at the midpoint: 0 is a quarter of [-1, 3].
    const shading = [...objects.values()].find((o) => o.dictionary.includes("/ShadingType 2"))!;
    const bounds = /\/Bounds \[([^\]]*)\]/.exec(shading.dictionary)![1]!.split(" ").map(Number);
    expect(bounds).toContain(0.25);
  });

  it("draws monotone curves as cubic curves", () => {
    const wave = table({ x: [0, 1, 2, 3], y: [0, 3, 1, 2] });
    const { content } = readPdf(
      renderToPDF({
        width: 300,
        height: 150,
        marks: [line(wave, { x: "x", y: "y", curve: "monotone" })],
      }),
    );
    // Three segments, each one curve (nothing else in the chart is curved).
    expect(content.match(/ c\n/g)).toHaveLength(3);
  });

  it("draws pie slices as cubic curves of at most a quarter turn, on the circle", () => {
    const halves = table({ k: ["a", "b"], v: [1, 1] });
    const { content } = readPdf(
      renderToPDF({
        width: 300,
        height: 200,
        legend: false,
        marks: [pie(halves, { category: "k", value: "v", innerRadius: 0.5, labels: false })],
      }),
    );
    // Each half: two quarter turns outside, two inside.
    const ends = [...content.matchAll(/(-?[\d.]+) (-?[\d.]+) c\n/g)].map(([, x, y]) => [
      Number(x),
      Number(y),
    ]);
    expect(ends).toHaveLength(8);
    // The pie fills the room below the 8 px header: centered at (150, 100), radii 90 and 45.
    const radii = ends.map(([x, y]) => Math.round(Math.hypot(x! - 150, y! - 100)));
    expect([...new Set(radii)].sort()).toEqual([45, 90]);
  });

  it("writes a gauge's value in bold, larger than its labels", () => {
    const pdf = readPdf(
      renderToPDF({
        width: 300,
        height: 200,
        locale: "en-US",
        marks: [gauge(table({ cpu: [61.5] }), { value: "cpu", label: "CPU" })],
      }),
    );
    const [valueFont, valueSize] = fontOf(pdf, "61.5");
    expect(valueFont).toBe("Helvetica-Bold");
    expect(valueSize).toBeGreaterThan(30);
    for (const label of ["CPU", "0", "100"]) expect(fontOf(pdf, label)).toEqual(["Helvetica", 12]);
  });

  it("writes a funnel's names and values, over faint connectors", () => {
    const stages = table({ stage: ["Visit", "Cart", "Purchase"], users: [2000, 1200, 300] });
    const pdf = readPdf(
      renderToPDF({
        width: 400,
        height: 300,
        locale: "en-US",
        marks: [funnel(stages, { category: "stage", value: "users" })],
      }),
    );
    for (const name of ["Visit", "Cart", "Purchase"])
      expect(fontOf(pdf, name)).toEqual(["Helvetica", 12]);
    // "2,000 · 100%", with the middle dot in WinAnsi (octal 267).
    expect(pdf.content).toContain("(2,000 \\267 100%) Tj");
    // The connectors are one fill in the bars' color at 15% opacity.
    const state = /\/(GS\d+) << \/ca 0.15 /.exec(pdf.page)!;
    expect(state).not.toBeNull();
    expect(pdf.content).toMatch(new RegExp(`q /${state[1]} gs 0.196 0.4 0.839 rg\n`));
  });

  it("draws radars: spoke names and ring values as text, translucent fills under outlines", () => {
    const players = table({ name: ["Ana", "Bo"], speed: [8, 5], power: [6, 9], range: [4, 7] });
    const radarPdf = readPdf(
      renderToPDF({
        width: 400,
        height: 300,
        locale: "en-US",
        marks: [radar(players, { fields: ["speed", "power", "range"], series: "name" })],
      }),
    );
    for (const label of ["speed", "power", "range", "10", "Ana", "Bo"])
      expect(radarPdf.content).toContain(`(${label}) Tj`);
    // Each polygon closed and filled at 15% opacity, before any outline.
    expect(radarPdf.page).toContain("/ca 0.15");
    const fills = [...radarPdf.content.matchAll(/\/GS\d+ gs [\d. ]+ rg\n[^Q]*\nh\nf\nQ\n/g)];
    expect(fills).toHaveLength(2);
  });

  it("draws networks: translucent links, ringed circles as curves, and names with halos", () => {
    const talks = table({ from: ["Ana", "Ana", "Bo"], to: ["Bo", "Cy", "Cy"], n: [1, 2, 3] });
    const people = table({ name: ["Ana", "Bo", "Cy"], team: ["Data", "Data", "Sales"] });
    const pdf = readPdf(
      renderToPDF({
        width: 400,
        height: 300,
        locale: "en-US",
        marks: [
          graph(talks, {
            source: "from",
            target: "to",
            value: "n",
            nodes: people,
            node: "name",
            color: "team",
          }),
        ],
      }),
    );
    // Links stroke at 45% opacity: two muted between teams, one in Data's color.
    const state = /\/(GS\d+) << (?:\/ca [\d.]+ )?\/CA 0.45 >>/.exec(pdf.page)!;
    expect(state).not.toBeNull();
    expect(
      pdf.content.match(new RegExp(`q /${state[1]} gs [\\d. ]+ RG [\\d.]+ w`, "g")),
    ).toHaveLength(3);
    // Each node: a circle of four curves, filled in its group's color, then ringed in white.
    const nodes = [
      ...pdf.content.matchAll(/q ([\d. ]+) rg 1 1 1 RG 1.5 w[^Q]*?\nf\n[^Q]*?\nS\nQ/g),
    ];
    expect(nodes).toHaveLength(3);
    for (const [node] of nodes) expect(node.match(/ c\n/g)).toHaveLength(8);
    for (const name of ["Ana", "Bo", "Cy"]) expect(fontOf(pdf, name)).toEqual(["Helvetica", 12]);
  });

  it("draws maps: regions filled even-odd and bordered, points ringed one by one", () => {
    const square = (x: number, s: number) => [
      [x, 0],
      [x + s, 0],
      [x + s, s],
      [x, s],
      [x, 0],
    ];
    const regions = fromGeoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { v: 1 },
          geometry: { type: "Polygon", coordinates: [square(0, 10), square(3, 2)] },
        },
        {
          type: "Feature",
          properties: { v: 2 },
          geometry: { type: "Polygon", coordinates: [square(10, 10)] },
        },
      ],
    });
    const places = table({ lon: [5, 15], lat: [5, 5], n: [1, 4] });
    const pdf = readPdf(
      renderToPDF({
        width: 400,
        height: 240,
        locale: "en-US",
        projection: "equirectangular",
        marks: [
          geoshape(regions, { color: "v" }),
          geopoint(places, { longitude: "lon", latitude: "lat", size: "n", fillOpacity: 1 }),
        ],
      }),
    );
    // Each region: its rings (a lake inside the first) filled with the even-odd rule, then bordered.
    const regionsDrawn = [
      ...pdf.content.matchAll(/q [\d. ]+ rg 1 1 1 RG 0.75 w 0 J 1 j\n([^Q]*?)f\*\n[^Q]*?S\nQ/g),
    ];
    expect(regionsDrawn).toHaveLength(2);
    expect(regionsDrawn[0]![1]!.match(/ m\n/g)).toHaveLength(2);
    // Each point: filled, then ringed in white.
    const pointsDrawn = [
      ...pdf.content.matchAll(/q [\d. ]+ rg 1 1 1 RG 1 w[^Q]*? c\nf\n[^Q]*? c\nS\nQ/g),
    ];
    expect(pointsDrawn).toHaveLength(2);
  });

  it("joins point outlines round, and outlines hollow points' legend swatches", () => {
    const data = table({ x: [1, 2], y: [1, 2], kind: ["a", "b"] });
    const hollow = point(data, {
      x: "x",
      y: "y",
      series: "kind",
      symbol: "triangle",
      fill: "transparent",
      stroke: "#000000",
      strokeWidth: 2,
    });
    const pdf = readPdf(renderToPDF({ width: 300, height: 200, locale: "en-US", marks: [hollow] }));
    // Two points, then two swatches, each stroked in black.
    expect(pdf.content.match(/0 0 0 RG 2 w 0 J 1 j\n/g)).toHaveLength(2);
    expect(pdf.content.match(/0 0 0 RG 1 w 0 J 1 j\n/g)).toHaveLength(2);
  });

  it("embeds heatmaps as compressed images, with a soft mask for missing cells", () => {
    const render = (x: number[], y: number[], v: (number | null)[]) =>
      readPdf(
        renderToPDF({
          width: 300,
          height: 200,
          locale: "en-US",
          marks: [heatmap(table({ x, y, v }), { x: "x", y: "y", color: "v" })],
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

    // Cells narrower than a pixel stay one pixel each, up to two per CSS
    // pixel; past that, pixels show blocks of cells.
    const imageWidth = (count: number) => {
      const columns = Array.from({ length: count }, (_, i) => i);
      const pdf = render(
        columns,
        columns.map(() => 0),
        columns,
      );
      return size(pdf.objects.get(ref(pdf.page, "Im1"))!.dictionary)[0];
    };
    const plotWidth = Number(placed![1]);
    expect(imageWidth(400)).toBe(400);
    expect(imageWidth(1000)).toBe(Math.floor(plotWidth * 2));
  });

  it("keeps repeated heatmap images within their pixel budget", () => {
    const budget = 4_194_304;
    expect(cellRepeat(300, 200, 2, 2)).toEqual([300, 200]);
    expect(cellRepeat(300, 200, 1000, 1)).toEqual([1, 400]);
    // At the pixel budget, a single row or column cannot repeat at all.
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

  it("draws rugs as vector segments in PDF and static SVG", () => {
    const marks = [rug(table({ v: [1, 2, 3] }), { x: "v", stroke: "#123456", strokeWidth: 2 })];
    const { content } = readPdf(renderToPDF({ marks, width: 300, height: 150 }));
    const svg = renderToSVG({ marks, width: 300, height: 150 });
    expect(svg).toContain('stroke="#123456"');
    expect(svg).toContain('stroke-width="2"');
    expect(content).toContain("2 w");
    // One path contains every observation's move and line, then is stroked.
    expect(content).toMatch(/(?:[\d.]+ [\d.]+ m\n[\d.]+ [\d.]+ l\n){3}S/);
  });

  it("omits zero-width rug strokes instead of PDF hairlines", () => {
    const { content } = readPdf(
      renderToPDF({
        width: 300,
        height: 150,
        marks: [rug(table({ v: [1, 2] }), { x: "v", strokeWidth: 0 })],
      }),
    );
    expect(content).not.toContain("0 w");
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

describe("PDF seams", () => {
  it("draws a clipped one-pixel seam with its own style before the data", () => {
    const data = table({ t: time([0, 20]), v: [1, 2] });
    const { content } = readPdf(
      renderToPDF({
        width: 400,
        height: 200,
        marks: [line(data, { x: "t", y: "v", stroke: "#0000ff" })],
        x: { domain: [0, 20], breaks: timeBreaks([{ from: 4, to: 8 }]), seams: true },
        theme: { grid: "#ff0000" },
      }),
    );
    const seam = "q 1 0 0 RG 1 w 0 J 0 j 4 M [3 3] 0 d";
    expect(content).toContain(seam);
    expect(content.indexOf("re W n")).toBeLessThan(content.indexOf(seam));
    expect(content.indexOf(seam)).toBeLessThan(content.indexOf("0 0 1 RG 2 w"));
    expect(content.slice(content.indexOf(seam))).toMatch(/m\n[\d. ]+ l\nS\nQ/);
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

describe("PDF embedded Unicode fonts", () => {
  const resolver = () => new PdfFontResolver({ fonts: embeddedFonts, fallback: ["Symbols"] });

  it.each([133, 134, 135])("fits the drawn bold facet header within a %s px chart", (width) => {
    const label = "MMMMMMMM";
    const pdf = readPdf(
      renderToPDF({
        width,
        height: 180,
        theme: { font: "Fixture" },
        fonts: pdfFonts(embeddedFonts),
        marks: [line(table({ x: [1, 2], y: [1, 2], p: [label, label] }), { x: "x", y: "y" })],
        facet: facet("p"),
      }),
    );
    // Read the drawn font's /W widths, rather than reusing the layout measurer.
    const descriptor = [...pdf.objects].find(([, obj]) => obj.dictionary.includes("/StemV 120"))!;
    const descendant = [...pdf.objects].find(([, obj]) =>
      obj.dictionary.includes(`/FontDescriptor ${descriptor[0]} 0 R`),
    )!;
    const type0 = [...pdf.objects].find(([, obj]) =>
      obj.dictionary.includes(`/DescendantFonts [${descendant[0]} 0 R]`),
    )!;
    const name = new RegExp(`/(F\\d+) ${type0[0]} 0 R`).exec(pdf.page)![1]!;
    const shown = new RegExp(`BT /${name} ([\\d.]+) Tf [^\\n]*<([\\da-f]+)> Tj ET`).exec(
      pdf.content,
    )!;
    const widths = /\/W \[1 \[([^\]]*)\]/
      .exec(descendant[1].dictionary)![1]!
      .split(" ")
      .map(Number);
    const cids = shown[2]!.match(/.{4}/g)!.map((cid) => Number.parseInt(cid, 16));
    const drawnWidth =
      (cids.reduce((sum, cid) => sum + widths[cid - 1]!, 0) * Number(shown[1])) / 1000;
    const room = Number(/q [\d.]+ [\d.]+ ([\d.]+) [\d.]+ re W n/.exec(pdf.content)![1]);
    expect(resolver().measure(label, "12px Fixture")).toBeLessThanOrEqual(room);
    expect(resolver().measure(label, "600 12px Fixture")).toBeGreaterThan(room);
    expect(drawnWidth).toBeLessThanOrEqual(room);
    const cmap = pdf.objects.get(ref(type0[1].dictionary, "ToUnicode"))!.stream!.toString("ascii");
    expect(cmap).toContain("<2026>");
  });

  it.each(["ｶﾞ", "ﾊﾟ"])("writes distinct glyphs and extraction scalars for %s", (text) => {
    const source = parseTrueType(embeddedFonts[0]!.data);
    const data = subsetTrueType(
      source,
      new Map(Array.from(text, (char, i) => [char.codePointAt(0)!, source.glyph(65 + i)])),
    ).data;
    const pdf = readPdf(
      renderToPDF({
        width: 320,
        height: 120,
        marks: [],
        title: text,
        theme: { font: "Fixture" },
        fonts: pdfFonts([{ family: "Fixture", data }]),
      }),
    );
    expect(pdf.content).toContain("<00010002> Tj");
    const type0 = [...pdf.objects.values()].find((obj) =>
      obj.dictionary.includes("/Subtype /Type0"),
    )!;
    const cmap = pdf.objects.get(ref(type0.dictionary, "ToUnicode"))!.stream!.toString("ascii");
    const entries = [...cmap.matchAll(/<000[12]> <([\da-f]+)>/g)].map(([, hex]) =>
      String.fromCharCode(Number.parseInt(hex!, 16)),
    );
    expect(entries.join("")).toBe(text);
    const descendant = [...pdf.objects.values()].find((obj) =>
      obj.dictionary.includes("/CIDToGIDMap"),
    )!;
    const gids = pdf.objects.get(ref(descendant.dictionary, "CIDToGIDMap"))!.stream!;
    expect(gids.readUInt16BE(2)).not.toBe(gids.readUInt16BE(4));
  });

  it.each([false, true])("exports gauge CSS fonts with fallback=%s", (fallback) => {
    const decoy = fontFixture("sans-bold");
    new DataView(decoy.buffer).setUint16(fontTableOffset(decoy, "head") + 18, 2048);
    const fonts = pdfFonts([...embeddedFonts, { family: "Decoy", data: decoy }], {
      fallback: fallback ? ["Decoy"] : [],
    });
    const config: PdfOptions = {
      width: 320,
      height: 240,
      locale: "en-US",
      theme: { font: "Fixture, serif" },
      fonts,
      marks: [gauge(table({ cpu: [61.5] }), { value: "cpu", label: "Wié" })],
    };
    for (const bytes of [
      renderToPDF(config),
      specToPDF(
        {
          version: 1,
          width: 320,
          height: 240,
          locale: "en-US",
          theme: config.theme!,
          data: { cpu: { columns: { cpu: [61.5] } } },
          marks: [{ type: "gauge", data: "cpu", value: "cpu", label: "Wié" }],
        },
        { fonts },
      ),
    ]) {
      const programs = embeddedPrograms(readPdf(bytes)).map(parseTrueType);
      expect(programs).toHaveLength(2);
      for (const [code, source] of [
        [54, "sans-bold"],
        [87, "sans"],
      ] as const) {
        const program = programs.find((font) => font.glyph(code))!;
        const expected = parseTrueType(fontFixture(source));
        expect(program.unitsPerEm).toBe(expected.unitsPerEm);
        expect(program.advances[program.glyph(code)]).toBe(expected.advances[expected.glyph(code)]);
      }
    }
  });

  it.each([false, true])("exports custom text CSS fonts with fallback=%s", (fallback) => {
    const pdf = readPdf(
      renderToPDF({
        width: 200,
        height: 100,
        theme: { font: "Fixture, serif" },
        fonts: pdfFonts([...embeddedFonts, { family: "Decoy", data: fontFixture("sans-bold") }], {
          fallback: fallback ? ["Decoy"] : [],
        }),
        marks: [
          custom({
            draw({ text }) {
              text(50, 20, "Wié");
            },
          }),
        ],
      }),
    );
    const programs = embeddedPrograms(pdf).map(parseTrueType);
    expect(programs).toHaveLength(1);
    const expected = parseTrueType(fontFixture("sans"));
    expect(programs[0]!.advances[programs[0]!.glyph(87)]).toBe(
      expected.advances[expected.glyph(87)],
    );
  });

  it.each([
    ["Old Uyghur", "𐽰𐽱"],
    ["Duployan", "𛰀𛰁"],
  ])("refuses covered and uncovered %s before replacement", (_script, text) => {
    const font = parseTrueType(fontFixture("sans"));
    const covered = subsetTrueType(
      font,
      new Map([
        [63, font.glyph(63)],
        ...Array.from(text, (char): [number, number] => [char.codePointAt(0)!, font.glyph(65)]),
      ]),
    ).data;
    for (const data of [fontFixture("sans"), covered]) {
      for (const missingGlyph of [undefined, "?"]) {
        const fonts = new PdfFontResolver({
          fonts: [{ family: "Fixture", data }],
          ...(missingGlyph && { missingGlyph }),
        });
        expect(() => fonts.resolve(text, "Fixture", false)).toThrow(
          new RegExp(`U\\+${text.codePointAt(0)!.toString(16).toUpperCase()}.*SVG/PNG`),
        );
      }
    }
  });

  it.each(["👍🏽", "🇬🇧", "🏴\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}", "👩\u200d💻"])(
    "refuses emoji sequence %s before coverage, fallback, or replacement",
    (text) => {
      const font = parseTrueType(fontFixture("sans"));
      const codes = Array.from(text, (char) => char.codePointAt(0)!);
      const face = (family: string, values: number[]): PdfFontSource => ({
        family,
        data: subsetTrueType(
          font,
          new Map([
            [63, font.glyph(63)],
            ...values.map((code): [number, number] => [code, font.glyph(65)]),
          ]),
        ).data,
      });
      for (const sources of [
        [embeddedFonts[0]!],
        [face("Fixture", codes)],
        [face("Fixture", codes.slice(0, 1)), face("Fallback", codes.slice(1))],
      ]) {
        for (const missingGlyph of [undefined, "?"]) {
          const fonts = new PdfFontResolver({
            fonts: sources,
            fallback: sources.length > 1 ? ["Fallback"] : [],
            ...(missingGlyph && { missingGlyph }),
          });
          expect(() => fonts.resolve(text, "Fixture", false)).toThrow(
            /cannot shape emoji sequences.*SVG\/PNG/,
          );
        }
      }
    },
  );

  it.each([
    ["Aé …", 0, 32],
    ["Δ", 0, 4],
    ["Мир", 0, 4],
    ["é", 0x100, 4],
  ])("classifies the embedded repertoire for %s, fsType=%s", (text, fsType, classification) => {
    const data = embeddingFlags(fsType);
    const post = fontTableOffset(data, "post");
    const view = new DataView(data.buffer);
    view.setInt32(post + 4, -12 * 65536);
    view.setUint32(post + 12, 1);
    const pdf = readPdf(
      renderToPDF({
        width: 320,
        height: 120,
        marks: [],
        title: text,
        theme: { font: "Fixture" },
        fonts: pdfFonts([{ family: "Fixture", data }]),
      }),
    );
    const descriptor = [...pdf.objects.values()].find((obj) =>
      obj.dictionary.includes("/Type /FontDescriptor"),
    )!.dictionary;
    expect(Number(/\/Flags (\d+)/.exec(descriptor)![1])).toBe(classification | 1 | 64);
  });

  it.each([
    ["ıŁłŒœ⁄ﬁﬂ−", 32],
    ["Ā", 4],
    ["𝌀", 4],
  ])("classifies Adobe Latin extensions and Unicode scalars in %s", (text, flags) => {
    const font = parseTrueType(fontFixture("sans"));
    const data = subsetTrueType(
      font,
      new Map(Array.from(text, (char) => [char.codePointAt(0)!, font.glyph(65)])),
    ).data;
    const pdf = readPdf(
      renderToPDF({
        width: 320,
        height: 120,
        marks: [],
        title: text,
        theme: { font: "Fixture" },
        fonts: pdfFonts([{ family: "Fixture", data }]),
      }),
    );
    const descriptor = [...pdf.objects.values()].find((obj) =>
      obj.dictionary.includes("/Type /FontDescriptor"),
    )!.dictionary;
    expect(Number(/\/Flags (\d+)/.exec(descriptor)![1])).toBe(flags);
  });

  it.each([false, true])(
    "classifies the entire format-12 font when subsetting is forbidden, symbolic=%s",
    (symbolic) => {
      const font = parseTrueType(fontFixture("sans"));
      const repertoire = new Map([
        [65, font.glyph(65)],
        [symbolic ? 0x1d300 : 0x0141, font.glyph(66)],
      ]);
      const data = subsetTrueType(font, repertoire).data;
      new DataView(data.buffer).setUint16(fontTableOffset(data, "OS/2") + 8, 0x100);
      const pdf = readPdf(
        renderToPDF({
          width: 320,
          height: 120,
          marks: [],
          title: "A",
          theme: { font: "Fixture" },
          fonts: pdfFonts([{ family: "Fixture", data }]),
        }),
      );
      const descriptor = [...pdf.objects.values()].find((obj) =>
        obj.dictionary.includes("/Type /FontDescriptor"),
      )!.dictionary;
      expect(Number(/\/Flags (\d+)/.exec(descriptor)![1])).toBe(symbolic ? 4 : 32);
    },
  );

  it("writes Type0 fonts with explicit CID mapping, exact widths, and UTF-16BE extraction", () => {
    const fonts = resolver();
    const pdf = readPdf(renderPdf(unicodeScene(), {}, fonts));
    const dictionaries = [...pdf.objects.values()].map((obj) => obj.dictionary).join("\n");
    expect(dictionaries).toContain("/Subtype /Type0");
    expect(dictionaries).toContain("/Subtype /CIDFontType2");
    expect(dictionaries).toContain("/Encoding /Identity-H");
    expect(dictionaries).toContain("/FontFile2");
    expect(dictionaries).toContain("/CIDToGIDMap");
    expect(dictionaries).not.toContain("/Subtype /Type1");
    const unicode = [...pdf.objects.values()]
      .filter((obj) => obj.stream?.includes("begincmap"))
      .map((obj) => obj.stream!.toString("ascii"))
      .join("\n");
    for (const code of ["00e9", "0394", "03a9", "041c", "0438", "0440", "d834df00"])
      expect(unicode).toContain(`<${code}>`);
    const runs = fonts.resolve(unicodeText, "Fixture", true).runs;
    for (const run of runs) {
      const widths = [...run.face.codes.values()].map((cid) =>
        run.face.advance(run.face.cidGlyphs.get(cid)!),
      );
      expect(dictionaries).toContain(`/W [1 [${widths.join(" ")}]]`);
    }
    expect(pdf.content).toMatch(/<([\da-f]{4})+> Tj/);
    const programs = embeddedPrograms(pdf);
    expect(programs).toHaveLength(2);
    for (const program of programs) expect(fontChecksum(program)).toBe(0xb1b0afba);
  });

  it("uses the same bold and fallback advances for measurement and drawing", () => {
    const fonts = resolver();
    const normal = fonts.resolve("Wi𝌀Wi", '"Fixture", sans-serif', false);
    const bold = fonts.resolve("Wi𝌀Wi", "Fixture", true);
    expect(normal.runs).toHaveLength(3);
    expect(normal.runs[1]!.face.source.family).toBe("Symbols");
    expect(normal.width).not.toBe(bold.width);
    expect(fonts.measure("Wi𝌀Wi", 'bold 20px "Fixture", sans-serif')).toBe(bold.width * 20);
    expect(bold.runs[0]!.face.source.weight).toBe("bold");
    const onlyRegular = new PdfFontResolver({ fonts: [embeddedFonts[0]!] });
    expect(onlyRegular.measure("Wi", "bold 20px Fixture")).toBe(
      onlyRegular.measure("Wi", "20px Fixture"),
    );
  });

  it("anchors the whole fallback string before rotating and offsetting its spans", () => {
    const fonts = resolver();
    const scene = unicodeScene("Wi𝌀Wi");
    scene.headers[0]!.angle = 90;
    const pdf = readPdf(renderPdf(scene, {}, fonts));
    const resolved = fonts.resolve("Wi𝌀Wi", "Fixture", true);
    const matrices = [...pdf.content.matchAll(/0 1 1 0 ([\d.-]+) ([\d.-]+) Tm/g)];
    expect(matrices).toHaveLength(3);
    expect(Number(matrices[0]![1])).toBeCloseTo(
      160 - (resolved.capHeight * scene.theme.fontSize) / 2,
      5,
    );
    expect(Number(matrices[0]![2])).toBeCloseTo(
      60 - (resolved.width * scene.theme.fontSize) / 2,
      5,
    );
    expect(Number(matrices[1]![2]) - Number(matrices[0]![2])).toBeCloseTo(
      resolved.runs[0]!.width * scene.theme.fontSize,
      5,
    );
  });

  it("keeps a combining sequence in a single covering fallback face", () => {
    const source = parseTrueType(embeddedFonts[0]!.data);
    const primary = subsetTrueType(source, new Map([[101, source.glyph(101)]])).data;
    const fonts = new PdfFontResolver({
      fonts: [{ family: "Primary", data: primary }, embeddedFonts[0]!],
      fallback: ["Fixture"],
    });
    const resolved = fonts.resolve("ée", "Primary", false);
    expect(resolved.runs).toHaveLength(2);
    expect(resolved.runs[0]!.glyphs.map((glyph) => glyph.source)).toEqual(["é"]);
    expect(resolved.runs[0]!.face.source.family).toBe("Fixture");
    expect(resolved.runs[1]!.face.source.family).toBe("Primary");
  });

  it("composes simple accents while preserving original Unicode sequences and alias CIDs", () => {
    const fonts = resolver();
    const resolved = fonts.resolve("íí", "Fixture", false);
    expect(resolved.runs[0]!.glyphs.map((glyph) => glyph.glyph)).toEqual([
      resolved.runs[0]!.face.font.glyph(0x00ed),
      resolved.runs[0]!.face.font.glyph(0x00ed),
    ]);
    expect(fonts.measure("í", "12px Fixture")).toBe(fonts.measure("í", "12px Fixture"));
    const pdf = readPdf(renderPdf(unicodeScene("íí"), {}, fonts));
    const unicode = [...pdf.objects.values()]
      .find((obj) => obj.stream?.includes("begincmap"))!
      .stream!.toString("ascii");
    expect(unicode).toContain("<00690301>");
    expect(unicode).toContain("<00ed>");
    expect(pdf.content).toContain("<00010002> Tj");
    const mapping = [...pdf.objects.values()].find((obj) =>
      obj.dictionary.includes("/CIDToGIDMap"),
    )!;
    const gids = pdf.objects.get(ref(mapping.dictionary, "CIDToGIDMap"))!.stream!;
    expect(gids.readUInt16BE(2)).toBe(gids.readUInt16BE(4));
    expect(() => fonts.resolve("x́", "Fixture", false)).toThrow(
      /cannot position combining sequence/,
    );
  });

  it("keeps Common and Inherited characters in Latin text and refuses covered Kawi", () => {
    const fonts = resolver();
    for (const text of ["A·B", "OʼBrien", "ä"])
      expect(fonts.measure(text, "12px Fixture")).toBeGreaterThan(0);
    const source = parseTrueType(embeddedFonts[0]!.data);
    const codes = [0x11f04, 0x11f34, 0x11f36];
    const data = subsetTrueType(
      source,
      new Map(codes.map((code) => [code, source.glyph(65)])),
    ).data;
    const kawi = new PdfFontResolver({ fonts: [{ family: "Kawi", data }] });
    expect(() => kawi.resolve(String.fromCodePoint(...codes), "Kawi", false)).toThrow(/U\+11F04/);
  });

  it("resolves quoted CSS family names with commas and surrounding spaces", () => {
    const fonts = new PdfFontResolver({
      fonts: [{ family: "Comma, Name", data: embeddedFonts[0]!.data }],
    });
    expect(fonts.resolve("Hi", '  "Comma, Name", sans-serif', false).width).toBeGreaterThan(0);
  });

  it("rounds fractional advances identically in layout and PDF widths", () => {
    const data = fontFixture("sans");
    new DataView(data.buffer).setUint16(fontTableOffset(data, "head") + 18, 2048);
    const fonts = new PdfFontResolver({ fonts: [{ family: "Fixture", data }] });
    const glyphs = fonts.resolve("Wi", "Fixture", false).runs[0]!.glyphs;
    expect(fonts.measure("Wi", "12px Fixture")).toBe(
      ((glyphs[0]!.advance + glyphs[1]!.advance) / 1000) * 12,
    );
    const pdf = readPdf(renderPdf(unicodeScene("Wi"), {}, fonts));
    expect([...pdf.objects.values()].map((obj) => obj.dictionary).join("\n")).toContain(
      `/W [1 [${glyphs.map((glyph) => glyph.advance).join(" ")}]]`,
    );
  });

  it("bounds composite expansion and rejects cycles", () => {
    const font = parseTrueType(fontFixture("sans"));
    const tables = new Map([...font.tables].map(([tag, data]) => [tag, new Uint8Array(data)]));
    const count = font.glyphCount + 25;
    new DataView(tables.get("head")!.buffer).setInt16(50, 1);
    new DataView(tables.get("head")!.buffer).setUint32(8, 0);
    new DataView(tables.get("maxp")!.buffer).setUint16(4, count);
    new DataView(tables.get("hhea")!.buffer).setUint16(34, count);
    const originalGlyf = font.tables.get("glyf")!;
    const glyf = new Uint8Array(originalGlyf.length + 25 * 28);
    glyf.set(originalGlyf);
    const loca = new Uint8Array((count + 1) * 4);
    const hmtx = new Uint8Array(count * 4);
    const offsets = new DataView(loca.buffer);
    const metrics = new DataView(hmtx.buffer);
    for (let i = 0; i < font.glyphCount; i++) {
      offsets.setUint32(i * 4, font.offsets[i]!);
      metrics.setUint16(i * 4, font.advances[i]!);
      metrics.setInt16(i * 4 + 2, font.bearings[i]!);
    }
    let previous = font.glyph(65);
    const view = new DataView(glyf.buffer);
    for (let i = 0; i < 25; i++) {
      const at = originalGlyf.length + i * 28;
      offsets.setUint32((font.glyphCount + i) * 4, at);
      metrics.setUint16((font.glyphCount + i) * 4, 500);
      view.setInt16(at, -1);
      view.setUint16(at + 10, 35); // Two copies of the previous glyph.
      view.setUint16(at + 12, previous);
      view.setUint16(at + 18, 3);
      view.setUint16(at + 20, previous);
      previous = font.glyphCount + i;
    }
    offsets.setUint32(count * 4, glyf.length);
    tables.set("glyf", glyf);
    tables.set("loca", loca);
    tables.set("hmtx", hmtx);
    expect(() => parseTrueType(writeSfnt(tables))).toThrow(/expansion exceeds/);
    const cyclic = fontFixture("sans");
    const [id, refs] = [...parseTrueType(cyclic).components][0]!;
    new DataView(cyclic.buffer).setUint16(
      fontTableOffset(cyclic, "glyf") + font.offsets[id]! + refs[0]!.offset,
      id,
    );
    expect(() => parseTrueType(cyclic)).toThrow(/cyclic/);
  });

  it("validates instructions flagged on an earlier composite component", () => {
    const data = fontFixture("sans");
    const font = parseTrueType(data);
    const [id, refs] = [...font.components].find(([, refs]) => refs.length > 1)!;
    const start = fontTableOffset(data, "glyf") + font.offsets[id]!;
    const view = new DataView(data.buffer);
    const flagsAt = start + refs[0]!.offset - 2;
    view.setUint16(flagsAt, view.getUint16(flagsAt) | 256);
    const last = start + refs[refs.length - 1]!.offset - 2;
    const flags = view.getUint16(last);
    const instructionAt =
      last + 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
    view.setUint16(instructionAt, 65535);
    expect(() => parseTrueType(data)).toThrow(/outside table bounds/);
  });

  it("subsets only emitted glyphs, including .notdef and recursive composite components", () => {
    const fonts = resolver();
    fonts.measure("NeverDrawn", "bold 12px Fixture");
    const pdf = readPdf(renderPdf(unicodeScene("é"), {}, fonts));
    const program = embeddedPrograms(pdf)[0]!;
    const subset = parseTrueType(program);
    expect(subset.glyph(0x00e9)).toBeGreaterThan(0);
    expect(subset.glyph(78)).toBe(0);
    expect(subset.components.size).toBeGreaterThan(0);
    expect(subset.glyphCount).toBeLessThan(8);
    expect(program.length).toBeLessThan(embeddedFonts[1]!.data.length / 2);
    for (const refs of subset.components.values())
      for (const child of refs) expect(child.glyph).toBeLessThan(subset.glyphCount);
  });

  it("creates deterministic, independent subsets for each document", () => {
    const options = {
      width: 320,
      height: 120,
      title: unicodeText,
      marks: [],
      theme: { font: "Fixture" },
      fonts: pdfFonts(embeddedFonts, { fallback: ["Symbols"] }),
    };
    const first = renderToPDF(options);
    renderToPDF({ ...options, title: "Different" });
    expect(renderToPDF(options)).toEqual(first);
    const spec = {
      version: 1 as const,
      width: 320,
      height: 120,
      title: unicodeText,
      theme: { font: "Fixture" },
      data: {},
      marks: [],
    };
    expect(specToPDF(spec, { fonts: options.fonts })).toEqual(first);
  });

  it("refuses unprepared font arrays with migration guidance", () => {
    expect(() =>
      // @ts-expect-error arrays must be wrapped in pdfFonts
      renderToPDF({ width: 100, height: 100, marks: [], fonts: embeddedFonts }),
    ).toThrow(/wrap the font array in pdfFonts/);
    expect(() =>
      // @ts-expect-error spec exports also require prepared fonts
      specToPDF({ version: 1, data: {}, marks: [] }, { fonts: [] }),
    ).toThrow(/wrap the font array in pdfFonts/);
  });

  it("snapshots font descriptors and fallback options without sharing document usage", () => {
    const sources = embeddedFonts.map((font) => ({ ...font }));
    const fallback = ["Symbols"];
    const fonts = pdfFonts(sources, { fallback });
    sources[0]!.family = "Changed";
    sources.length = 0;
    fallback[0] = "Unknown";
    const first = fonts.createResolver();
    const second = fonts.createResolver();
    renderPdf(unicodeScene(), {}, first);
    expect(embeddedPrograms(readPdf(renderPdf(unicodeScene("é"), {}, second)))).toHaveLength(1);
    expect(second.resolve("é", "Fixture", false).runs[0]!.face.codes.size).toBe(0);
    expect(first.measure("𝌀", "12px Fixture")).toBeGreaterThan(0);
  });

  it("supports Buffer and Uint8Array views without modifying caller-owned bytes", () => {
    const data = Buffer.concat([
      Buffer.alloc(7),
      Buffer.from(embeddedFonts[0]!.data),
      Buffer.alloc(9),
    ]);
    const before = Buffer.from(data);
    const face = data.subarray(7, data.length - 9);
    const fonts = new PdfFontResolver({ fonts: [{ family: "Fixture", data: face }] });
    const pdf = readPdf(renderPdf(unicodeScene("é"), {}, fonts));
    const program = embeddedPrograms(pdf)[0]!;
    expect(fontChecksum(program)).toBe(0xb1b0afba);
    expect(parseTrueType(program).glyph(0x00e9)).toBeGreaterThan(0);
    expect(data).toEqual(before);
  });

  it("draws Unicode halos with the same codes as the fill and empty replacement text", () => {
    const scene = unicodeScene("");
    const labels: TextGeometry = {
      kind: "text",
      key: "labels",
      draw: textDrawing,
      fill: "#000000",
      anchor: "end",
      halo: true,
      coords: Float32Array.of(200, 50),
      labels: ["é𝌀"],
      count: 1,
    };
    scene.panels = [
      {
        key: "",
        plot: { x: 0, y: 0, width: 320, height: 120 },
        grid: { x: [], y: [] },
        axes: [],
        marks: [labels],
      },
    ];
    const pdf = readPdf(renderPdf(scene, {}, resolver()));
    expect(pdf.content).toContain("/ActualText ()");
    const codes = [...pdf.content.matchAll(/(<[\da-f]+>) Tj/g)].map((match) => match[1]);
    expect(codes).toHaveLength(4);
    expect(codes.slice(0, 2)).toEqual(codes.slice(2));
  });

  it("keeps different source characters with the same glyph in separate CIDs", () => {
    const fonts = resolver();
    const run = fonts.resolve(" \u00a0", "Fixture", false).runs[0]!;
    const aliases = run.glyphs.map((glyph) => ({ ...glyph, glyph: run.glyphs[0]!.glyph }));
    expect(run.face.encode(aliases)).toBe("<00010002>");
    expect(run.face.codes.size).toBe(2);
  });

  it("honors no-subsetting and rejects restricted or bitmap-only embedding", () => {
    for (const flag of [2, 0x0200])
      expect(
        () => new PdfFontResolver({ fonts: [{ family: "Fixture", data: embeddingFlags(flag) }] }),
      ).toThrow(/fsType/);
    const data = embeddingFlags(0x0100);
    const fonts = new PdfFontResolver({ fonts: [{ family: "Fixture", data }] });
    const pdf = readPdf(renderPdf(unicodeScene("é"), {}, fonts));
    expect(new Uint8Array(embeddedPrograms(pdf)[0]!)).toEqual(data);
    const dict = [...pdf.objects.values()].find((obj) =>
      obj.dictionary.includes("/Subtype /Type0"),
    )!.dictionary;
    expect(dict).not.toMatch(/\/BaseFont \/[A-Z]{6}\+/);
  });

  it("reports missing coverage and allows an explicit covered replacement", () => {
    expect(() => resolver().measure("雪", "12px Fixture")).toThrow(
      /U\+96EA.*supply a covering font/,
    );
    const fonts = new PdfFontResolver({ fonts: embeddedFonts, missingGlyph: "?" });
    expect(fonts.measure("雪", "12px Fixture")).toBe(fonts.measure("?", "12px Fixture"));
    expect(() => new PdfFontResolver({ fonts: embeddedFonts, missingGlyph: "ab" })).toThrow(
      /one covered Unicode scalar/,
    );
    expect(() => new PdfFontResolver({ fonts: embeddedFonts, missingGlyph: "\u0301" })).toThrow(
      /standalone scalar/,
    );
    expect(() => pdfFonts([], { missingGlyph: "?" }).createResolver()).toThrow(
      /require at least one font/,
    );
    const replaced = renderToPDF({
      width: 320,
      height: 120,
      marks: [],
      title: "雪",
      theme: { font: "Fixture" },
      fonts: pdfFonts(embeddedFonts, { missingGlyph: "?" }),
    });
    expect(readPdf(replaced).content).toContain(" Tj");
  });

  it.each([
    ["مرحبا", "Arabic"],
    ["שלום", "Hebrew"],
    ["नमस्ते", "Devanagari"],
    ["ไทย", "Thai"],
  ])("refuses %s (%s) with an actionable code point", (text) => {
    const code = `U+${text.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`;
    expect(() => resolver().measure(text, "12px Fixture")).toThrow(
      new RegExp(`${code.replace("+", "\\+")}.*SVG/PNG`),
    );
    expect(() =>
      new PdfFontResolver({ fonts: embeddedFonts, missingGlyph: "?" }).measure(
        text,
        "12px Fixture",
      ),
    ).toThrow(code);
  });

  it("rejects joiners, variations, unpaired surrogates, unknown families, and invalid registries", () => {
    for (const text of ["a\u200d", "★\ufe0f", "\ud800"])
      expect(() => resolver().measure(text, "12px Fixture")).toThrow(
        /cannot render|invalid Unicode/,
      );
    expect(() =>
      new PdfFontResolver({ fonts: embeddedFonts }).measure("Hi", "12px Unknown"),
    ).toThrow(/not registered/);
    expect(() => new PdfFontResolver({ fonts: embeddedFonts, fallback: ["Unknown"] })).toThrow(
      /not registered/,
    );
    expect(() => new PdfFontResolver({ fonts: [embeddedFonts[0]!, embeddedFonts[0]!] })).toThrow(
      /Duplicate/,
    );
  });

  it("bounds-checks malformed tables, metrics, cmaps, loca, and composite glyph references", () => {
    expect(() => parseTrueType(new Uint8Array(3))).toThrow(/Malformed PDF font/);
    const cases: Uint8Array[] = [];
    let data = fontFixture("sans");
    new DataView(data.buffer).setUint32(20, data.length + 100);
    cases.push(data);
    data = fontFixture("sans");
    new DataView(data.buffer).setUint16(fontTableOffset(data, "head") + 18, 0);
    cases.push(data);
    data = fontFixture("sans");
    new DataView(data.buffer).setUint16(fontTableOffset(data, "hhea") + 34, 65535);
    cases.push(data);
    data = fontFixture("sans");
    new DataView(data.buffer).setUint16(fontTableOffset(data, "loca") + 2, 65535);
    cases.push(data);
    data = fontFixture("sans");
    const parsed = parseTrueType(data);
    const [id, refs] = [...parsed.components][0]!;
    new DataView(data.buffer).setUint16(
      fontTableOffset(data, "glyf") + parsed.offsets[id]! + refs[0]!.offset,
      65535,
    );
    cases.push(data);
    data = fontFixture("symbols");
    const cmap = fontTableOffset(data, "cmap");
    const view = new DataView(data.buffer);
    const offset = view.getUint32(cmap + 8);
    view.setUint32(cmap + offset + 4, 0xffffffff);
    cases.push(data);
    for (const malformed of cases)
      expect(() => parseTrueType(malformed)).toThrow(/Malformed PDF font/);
  });

  it("rejects CFF outlines clearly and accepts sfnt OpenType with glyf", () => {
    const data = fontFixture("sans");
    new DataView(data.buffer).setUint32(0, 0x4f54544f);
    expect(parseTrueType(data).glyph(101)).toBeGreaterThan(0);
    const glyf = fontTableOffset(data, "glyf");
    for (let i = 0; i < new DataView(data.buffer).getUint16(4); i++) {
      const at = 12 + i * 16;
      if (new DataView(data.buffer).getUint32(at + 8) === glyf) data.set([67, 70, 70, 32], at);
    }
    expect(() => parseTrueType(data)).toThrow(/CFF outlines.*TrueType/);
  });
});

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
        heatmap(table({ x: [0, 1], y: [0, 0], v: [1, null] }), { x: "x", y: "y", color: "v" }),
      ],
    }),
  );
  const unicode = join(directory, "unicode.pdf");
  writeFileSync(
    unicode,
    renderToPDF({
      ...latency,
      title: unicodeText,
      theme: { font: "Fixture" },
      fonts: pdfFonts(embeddedFonts, { fallback: ["Symbols"] }),
    }),
  );

  const report = join(directory, "report.pdf");
  writeFileSync(
    report,
    renderToPDF(
      [
        { ...latency, title: "é", theme: { font: "Fixture" } },
        { ...latency, title: unicodeText, theme: { font: "Fixture" } },
        {
          width: 300,
          height: 200,
          title: "Heatmap",
          theme: { font: "Fixture" },
          marks: [
            heatmap(table({ x: [0, 1], y: [0, 0], v: [1, null] }), { x: "x", y: "y", color: "v" }),
          ],
        },
      ],
      {
        fonts: pdfFonts(embeddedFonts, { fallback: ["Symbols"] }),
        pageSize: "A4",
        title: "Report",
      },
    ),
  );

  it.skipIf(!installed("qpdf"))("pass qpdf --check", () => {
    for (const file of [chart, cells, unicode, report]) {
      const output = execFileSync("qpdf", ["--check", file], { encoding: "utf8" });
      expect(output).toContain("No syntax or stream encoding errors");
    }
  });

  it.skipIf(!installed("mutool"))("render with MuPDF without warnings", () => {
    for (const file of [chart, cells, unicode, report]) {
      const result = spawnSync("mutool", ["draw", "-o", join(directory, "page-%d.png"), file], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      // Some distributions build MuPDF without ICC color management and say so on every file.
      const problems = result.stderr
        .split("\n")
        .filter(
          (line) => /warning|error/i.test(line) && !/ICC support is not available/.test(line),
        );
      expect(problems).toEqual([]);
    }
  });

  it.skipIf(!installed("pdftotext"))("extract the chart's text with Poppler", () => {
    const text = execFileSync("pdftotext", [chart, "-"], { encoding: "utf8" });
    for (const label of ["Latency é", "08:00", "SLO", "ms"]) expect(text).toContain(label);
    expect(execFileSync("pdftotext", [unicode, "-"], { encoding: "utf8" })).toContain(unicodeText);
    const pages = execFileSync("pdftotext", [report, "-"], { encoding: "utf8" }).split("\f");
    expect(pages).toHaveLength(4);
    expect(pages[0]).toContain("é");
    expect(pages[1]).toContain(unicodeText);
    expect(pages[2]).toContain("Heatmap");
  });

  // Poppler prints each structure element's marked text, not its /Alt (which
  // figureAlt checks): a Figure holding the page's text shows that the parent
  // tree and the marked content link up.
  it.skipIf(!installed("pdfinfo"))("exposes the structure and marked text to Poppler", () => {
    for (const file of [chart, cells, unicode, report]) {
      const dump = execFileSync("pdfinfo", ["-struct-text", file], { encoding: "utf8" });
      expect(dump).toMatch(/^Document\b/m);
      const parsed = readPdf(readFileSync(file));
      expect(dump.match(/^\s+Figure\b/gm)).toHaveLength(parsed.pages.length);
      expect(dump).toMatch(/^\s+Figure\b.*\n\s+"[^"]*\S[^"]*"/m);
    }
    const chartDump = execFileSync("pdfinfo", ["-struct-text", chart], { encoding: "utf8" });
    for (const label of ["SLO", "Latency é"]) expect(chartDump).toContain(label);
  });

  it.skipIf(!installed("mutool"))("renders composite subsets identically to the full font", () => {
    const full = join(directory, "full.pdf");
    const subset = join(directory, "subset.pdf");
    const scene = unicodeScene("é");
    writeFileSync(
      full,
      renderPdf(
        scene,
        {},
        new PdfFontResolver({ fonts: [{ family: "Fixture", data: embeddingFlags(0x0100) }] }),
      ),
    );
    writeFileSync(
      subset,
      renderPdf(scene, {}, new PdfFontResolver({ fonts: [embeddedFonts[0]!] })),
    );
    const images = [full, subset].map((file, i) => {
      const output = join(directory, `composite-${i}.png`);
      execFileSync("mutool", ["draw", "-o", output, file]);
      return readFileSync(output);
    });
    expect(images[0]).toEqual(images[1]);
  });

  it.skipIf(!installed("mutool"))(
    "renders decomposed i-acute identically to its precomposed glyph",
    () => {
      const images = ["í", "í"].map((text, i) => {
        const file = join(directory, `accent-${i}.pdf`);
        const output = join(directory, `accent-${i}.png`);
        writeFileSync(
          file,
          renderPdf(unicodeScene(text), {}, new PdfFontResolver({ fonts: [embeddedFonts[0]!] })),
        );
        execFileSync("mutool", ["draw", "-o", output, file]);
        return readFileSync(output);
      });
      expect(images[0]).toEqual(images[1]);
    },
  );
});

it("exports notched precomputed boxes as closed PDF paths with waist medians", () => {
  const data = table({
    group: ["a"],
    low: [0],
    q1: [25],
    median: [50],
    q3: [75],
    high: [100],
    count: [100],
  });
  for (const horizontal of [false, true]) {
    const fields = {
      low: "low",
      q1: "q1",
      median: "median",
      q3: "q3",
      high: "high",
      count: "count",
      notch: true,
      fill: "#ff0000",
    } as const;
    const mark = boxplot(data, horizontal ? { y: "group", ...fields } : { x: "group", ...fields });
    const config = { width: 600, height: 300, locale: "en-US", marks: [mark] };
    const pdf = readPdf(renderToPDF(config));
    // One closed ten-vertex area, filled red; all fifteen outline/median/whisker segments follow.
    expect(pdf.content).toMatch(/1 0 0 rg\n[^\n]+ m\n(?:[^\n]+ l\n){9}h\nf\n/);
    expect(pdf.content).toMatch(/1 0 0 RG 1.5 w[^\n]*\n(?:[^\n]+ m\n[^\n]+ l\n){15}S\n/);
    expect(renderToSVG(config)).toMatch(/fill="#ff0000"/);
  }
});

it("exports horizontal cumulative histograms as PDF rectangles and static SVG", () => {
  const mark = histogram(table({ v: [1, 2, 3] }), {
    y: "v",
    bins: [0, 2, 4],
    cumulative: true,
    fill: "#ff0000",
  });
  const config = { width: 600, height: 300, locale: "en-US", marks: [mark] };
  const pdf = readPdf(renderToPDF(config));
  expect(pdf.content).toMatch(/1 0 0 rg/);
  expect(pdf.content).toMatch(/(?:[^\n]+ re\n){2}f/);
  expect(renderToSVG(config)).toMatch(/fill="#ff0000"/);
  const spec = {
    width: 600,
    height: 300,
    data: { t: { columns: { v: [1, 2, 3] } } },
    marks: [{ type: "histogram", y: "v", bins: [0, 2, 4] }],
  };
  validateSpec(spec);
  expect(readPdf(specToPDF(spec)).content).toMatch(/ re\n/);
  expect(specToSVG(spec)).toContain("<path");
});

it.each(["bottom", "top", "left", "right"] as const)(
  "exports dendrogram segments as static SVG and vector PDF (%s)",
  (side) => {
    const data = table({ first: [0, 2, 5], second: [1, 3, 4], height: [1, 2, 4] });
    const options = {
      width: 400,
      height: 200,
      marks: [
        dendrogram(data, {
          first: "first",
          second: "second",
          height: "height",
          leaves: ["a", "b", "c", "d"],
          side,
          stroke: "#ff0000",
          strokeWidth: 2,
          label: "Clustering",
        }),
      ],
      x: { show: false, grid: false },
      y: { show: false, grid: false },
      locale: "en-US",
    };
    const svg = renderToSVG(options);
    const path = /<path[^>]*d="([^"]+)"[^>]*stroke="#ff0000"/.exec(svg)![1]!;
    expect(path.match(/M/g)).toHaveLength(9);
    expect(path.match(/L/g)).toHaveLength(9);
    const pdf = readPdf(renderToPDF(options));
    expect(pdf.content).toContain("1 0 0 RG");
    expect(pdf.content).toContain("2 w");
    expect(pdf.content.match(/\bm\n/g)).toHaveLength(9);
    expect(pdf.content.match(/\bl\n/g)).toHaveLength(9);
    expect(pdf.content).not.toContain(" Do");
  },
);

it("exports split violin halves, dashed quartiles, and solid medians in facet PDFs", () => {
  const data = table({
    g: ["a", "a", "a", "a", "b", "b"],
    p: ["P", "P", "P", "P", "Q", "Q"],
    s: ["first", "first", "second", "second", "second", "second"],
    v: [1, 3, 2, 4, 5, 7],
  });
  for (const horizontal of [false, true])
    for (const inner of ["box", "quartiles", "none"] as const) {
      const mark = violin(data, {
        ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
        series: "s",
        split: true,
        inner,
      });
      const config = {
        width: 600,
        height: 300,
        locale: "en-US",
        marks: [mark],
        facet: facet("p"),
        resolve: { [horizontal ? "y" : "x"]: "independent" as const },
      };
      const pdf = readPdf(renderToPDF(config));
      expect(pdf.content.includes("[4 3] 0 d")).toBe(inner === "quartiles");
      if (inner === "quartiles")
        expect(pdf.content).toMatch(/1\.5 w 1 J 1 j\n[^\n]+ m\n[^\n]+ l\nS\nQ/);
      // Three densities: both series in P, only the second in Q.
      expect(pdf.content.match(/(?:[^\n]+ l\n){20,}h\nf\n/g)).toHaveLength(3);
      expect(renderToSVG(config).includes('stroke-dasharray="4 3"')).toBe(inner === "quartiles");
    }
});

describe("PDF documents", () => {
  it("checks numeric grammar without parsing text strings or names as numbers", () => {
    assertPdfNumbers("0.000000041667 0 0 1 0 0 cm (1e-8) Tj /1e-8 Do");
    for (const bad of ["4.1667e-8", "1E+21", "NaN", "Infinity", "--1", "0.0.1"])
      expect(() => assertPdfNumbers(`${bad} 0 0 1 0 0 cm`)).toThrow(/PDF numeric token/);
    expect(num(4.1667e-8, 12)).toBe("0.000000041667");
    expect(num(-4.1667e-8, 12)).toBe("-0.000000041667");
    expect(num(10, 0)).toBe("10");
  });

  it("writes tiny positive fit factors as decimals and refuses factors rounded to zero", () => {
    const chart = { width: 640, height: 320, marks: [] };
    const tiny = readPdf(renderToPDF(chart, { pageSize: "A4", margin: 297.63999 }));
    expect(tiny.content).toContain("0.000000041667 0 0 0.000000041667");
    readPdf(renderToPDF({ ...chart, width: 1e9 }, { pageSize: "A4" }));
    expect(() => renderToPDF({ ...chart, width: 1e16 }, { pageSize: "A4" })).toThrow(
      /renderToPDF scale: fitting scale rounds to zero; reduce chart dimensions or margins/,
    );
    expect(() =>
      specToPDF({ version: 1, data: {}, ...chart, width: 1e16 }, { pageSize: "A4" }),
    ).toThrow(/specToPDF scale:.*; reduce/);
  });

  it("preserves single-chart metadata with fitting and with a one-item list", () => {
    const chart = { ...latency, title: "Chart", description: "Chart description", locale: "de-DE" };
    const spec: ChartSpec = {
      version: 1,
      width: chart.width,
      height: chart.height,
      title: chart.title,
      description: chart.description,
      locale: chart.locale,
      data: {},
      marks: [],
    };
    const baseline = readPdf(renderToPDF(chart));
    for (const settings of [
      {},
      { margin: 0 },
      { pageSize: "A4" as const },
      { title: "Report" },
      { language: "en-GB" },
      { subject: "Report description" },
    ]) {
      const single = readPdf(renderToPDF(chart, settings));
      expect(renderToPDF([chart], settings)).toEqual(renderToPDF(chart, settings));
      expect(specToPDF([spec], settings)).toEqual(specToPDF(spec, settings));
      expect(specToPDF({ spec, buffers: [] }, settings)).toEqual(specToPDF(spec, settings));
      expect(single.info).toContain(`/Title ${utf16(settings.title ?? chart.title)}`);
      expect(single.info).toContain(`/Subject ${utf16(settings.subject ?? chart.description)}`);
      expect(single.catalog).toContain(`/Lang (${settings.language ?? chart.locale})`);
      const fromSpec = readPdf(specToPDF(spec, settings));
      expect(fromSpec.info).toBe(single.info);
      expect(fromSpec.catalog.replace(/\d+ 0 R/g, "ref")).toBe(
        single.catalog.replace(/\d+ 0 R/g, "ref"),
      );
      if (!settings.title && !settings.subject) expect(single.info).toBe(baseline.info);
    }
    const report = readPdf(renderToPDF([chart, chart]));
    expect(report.info).not.toMatch(/\/(Title|Subject)/);
    expect(report.catalog).toContain("/Lang (en)");
  });

  it("scopes each chart's visible text to its locale inside the English Figure", () => {
    const locales = ["de-DE", "fr-FR"];
    const pdf = readPdf(
      renderToPDF(
        locales.map((locale) => ({ ...latency, locale })),
        { language: "en-GB" },
      ),
    );
    expect(pdf.catalog).toContain("/Lang (en-GB)");
    for (const [i, { content }] of pdf.pages.entries()) {
      expect(figureDictionary(pdf, i)).not.toContain("/Lang");
      assertMarkedContent(content);
      const scopes: { tag: string; locale?: string }[] = [];
      let operands: string[] = [];
      let texts = 0;
      for (const token of contentTokens(content, true)) {
        if (token === "BMC" || token === "BDC") {
          const lang = operands.indexOf("/Lang");
          scopes.push({
            tag: operands[0]!,
            ...(lang >= 0 && { locale: operands[lang + 1]!.slice(1, -1) }),
          });
          operands = [];
        } else if (token === "EMC") {
          scopes.pop();
          operands = [];
        } else if (token === "Tj" || token === "TJ") {
          expect(scopes.map((s) => s.tag)).toEqual(["/Figure", "/Span"]);
          expect(scopes.at(-1)!.locale).toBe(locales[i]);
          texts++;
          operands = [];
        } else if (
          ["BT", "ET", "Tf", "Tm", "q", "Q", "cm", "n", ...paintingOperators].includes(token)
        ) {
          operands = [];
        } else operands.push(token);
      }
      expect(scopes).toEqual([]);
      expect(texts).toBeGreaterThan(5);
    }
  });

  it.each([
    { locale: "en-US", language: "fr-FR", embedded: false },
    { locale: "fr-FR", language: "en-US", embedded: false },
    { locale: "en-US", language: "fr-FR", embedded: true },
    { locale: "fr-FR", language: "en-US", embedded: true },
  ])(
    "uses catalog $language for English alternatives with chart $locale (embedded fonts: $embedded)",
    ({ locale, language, embedded }) => {
      const chart: PdfOptions = {
        width: 320,
        height: 160,
        locale,
        theme: { font: "Fixture" },
        marks: [line(table({ x: [0, 1], y: [2, 3] }), { x: "x", y: "y" })],
      };
      const spec: ChartSpec = {
        version: 1,
        width: chart.width,
        height: chart.height,
        locale,
        theme: { font: "Fixture" },
        data: { d: { columns: { x: [0, 1], y: [2, 3] } } },
        marks: [{ type: "line", data: "d", x: "x", y: "y" }],
      };
      const buffered = {
        spec: {
          ...spec,
          data: {
            d: {
              columns: {
                x: { type: "number", dtype: "float64", buffer: 0 },
                y: { type: "number", dtype: "float64", buffer: 1 },
              },
            },
          },
        } satisfies ChartSpec,
        buffers: [new Float64Array([0, 1]), new Float64Array([2, 3])],
      };
      const settings = {
        language,
        ...(embedded && { fonts: pdfFonts(embeddedFonts) }),
      };
      for (const count of [0, 1, 2]) {
        for (const bytes of [
          renderToPDF(count ? Array.from({ length: count }, () => chart) : chart, settings),
          specToPDF(count ? Array.from({ length: count }, () => spec) : spec, settings),
          specToPDF(count ? Array.from({ length: count }, () => buffered) : buffered, settings),
        ]) {
          const pdf = readPdf(bytes);
          expect(pdf.catalog).toContain(`/Lang (${language})`);
          expect(pdf.pages).toHaveLength(count || 1);
          for (const [i, { content }] of pdf.pages.entries()) {
            expect(figureAlt(pdf, i)).toMatch(/^Line chart with 1 series\./);
            if (language === "fr-FR") expect(figureDictionary(pdf, i)).toContain("/Lang (en)");
            else expect(figureDictionary(pdf, i)).not.toContain("/Lang");
            expect(content).toContain(`/Span << /Lang (${locale}) >> BDC`);
            assertMarkedContent(content);
          }
        }
      }
    },
  );

  it.skipIf(!installed("pdftoppm"))(
    "renders overflowing titles and rule labels inside each fitted chart",
    () => {
      const directory = mkdtempSync(join(tmpdir(), "herceg-pdf-overflow-"));
      try {
        const chart = {
          ...latency,
          width: 300,
          height: 150,
          title: "W".repeat(80),
          marks: [...latency.marks, rule({ y: 250, label: "W".repeat(80) })],
        };
        const plain = readPdf(renderToPDF(chart));
        expect(plain.content).toContain(`(${"W".repeat(80)}) Tj`);
        for (const settings of [{ pageSize: "A4" as const }, { margin: 36 }]) {
          const bytes = renderToPDF(
            [chart, { ...chart, title: `Second ${chart.title}` }],
            settings,
          );
          const pdf = readPdf(bytes);
          const file = join(directory, "overflow.pdf");
          writeFileSync(file, bytes);
          for (const [i, { page, content }] of pdf.pages.entries()) {
            expect(content).toContain("cm\n0 0 300 150 re W n\n");
            expect(content.match(/re W n/g)!.length).toBeGreaterThan(1);
            const result = spawnSync(
              "pdftoppm",
              ["-r", "72", "-f", String(i + 1), "-l", String(i + 1), "-singlefile", file],
              { maxBuffer: 10 * 1024 * 1024 },
            );
            expect(result.status).toBe(0);
            expect(result.stderr.toString()).toBe("");
            const header = /^P6\s+(\d+)\s+(\d+)\s+255\s/.exec(result.stdout.toString("latin1"))!;
            expect(header).not.toBeNull();
            const width = Number(header[1]),
              height = Number(header[2]);
            const pixels = result.stdout.subarray(header[0].length);
            expect(pixels.length).toBe(width * height * 3);
            const box = /\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/.exec(page)!;
            const pw = Number(box[1]),
              ph = Number(box[2]);
            const scale = settings.pageSize ? Math.min((pw - 72) / 300, (ph - 72) / 150) : 0.75;
            const x = (pw - 300 * scale) / 2,
              y = (ph - 150 * scale) / 2;
            let ink = 0,
              overflow = 0;
            for (let row = 0; row < height; row++)
              for (let col = 0; col < width; col++) {
                const at = (row * width + col) * 3;
                if (pixels[at]! < 250 || pixels[at + 1]! < 250 || pixels[at + 2]! < 250) {
                  ink++;
                  // Allow the edge pixel's antialiasing and point-to-pixel rounding.
                  if (
                    col < x - 1 ||
                    col > x + 300 * scale + 1 ||
                    row < y - 1 ||
                    row > y + 150 * scale + 1
                  )
                    overflow++;
                }
              }
            expect(ink).toBeGreaterThan(100);
            expect(overflow, `page ${i + 1} paints outside its chart rectangle`).toBe(0);
          }
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("orders pages, isolates resources, and tags each chart under one Document", () => {
    const options = { ...latency, title: "Page one", locale: "de-DE" };
    const cells = {
      width: 300,
      height: 500,
      title: "Page two",
      marks: [
        heatmap(table({ x: [0, 1], y: [0, 0], v: [1, null] }), { x: "x", y: "y", color: "v" }),
      ],
    };
    const pdf = readPdf(renderToPDF([options, cells], { title: "Report", language: "fr-FR" }));
    expect(pdf.pages).toHaveLength(2);
    expect(pdf.pages[0]!.page).toContain("/MediaBox [0 0 360 180]");
    expect(pdf.pages[1]!.page).toContain("/MediaBox [0 0 225 375]");
    expect(pdf.pages[0]!.page).not.toContain("/XObject");
    expect(pdf.pages[1]!.page).toContain("/XObject");
    expect(pdf.pages[1]!.page).toContain("/Shading");
    expect(pdf.info).toContain(`/Title ${utf16("Report")}`);
    expect(pdf.catalog).toContain("/Lang (fr-FR)");
    expect(figureAlt(pdf, 0)).toContain("Page one");
    expect(figureAlt(pdf, 1)).toContain("Page two");
    for (const { page, content } of pdf.pages) {
      const tokens = [...contentTokens(content)];
      for (let i = 0; i < tokens.length; i++) {
        const operator = tokens[i]!;
        if (["Tf", "Do", "sh", "gs"].includes(operator)) {
          const name = tokens[i - (operator === "Tf" ? 2 : 1)]!;
          expect(page).toMatch(new RegExp(`${name} (?:\\d+ 0 R|<<)`));
        }
      }
    }
    expect(ref(pdf.pages[0]!.page, "F1")).toBe(ref(pdf.pages[1]!.page, "F1"));
  });

  it.each(["A4", "Letter"] as const)(
    "fits and centers vectors on %s in either orientation",
    (pageSize) => {
      for (const orientation of ["portrait", "landscape"] as const) {
        const pdf = readPdf(
          renderToPDF(
            [
              { width: 1000, height: 100, marks: [] },
              { width: 100, height: 1000, marks: [] },
            ],
            { pageSize, orientation, margin: 40 },
          ),
        );
        const [pw, ph] = pageSize === "A4" ? [595.28, 841.89] : [612, 792];
        const [w, h] = orientation === "portrait" ? [pw, ph] : [ph, pw];
        for (let i = 0; i < 2; i++) {
          const { page, content } = pdf.pages[i]!;
          expect(page).toContain(`/MediaBox [0 0 ${w} ${h}]`);
          const [base, , , , , top] = content.split("\n")[0]!.split(" ").map(Number);
          const [scale, , , , x, y] = content.split("\n")[1]!.split(" ").map(Number);
          const sx = base! * scale!;
          const sy = -sx;
          const tx = base! * x!;
          const ty = top! - base! * y!;
          const [cw, ch] = i === 0 ? [1000, 100] : [100, 1000];
          expect(sx).toBeCloseTo(Math.min((w - 80) / cw, (h - 80) / ch), 6);
          expect(sy).toBe(-sx!);
          expect(tx! + (sx! * cw) / 2).toBeCloseTo(w / 2, 2);
          expect(ty! - (sx! * ch) / 2).toBeCloseTo(h / 2, 2);
          expect(tx!).toBeGreaterThanOrEqual(40 - 0.01);
          expect(ty!).toBeLessThanOrEqual(h - 40 + 0.01);
          assertMarkedContent(content);
        }
      }
      const enlarged = readPdf(
        renderToPDF({ width: 100, height: 50, title: "Small", marks: [] }, { pageSize }),
      );
      expect(Number(enlarged.content.split("\n")[1]!.split(" ")[0])).toBeGreaterThan(1);
      expect(enlarged.content).toContain("(Small) Tj");
      expect(enlarged.page).not.toContain("/XObject");
    },
  );

  it("adds chart-sized margins without changing chart titles", () => {
    const pdf = readPdf(
      renderToPDF(
        { width: 100, height: 50, title: "Chart", marks: [] },
        { margin: 10, title: "Document" },
      ),
    );
    expect(pdf.page).toContain("/MediaBox [0 0 95 57.5]");
    expect(pdf.content).toMatch(/^0.75 0 0 -0.75 0 57.5 cm\n1 0 0 1 13.33 13.33 cm/);
    expect(pdf.content).toContain("(Chart) Tj");
    expect(pdf.content).not.toContain("(Document) Tj");
    expect(figureAlt(pdf)).toBe("Chart");
    expect(pdf.info).toContain(`/Title ${utf16("Document")}`);
    expect(
      readPdf(renderToPDF([{ width: 100, height: 50, marks: [], title: "Chart" }])).info,
    ).toContain(`/Title ${utf16("Chart")}`);
  });

  it("unions glyphs once per face, including later-page glyphs and fallback", () => {
    const fonts = pdfFonts(embeddedFonts, { fallback: ["Symbols"] });
    const charts = ["é", "Ω Мир 𝌀"].map((title) => ({
      width: 320,
      height: 120,
      marks: [],
      title,
      theme: { font: "Fixture" },
    }));
    const bytes = renderToPDF(charts, { fonts });
    const pdf = readPdf(bytes);
    const fontIds = pdf.pages.map(({ page }) =>
      [...page.matchAll(/\/F\d+ (\d+) 0 R/g)].map((m) => Number(m[1])),
    );
    expect(
      fontIds[1]!.every(
        (id) =>
          fontIds[0]!.includes(id) || pdf.objects.get(id)!.dictionary.includes("/Subtype /Type0"),
      ),
    ).toBe(true);
    const shared = fontIds[0]!.filter((id) => fontIds[1]!.includes(id));
    expect(shared.length).toBeGreaterThan(0);
    expect(embeddedPrograms(pdf)).toHaveLength(2);
    const mappings = [...pdf.objects.values()]
      .filter((o) => o.stream?.includes(Buffer.from("begincmap")))
      .map((o) => o.stream!.toString("ascii"))
      .join("\n");
    for (const code of ["00e9", "03a9", "041c", "d834df00"]) expect(mappings).toContain(code);
    figureAlt(pdf, 1);
    renderToPDF({ ...charts[0]!, title: "Different" }, { fonts });
    expect(renderToPDF(charts, { fonts })).toEqual(bytes);
    expect(renderToPDF([charts[0]!], { fonts })).toEqual(renderToPDF([{ ...charts[0]!, fonts }]));
    expect(() =>
      renderToPDF([
        { ...charts[0]!, fonts },
        { ...charts[1]!, fonts: pdfFonts(embeddedFonts) },
      ]),
    ).toThrow(/conflicting chart font configurations/);
    expect(() =>
      renderToPDF(
        [
          { ...charts[0]!, fonts },
          { ...charts[1]!, fonts: pdfFonts(embeddedFonts) },
        ],
        { fonts },
      ),
    ).not.toThrow();
  });

  it("loads independent binary sidecars for each spec page", () => {
    const make = (title: string): ChartSpec => ({
      version: 1,
      width: 320,
      height: 120,
      title,
      data: {
        d: {
          columns: {
            x: { type: "number", dtype: "float64", buffer: 0 },
            y: { type: "number", dtype: "float64", buffer: 1 },
          },
        },
      },
      marks: [{ type: "line", data: "d", x: "x", y: "y" }],
    });
    const a = {
      spec: make("First"),
      buffers: [new Float64Array([0, 1]), new Float64Array([10, 20])],
    };
    const b = {
      spec: make("Second"),
      buffers: [new Float64Array([4, 5]), new Float64Array([90, 100])],
    };
    expect(specToPDF(a)).toEqual(specToPDF([a]));
    expect(() =>
      // @ts-expect-error sidecars travel with their spec
      specToPDF(a.spec, a.buffers),
    ).toThrow(/specToPDF settings:.*; use \{ spec, buffers \}/);
    const pdf = readPdf(specToPDF([a, b], { title: "Report", pageSize: "Letter" }));
    expect(pdf.pages[0]!.content).toContain("(10) Tj");
    expect(pdf.pages[1]!.content).toContain("(100) Tj");
    expect(figureAlt(pdf, 0)).toContain("First");
    expect(figureAlt(pdf, 1)).toContain("Second");
    expect(
      readPdf(specToPDF([make("a"), make("b")].map((spec) => ({ ...spec, data: {}, marks: [] }))))
        .pages,
    ).toHaveLength(2);
    expect(() => specToPDF([a, { ...b, buffers: [] }])).toThrow(/buffer/);
  });

  it("rejects empty documents and invalid page settings", () => {
    expect(() => renderToPDF([])).toThrow(/renderToPDF charts:.*; supply/);
    expect(() => specToPDF([])).toThrow(/at least one chart/);
    const chart = { width: 100, height: 100, marks: [] };
    for (const margin of [-1, Infinity, NaN])
      expect(() => renderToPDF(chart, { margin })).toThrow(/renderToPDF margin:/);
    expect(() => renderToPDF(chart, { pageSize: "A4", margin: 300 })).toThrow(
      /no usable page area/,
    );
    expect(() => renderToPDF(chart, { orientation: "landscape" })).toThrow(/orientation:/);
    // @ts-expect-error invalid named page
    expect(() => renderToPDF(chart, { pageSize: "Legal" })).toThrow(/pageSize:/);
    for (const width of [0, -1, Infinity, NaN])
      expect(() => renderToPDF({ ...chart, width })).toThrow(/renderToPDF size:/);
  });
});

it("paints isolated line and area rows with stroke-sized round caps in PDF", () => {
  const data = table({ x: [0, 1, 2, 3, 4], y: [1, NaN, 3, NaN, 5] });
  for (const mark of [
    line(data, { x: "x", y: "y", stroke: "#c02040", strokeWidth: 4 }),
    area(data, { x: "x", y: "y", stroke: "#c02040", strokeWidth: 4 }),
    area(data, { x: "x", y: "y", fill: "#c02040", strokeWidth: 4, line: false }),
    line(data, {
      x: "x",
      y: "y",
      orient: "y",
      stroke: "#c02040",
      strokeWidth: 4,
      curve: "step-after",
    }),
  ]) {
    const { content } = readPdf(renderToPDF({ marks: [mark], width: 300, height: 150 }));
    expect(content).toMatch(/4 w/);
    expect(content).toMatch(/1 J/);
    expect(content.match(/([\d.-]+ [\d.-]+) m\n\1 l/g)).toHaveLength(3);
  }
});

it("uses the surface for saturated text halos in PDF and honors halo:false", () => {
  const data = table({ x: [1], y: [1] });
  for (const halo of [true, false]) {
    const mark = text({ x: 1, y: 1, label: "contrast", fill: "#e06600", halo });
    const config = { marks: [line(data, { x: "x", y: "y" }), mark], width: 300, height: 150 };
    const { content } = readPdf(renderToPDF(config));
    expect(content.includes("/ActualText ()")).toBe(halo);
    if (halo) expect(content).toMatch(/1 1 1 RG 3 w 1 j/);
    const svg = renderToSVG(config);
    expect(svg.includes('stroke="#ffffff" stroke-opacity="1"')).toBe(halo);
  }
});

it.each([
  ["-", "[] 0 d"],
  ["--", "[7.4 3.2] 0 d"],
  [":", "[2 3.3] 0 d"],
  ["-.", "[12.8 3.2 2 3.2] 0 d"],
] as const)("exports dash %s in lines, rules, and custom shapes to PDF", (dash, command) => {
  const data = table({ x: [0, 1], y: [1, 2] });
  const marks = [
    line(data, { x: "x", y: "y", dash, strokeWidth: 2 }),
    rule({ y: 1, dash, strokeWidth: 2 }),
    custom({
      draw({ path }) {
        path("M0 0L10 10", { stroke: "red", strokeWidth: 2, dash });
      },
    }),
  ];
  const pdf = readPdf(renderToPDF({ marks, width: 400, height: 200 }));
  if (dash === "-") expect(pdf.content).not.toMatch(/\[(?:[\d.]+ ?)+\] 0 d/);
  else expect(pdf.content.split(command)).toHaveLength(4);
});
