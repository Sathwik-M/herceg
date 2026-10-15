// Portable format patterns: a d3-format subset for numbers, strftime for times.
import { describe, expect, it } from "vitest";
import { numberPattern, timePattern } from "../../src/format/patterns.ts";
import { GUIDE_KIT } from "../../src/model/guides.ts";

const number = (pattern: string, value: number, locale = "en-US") =>
  numberPattern(GUIDE_KIT, pattern, locale, "x.format.number")(value);

describe("number patterns", () => {
  it.each([
    [",.2f", 1234.567, "1,234.57"],
    [".2f", 1234.567, "1234.57"],
    ["d", 41.6, "42"],
    [",d", 1234567, "1,234,567"],
    [".1%", 0.1234, "12.3%"],
    ["~%", 0.5, "50%"],
    [".2s", 1500, "1.5k"],
    ["s", 1500, "1.50000k"],
    ["~s", 1500, "1.5k"],
    [".3s", 0.000123, "123µ"],
    [".2e", 12345, "1.23e+4"],
    ["~e", 12000, "1.2e+4"],
    [".2g", 1234, "1.2e+3"],
    [".3g", 12.345, "12.3"],
    ["", 0.1 + 0.2, "0.3"],
  ])("writes %j as d3-format does", (pattern, value, expected) => {
    expect(number(pattern, value)).toBe(expected);
  });

  it("writes signs", () => {
    expect(number("+.1f", 3)).toBe("+3.0");
    expect(number("(.1f", -3)).toBe("(3.0)");
    expect(number(" .1f", 3)).toBe(" 3.0");
    expect(number(".1f", -3)).toBe("-3.0");
  });

  it("writes values that round to zero without a minus sign", () => {
    expect(number(".0f", -0.4)).toBe("0");
    expect(number(".1f", -0.04)).toBe("0.0");
    expect(number(".1f", -0.06)).toBe("-0.1");
  });

  it("writes digits and separators in the chart's locale", () => {
    expect(number(",.2f", 1234.567, "de-DE")).toBe("1.234,57");
  });

  it("refuses what it cannot write, naming where", () => {
    expect(() => number("x", 1)).toThrow(/^x\.format\.number: "x" is not a number pattern/);
    // Padding, currency, and other bases are not in the subset.
    for (const pattern of ["08.2f", "$,.2f", ">8", "x", ".2r"])
      expect(() => number(pattern, 1)).toThrow(/with type d, f, e, g, s, or %/);
    expect(() => number(".0g", 1)).toThrow(/0 significant digits/);
  });
});

const at = Date.UTC(2026, 8, 29, 6, 5, 9, 7);
const time = (pattern: string, zone = "UTC", locale = "en-US") =>
  timePattern(GUIDE_KIT, pattern, zone, locale, "x.format.time")(at);

describe("time patterns", () => {
  it("writes strftime's fields in the scale's zone", () => {
    expect(time("%Y-%m-%d %H:%M:%S.%L")).toBe("2026-09-29 06:05:09.007");
    expect(time("%H:%M %z", "America/New_York")).toBe("02:05 -0400");
    expect(time("%a %A %b %B")).toBe("Tue Tuesday Sep September");
    expect(time("%I:%M %p")).toBe("06:05 AM");
    expect(time("%z")).toBe("+0000");
    expect(time("100%%")).toBe("100%");
  });

  it("pads numbers, unless the flag after % says not to", () => {
    expect(time("%-d %b %y")).toBe("29 Sep 26");
    expect(time("%m|%-m|%H|%-H")).toBe("09|9|06|6");
    expect(timePattern(GUIDE_KIT, "%e", "UTC", "en-US", "x")(Date.UTC(2026, 8, 3))).toBe(" 3");
  });

  it("writes names in the chart's locale", () => {
    expect(time("%B", "UTC", "fr-FR")).toBe("septembre");
  });

  it("refuses directives it does not read, naming where", () => {
    expect(() => time("%H %U")).toThrow(
      /^x\.format\.time: "%U" at character 4 of "%H %U" is not a time directive/,
    );
    expect(() => time("50%")).toThrow(/"%" at character 3/);
    expect(() => time("%-b")).toThrow(/"%-b" at character 1/);
  });
});
