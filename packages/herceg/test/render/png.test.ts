import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { base64, encodePng } from "../../src/render/png.ts";
import { SequentialScale } from "../../src/scale/color.ts";

describe("encodePng", () => {
  it("produces a valid PNG with the original pixels", () => {
    const width = 3;
    const height = 2;
    const pixels = new Uint8ClampedArray(width * height * 4).map((_, i) => (i * 37) % 256);
    const png = encodePng(width, height, pixels);
    expect(Array.from(png.subarray(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const view = new DataView(png.buffer);
    let at = 8;
    const chunks: Record<string, Uint8Array> = {};
    while (at < png.length) {
      const length = view.getUint32(at);
      const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
      const data = png.subarray(at + 8, at + 8 + length);
      expect(view.getUint32(at + 8 + length)).toBe(crc32(png.subarray(at + 4, at + 8 + length)));
      chunks[type] = data;
      at += 12 + length;
    }
    expect(Object.keys(chunks)).toEqual(["IHDR", "IDAT", "IEND"]);
    const raw = inflateSync(chunks.IDAT!);
    for (let y = 0; y < height; y++) {
      expect(raw[y * (width * 4 + 1)]).toBe(0);
      expect(Array.from(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)))).toEqual(
        Array.from(pixels.subarray(y * width * 4, (y + 1) * width * 4)),
      );
    }
  });

  it("splits large images into several stored blocks", () => {
    const pixels = new Uint8ClampedArray(300 * 300 * 4).fill(7);
    const png = encodePng(300, 300, pixels);
    const idat = png.indexOf(0x49, 33); // locate "IDAT"
    expect(idat).toBeGreaterThan(0);
    expect(png.length).toBeGreaterThan(pixels.length);
  });

  it("base64-encodes like the platform", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253]);
    expect(base64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("SequentialScale", () => {
  const scale = new SequentialScale([0, 100], ["#000000", "#ffffff"]);
  it("interpolates between stops", () => {
    expect(scale.color(0)).toBe("#000000");
    expect(scale.color(100)).toBe("#ffffff");
    // The 256-entry table resolves colors to within half a step.
    expect(["#7f7f7f", "#808080"]).toContain(scale.color(50));
  });

  it("clamps out-of-domain values and leaves missing values transparent", () => {
    expect(scale.color(-5)).toBe("#000000");
    expect(scale.color(500)).toBe("#ffffff");
    const out = new Uint8ClampedArray(4).fill(9);
    scale.write(Number.NaN, out, 0);
    expect(out[3]).toBe(0);
  });
});
