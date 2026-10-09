import { describe, expect, it } from "vitest";
import { estimateText, fontKind } from "../../src/layout/text.ts";
import { measurePdfText } from "../../src/render/pdf-fonts.ts";

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
