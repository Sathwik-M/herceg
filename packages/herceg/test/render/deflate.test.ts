import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { zlibCompress } from "../../src/render/deflate.ts";

function roundTrip(data: Uint8Array): Uint8Array {
  const packed = zlibCompress(data);
  expect(Buffer.compare(inflateSync(packed), Buffer.from(data))).toBe(0);
  return packed;
}

/** Deterministic pseudo-random bytes. */
function noise(length: number, seed = 1): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    out[i] = state >>> 24;
  }
  return out;
}

describe("zlibCompress", () => {
  it("writes streams zlib inflates back to the input", () => {
    roundTrip(new Uint8Array(0));
    roundTrip(Uint8Array.of(7));
    roundTrip(Uint8Array.of(1, 2));
    roundTrip(Uint8Array.of(9, 9, 9));
    roundTrip(noise(100_000));
  });

  it("finds repeats, including long runs and matches across the whole window", () => {
    expect(roundTrip(new Uint8Array(500_000)).length).toBeLessThan(5000);
    const pattern = noise(40_000, 7);
    const repeated = new Uint8Array(pattern.length * 3);
    for (let i = 0; i < 3; i++) repeated.set(pattern, i * pattern.length);
    roundTrip(repeated);
    // The second copy starts exactly one window (32,768 bytes) after the first.
    const block = noise(32_768, 3);
    const window = new Uint8Array(block.length * 2);
    window.set(block);
    window.set(block, block.length);
    expect(roundTrip(window).length).toBeLessThan(block.length * 1.2);
  });

  it("compresses content-stream text", () => {
    const text = Array.from(
      { length: 2000 },
      (_, i) => `${(i * 0.4).toFixed(2)} ${(100 + Math.sin(i / 30) * 40).toFixed(2)} l\n`,
    ).join("");
    const bytes = Uint8Array.from(text, (c) => c.charCodeAt(0));
    expect(roundTrip(bytes).length).toBeLessThan(bytes.length * 0.6);
  });

  it("spends at most 9 bits per byte on data without repeats", () => {
    const data = noise(10_000, 11);
    expect(roundTrip(data).length).toBeLessThanOrEqual(Math.ceil((data.length * 9) / 8) + 16);
  });
});
