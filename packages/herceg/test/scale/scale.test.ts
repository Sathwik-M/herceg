import { describe, expect, it } from "vitest";
import { numberTickLabels, timeTickLabels } from "../../src/format/format.ts";
import { fromWall, toWall, zoneOffset } from "../../src/format/zone.ts";
import { isLightColor } from "../../src/scale/color.ts";
import { BandScale, LinearScale, LogScale, niceLogDomain } from "../../src/scale/scale.ts";
import { linearTicks, niceDomain, tickStep } from "../../src/scale/ticks.ts";
import { chooseInterval, niceTimeDomain, TimeScale, timeTicks } from "../../src/scale/time.ts";

const utc = (iso: string) => Date.parse(`${iso}Z`);

describe("linear ticks", () => {
  it("uses 1, 2, 5 steps", () => {
    expect(tickStep(0, 10, 5)).toBe(2);
    expect(tickStep(0, 1, 10)).toBe(0.1);
    expect(tickStep(0, 100, 3)).toBe(50);
  });

  it("produces exact decimal ticks", () => {
    expect(linearTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(linearTicks(0.1, 0.35, 5)).toEqual([0.1, 0.15, 0.2, 0.25, 0.3, 0.35]);
    expect(linearTicks(-3, 3, 6)).toEqual([-3, -2, -1, 0, 1, 2, 3]);
  });

  it("handles degenerate input", () => {
    expect(linearTicks(5, 5, 5)).toEqual([5]);
    expect(linearTicks(0, Number.NaN, 5)).toEqual([]);
    expect(linearTicks(10, 0, 5)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it("terminates when the step is below the values' precision", () => {
    expect(linearTicks(1, 1 + Number.EPSILON, 10)).toEqual([1, 1 + Number.EPSILON]);
    expect(linearTicks(5e-324, 1e-323, 10).length).toBeGreaterThan(0);
  });

  it("handles very large and very small magnitudes", () => {
    expect(linearTicks(0, 3e12, 3)).toEqual([0, 1e12, 2e12, 3e12]);
    expect(linearTicks(0, 3e-9, 3)).toEqual([0, 1e-9, 2e-9, 3e-9]);
  });

  it("labels a zero tick without a minus sign", () => {
    // Math.ceil(-0.25) is -0, so ticks across zero can start at negative zero.
    const ticks = linearTicks(-0.5, 21.5, 10);
    expect(numberTickLabels(ticks, "en-US")[0]).toBe("0");
  });

  it("extends domains to nice values", () => {
    expect(niceDomain(0.13, 9.7, 10)).toEqual([0, 10]);
    expect(niceDomain(-12, 87, 5)).toEqual([-20, 100]);
    expect(niceDomain(9.7, 0.13, 10)).toEqual([10, 0]);
  });
});

describe("LinearScale", () => {
  it("maps and inverts", () => {
    const scale = new LinearScale([0, 10], [100, 0]);
    expect(scale.map(0)).toBe(100);
    expect(scale.map(5)).toBe(50);
    expect(scale.invert(25)).toBe(7.5);
  });

  it("keeps precision for narrow domains far from zero", () => {
    const scale = new LinearScale([1e15, 1e15 + 1], [0, 100]);
    expect(scale.map(1e15 + 1)).toBe(100);
    const zoomed = new LinearScale([1_767_225_600_000, 1_767_225_600_010], [0, 1000]);
    expect(zoomed.map(1_767_225_600_005)).toBe(500);
    expect(zoomed.invert(500)).toBe(1_767_225_600_005);
  });

  it("does not overflow for opposite extreme endpoints", () => {
    const scale = new LinearScale([-Number.MAX_VALUE, Number.MAX_VALUE], [0, 100]);
    expect(scale.map(0)).toBeCloseTo(50);
  });

  it("maps a zero-width domain to the middle of the range", () => {
    const scale = new LinearScale([3, 3], [0, 100]);
    expect(scale.map(3)).toBe(50);
    expect(scale.invert(10)).toBe(3);
  });
});

describe("LogScale", () => {
  it("maps decades evenly", () => {
    const scale = new LogScale([1, 1000], [0, 300]);
    expect(scale.map(10)).toBeCloseTo(100);
    expect(scale.invert(200)).toBeCloseTo(100);
    expect(scale.map(-1)).toBeNaN();
  });

  it("ticks at powers of ten and multiples", () => {
    expect(new LogScale([1, 1e6], [0, 1]).ticks(10)).toEqual([1, 10, 100, 1e3, 1e4, 1e5, 1e6]);
    expect(new LogScale([1, 100], [0, 1]).ticks(10)).toEqual([1, 2, 5, 10, 20, 50, 100]);
  });

  it("rejects non-positive and infinite domains", () => {
    expect(() => new LogScale([0, 10], [0, 1])).toThrow(/positive/);
    expect(() => new LogScale([1, Number.POSITIVE_INFINITY], [0, 1])).toThrow(/finite/);
  });

  it("falls back to linear ticks within a decade", () => {
    expect(new LogScale([3, 4], [0, 100]).ticks(5).length).toBeGreaterThanOrEqual(2);
  });

  it("extends reversed log domains outward", () => {
    expect(niceLogDomain(90, 2)).toEqual([100, 1]);
  });
});

describe("BandScale", () => {
  it("lays out equal bands with equal gaps", () => {
    const scale = new BandScale(["a", "b", "c"], [0, 310], 0.1);
    expect(scale.step).toBeCloseTo(100);
    expect(scale.bandwidth).toBeCloseTo(90);
    expect(scale.start(0)).toBeCloseTo(10);
    expect(scale.start(2) + scale.bandwidth).toBeCloseTo(300);
    expect(scale.map(1)).toBeCloseTo(155);
    expect(scale.index(55)).toBe(0);
    expect(scale.index(150)).toBe(1);
    expect(scale.index(400)).toBe(-1);
    expect(scale.invert(scale.map(2))).toBeCloseTo(2);
  });

  it("works on reversed ranges and thins ticks", () => {
    const scale = new BandScale(["a", "b", "c", "d"], [400, 0], 0);
    expect(scale.map(0)).toBeCloseTo(350);
    expect(scale.index(10)).toBe(3);
    expect(new BandScale(Array.from({ length: 100 }, String), [0, 1]).ticks(10)).toHaveLength(10);
  });
});

describe("time ticks", () => {
  it("chooses calendar intervals", () => {
    expect(chooseInterval(60_000, 6)).toMatchObject({ unit: "second", step: 10 });
    expect(chooseInterval(24 * 3_600_000, 8)).toMatchObject({ unit: "hour", step: 3 });
    expect(chooseInterval(365 * 86_400_000, 12)).toMatchObject({ unit: "month", step: 1 });
    expect(chooseInterval(50, 5)).toMatchObject({ unit: "millisecond", step: 10 });
  });

  it("aligns hour ticks to the day in UTC", () => {
    const start = utc("2026-03-01T01:20:00");
    const stop = utc("2026-03-01T13:00:00");
    const ticks = timeTicks(start, stop, { unit: "hour", step: 3, duration: 3 * 3_600_000 }, "UTC");
    expect(ticks.map((t) => new Date(t).toISOString().slice(11, 16))).toEqual([
      "03:00",
      "06:00",
      "09:00",
      "12:00",
    ]);
  });

  it("aligns day ticks to local midnight in a time zone", () => {
    const zone = "America/New_York";
    const ticks = timeTicks(
      utc("2026-03-01T00:00:00"),
      utc("2026-03-04T00:00:00"),
      chooseInterval(3 * 86_400_000, 3),
      zone,
    );
    // Midnight in New York is 05:00 UTC in winter.
    expect(ticks.map((t) => new Date(t).toISOString())).toEqual([
      "2026-03-01T05:00:00.000Z",
      "2026-03-02T05:00:00.000Z",
      "2026-03-03T05:00:00.000Z",
    ]);
  });

  it("keeps day ticks at midnight across a DST change", () => {
    const zone = "Europe/Belgrade";
    // DST starts 2026-03-29 02:00 local.
    const ticks = timeTicks(
      utc("2026-03-27T00:00:00"),
      utc("2026-03-31T00:00:00"),
      { unit: "day", step: 1, duration: 86_400_000 },
      zone,
    );
    expect(ticks.map((t) => toWall(zone, t) % 86_400_000)).toEqual([0, 0, 0, 0]);
    expect(ticks[2]! - ticks[1]!).toBe(23 * 3_600_000);
  });

  it("handles zones with 45-minute offsets", () => {
    const zone = "Asia/Kathmandu";
    expect(zoneOffset(zone, utc("2026-06-01T00:00:00"))).toBe((5 * 60 + 45) * 60_000);
    const ticks = timeTicks(
      utc("2026-06-01T00:00:00"),
      utc("2026-06-01T06:00:00"),
      { unit: "hour", step: 1, duration: 3_600_000 },
      zone,
    );
    expect(ticks.every((t) => toWall(zone, t) % 3_600_000 === 0)).toBe(true);
  });

  it("resolves skipped wall times forward and repeated ones to the earlier instant", () => {
    const zone = "America/New_York";
    // 2026-03-08 02:30 does not exist; clocks read 03:30 EDT.
    expect(new Date(fromWall(zone, utc("2026-03-08T02:30:00"))).toISOString()).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    // 2026-11-01 01:30 happens twice; the first is EDT.
    expect(new Date(fromWall(zone, utc("2026-11-01T01:30:00"))).toISOString()).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });

  it("never repeats or reverses ticks across a spring-forward change", () => {
    const zone = "America/New_York";
    const halfHours = { unit: "minute" as const, step: 30, duration: 1_800_000 };
    const ticks = timeTicks(
      utc("2026-03-08T05:00:00"),
      utc("2026-03-08T09:00:00"),
      halfHours,
      zone,
    );
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]!).toBeGreaterThan(ticks[i - 1]!);
    expect(ticks.map((t) => new Date(toWall(zone, t)).toISOString().slice(11, 16))).toEqual([
      "00:00",
      "00:30",
      "01:00",
      "01:30",
      "03:00",
      "03:30",
      "04:00",
      "04:30",
      "05:00",
    ]);
  });

  it("keeps both occurrences of a repeated hour when clocks fall back", () => {
    const zone = "America/New_York";
    const hours = { unit: "hour" as const, step: 1, duration: 3_600_000 };
    const ticks = timeTicks(utc("2026-11-01T04:00:00"), utc("2026-11-01T08:00:00"), hours, zone);
    expect(ticks.map((t) => new Date(toWall(zone, t)).toISOString().slice(11, 13))).toEqual([
      "00",
      "01",
      "01",
      "02",
      "03",
    ]);
  });

  it("round-trips wall times", () => {
    const zone = "Australia/Adelaide";
    const t = utc("2026-01-15T10:30:00");
    expect(fromWall(zone, toWall(zone, t))).toBe(t);
  });

  it("extends a time domain to interval boundaries", () => {
    const [lo, hi] = niceTimeDomain(
      utc("2026-01-01T00:07:00"),
      utc("2026-01-01T00:52:00"),
      6,
      "UTC",
    );
    expect(new Date(lo).toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(new Date(hi).toISOString()).toBe("2026-01-01T01:00:00.000Z");
  });

  it("encloses times in the hour repeated when daylight saving time ends", () => {
    const zone = "America/New_York";
    // 06:00Z and 06:15Z are 01:00 and 01:15 EST, the second 1 o'clock hour.
    for (const [start, stop] of [
      ["2026-11-01T06:00:00", "2026-11-01T06:15:00"],
      ["2026-11-01T06:10:00", "2026-11-01T06:10:30"],
    ] as const) {
      const [lo, hi] = niceTimeDomain(utc(start), utc(stop), 6, zone);
      expect(lo).toBeLessThanOrEqual(utc(start));
      expect(hi).toBeGreaterThanOrEqual(utc(stop));
    }
  });

  it("uses year ticks for long spans", () => {
    const scale = new TimeScale(
      [utc("1900-01-01T00:00:00"), utc("2000-01-01T00:00:00")],
      [0, 1],
      "UTC",
    );
    expect(scale.ticks(5).map((t) => new Date(t).getUTCFullYear())).toEqual([
      1900, 1920, 1940, 1960, 1980, 2000,
    ]);
  });
});

describe("tick labels", () => {
  it("formats numbers with the decimals the step needs", () => {
    expect(numberTickLabels([0, 0.5, 1], "en-US")).toEqual(["0.0", "0.5", "1.0"]);
    expect(numberTickLabels([0, 2000, 4000], "en-US")).toEqual(["0", "2,000", "4,000"]);
    expect(numberTickLabels([0, 2.5e6, 5e6], "en-US")).toEqual(["0", "2.5M", "5M"]);
  });

  it("keeps tiny ticks distinguishable", () => {
    const labels = numberTickLabels([0, 1e-16, 2e-16], "en-US");
    expect(new Set(labels).size).toBe(3);
  });

  it("labels time ticks by alignment", () => {
    const ticks = [
      utc("2026-01-01T18:00:00"),
      utc("2026-01-02T00:00:00"),
      utc("2026-01-02T06:00:00"),
    ];
    expect(
      timeTickLabels(ticks, { unit: "hour", step: 6, duration: 6 * 3_600_000 }, "UTC", "en-US"),
    ).toEqual(["18:00", "Jan 2", "06:00"]);
    const months = [
      utc("2025-11-01T00:00:00"),
      utc("2025-12-01T00:00:00"),
      utc("2026-01-01T00:00:00"),
    ];
    expect(
      timeTickLabels(months, { unit: "month", step: 1, duration: 30 * 86_400_000 }, "UTC", "en-US"),
    ).toEqual(["Nov", "Dec", "2026"]);
  });
});

describe("isLightColor", () => {
  it("reads hex, rgb(), and hsl() colors and leaves names undecided", () => {
    expect(isLightColor("#fff")).toBe(true);
    expect(isLightColor("#0b0b0b")).toBe(false);
    expect(isLightColor("rgb(255, 255, 255)")).toBe(true);
    expect(isLightColor("rgb(255 255 255 / 50%)")).toBe(true);
    expect(isLightColor("rgba(10, 10, 10, 0.5)")).toBe(false);
    expect(isLightColor("rgb(100%, 100%, 100%)")).toBe(true);
    expect(isLightColor("hsl(60, 100%, 50%)")).toBe(true);
    expect(isLightColor("hsl(240 100% 25%)")).toBe(false);
    expect(isLightColor("white")).toBeUndefined();
  });
});
