import { describe, expect, it } from "vitest";
import {
  estimateText,
  fontKind,
  textBox,
  textItem,
  textItems,
  textLines,
} from "../../src/layout/text.ts";
import { measurePdfText } from "../../src/render/pdf-fonts.ts";
import { plainColor } from "../../src/scale/color.ts";
import { cssColor } from "../../src/scale/css-color.ts";
import { haloOf, textPaint } from "../../src/style/style.ts";

describe("text estimates", () => {
  it("scale with the font size and pad Helvetica widths by a tenth", () => {
    expect(estimateText("iiii", "12px sans-serif")).toBeCloseTo(4 * 0.222 * 12 * 1.1);
    expect(estimateText("iiii", "24px sans-serif")).toBeCloseTo(2 * estimateText("iiii", "12px x"));
  });

  it("give monospace fonts an even width per glyph", () => {
    const mono = estimateText("iiiiiiiiii", "12px ui-monospace, Menlo, monospace");
    expect(mono).toBeCloseTo(10 * 0.6 * 12 * 1.1);
    expect(estimateText("WWWWWWWWWW", "12px Courier")).toBeCloseTo(mono);
  });

  it("read font families in order, as the first recognized one draws", () => {
    expect(fontKind("Arial, monospace")).toBe("sans");
    expect(fontKind('"Fira Code", Monaco, monospace')).toBe("monospace");
    expect(fontKind("Unknown Face, Georgia, serif")).toBe("serif");
    expect(fontKind("Unknown Face")).toBe("sans");
    expect(estimateText("WWWWWWWWWW", "12px Arial, monospace")).toBeCloseTo(10 * 0.944 * 12 * 1.1);
    expect(estimateText("WWWWWWWWWW", "12px Monaco")).toBeCloseTo(10 * 0.6 * 12 * 1.1);
  });

  it("measure PDF text with the standard fonts' own widths", () => {
    expect(measurePdfText("iiiiiiiiiiiiiiiiiiii", "12px Georgia, serif")).toBeCloseTo(
      20 * 0.278 * 12,
    );
    expect(measurePdfText("iiiiiiiiii", "12px ui-monospace")).toBeCloseTo(10 * 0.6 * 12);
    // Titles are bold.
    expect(measurePdfText("Sales", "600 15px Inter, sans-serif")).toBeGreaterThan(
      measurePdfText("Sales", "15px Inter, sans-serif"),
    );
  });
});

describe("text layout", () => {
  const paint = textPaint([
    { font: "sans-serif", fontSize: 10, lineHeight: 1.2, color: "#333333" },
    { background: { fill: "#eeeeee" }, padding: { top: 1, right: 2, bottom: 3, left: 4 } },
  ]);
  const measure = (text: string) => text.length * 5;
  const at = { x: 100, y: 50, anchor: "start", baseline: "middle", angle: 0 } as const;

  it("breaks text into measured lines at line breaks", () => {
    expect(textLines("ab\ncdef", paint, measure)).toEqual({
      lines: ["ab", "cdef"],
      widths: [10, 20],
      width: 20,
      height: 24,
    });
  });

  it("boxes text around its lines, padded, wherever its point is on it", () => {
    const lines = textLines("ab\ncdef", paint, measure);
    expect(textBox(lines, at, paint)).toEqual({ x: 96, y: 43, width: 26, height: 28 });
    // Centered and ended text, and a box below a hanging first line.
    expect(textBox(lines, { ...at, anchor: "middle" }, paint).x).toBe(86);
    expect(textBox(lines, { ...at, anchor: "end" }, paint).x).toBe(76);
    expect(textBox(lines, { ...at, baseline: "hanging" }, paint).y).toBe(48);
  });

  it("makes guide items a line each, the first carrying the box and each the halo", () => {
    const items = textItems("ab\ncdef", at, { ...paint, halo: "auto" }, "#ffffff", measure);
    // The box starts where the text would and is centered on its first line
    // as the text would be; the text moves in by the padding (4 left, and
    // 1 above against 3 below).
    expect(items.map(({ text, x, y }) => [text, x, y])).toEqual([
      ["ab", 104, 49],
      ["cdef", 104, 61],
    ]);
    expect(items[0]!.box).toEqual({ x: 100, y: 42, width: 26, height: 28 });
    expect(items[1]!.box).toBeUndefined();
    // Text in a box is drawn on the box, whatever is under it.
    expect(items.map((item) => item.halo)).toEqual([
      { color: "#eeeeee", width: 3, opacity: 1 },
      { color: "#eeeeee", width: 3, opacity: 1 },
    ]);
    // One line is one item; without a background, nothing is measured.
    expect(textItem("ab\ncdef", at, paint, "#ffffff", measure).text).toBe("ab\ncdef");
    const plain = textPaint([{ fontSize: 10 }]);
    const unmeasured = textItems("ab", at, plain, "#ffffff", () => {
      throw new Error("measured");
    });
    expect(unmeasured).toEqual([
      {
        type: "text",
        text: "ab",
        x: 100,
        y: 50,
        anchor: "start",
        baseline: "middle",
        angle: 0,
        paint: plain,
      },
    ]);
  });

  it("stacks turned lines along the text's own down, moving a box's text in its turn", () => {
    const plain = textPaint([{ fontSize: 10, lineHeight: 1.2 }]);
    const items = textItems("a\nb", { ...at, angle: -90 }, plain, "#ffffff", measure);
    expect(items[1]!.x).toBeCloseTo(112);
    expect(items[1]!.y).toBeCloseTo(50);
    // Padded 4 at its start and 1 above against 3 below, read upward: the
    // text moves up by 4 and left by 1.
    const boxed = textItems("a\nb", { ...at, angle: -90 }, paint, "#ffffff", measure);
    expect([boxed[0]!.x, boxed[0]!.y]).toEqual([expect.closeTo(99), expect.closeTo(46)]);
  });

  it("gives halos the surface at 3:1 contrast, else black or white, reading plain colors", () => {
    expect(haloOf("auto", "#333333", "#ffffff", "#333333", plainColor)).toEqual({
      color: "#ffffff",
      width: 3,
      opacity: 1,
    });
    expect(haloOf("auto", "#999999", "#ffffff", "#333333", plainColor)).toEqual({
      color: "#000000",
      width: 3,
      opacity: 0.85,
    });
    // Names need the CSS color table, which guides leave out: the theme's text decides.
    expect(haloOf("auto", "red", "#ffffff", "#333333", plainColor)?.color).toBe("#ffffff");
    // Read with it, light text below 3:1 gets a dark halo.
    expect(haloOf("auto", "yellow", "white", "#333333", cssColor)).toEqual({
      color: "#000000",
      width: 3,
      opacity: 0.85,
    });
    expect(haloOf({ color: "#123456" }, "#000", "#fff", "#000", plainColor)).toEqual({
      color: "#123456",
      width: 3,
      opacity: 1,
    });
    expect(haloOf(false, "#000", "#fff", "#000", plainColor)).toBeUndefined();
  });
});
