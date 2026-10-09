import { describe, expect, it } from "vitest";
import { keyOwner, seriesKey } from "../../src/marks/mark.ts";

describe("keyOwner", () => {
  it("names the mark a series or item key belongs to, in either form", () => {
    expect(keyOwner(seriesKey(2, "cpu"))).toBe(2);
    expect(keyOwner(seriesKey("load", "cpu"))).toBe("load");
    expect(keyOwner(JSON.stringify({ mark: 0, series: "a" }))).toBe(0);
    expect(keyOwner(JSON.stringify({ mark: "map" }))).toBe("map");
  });

  it("names none for other strings", () => {
    for (const key of ["", "cpu", "[", "null", "{}", "[[0]]", '{"mark":null}'])
      expect(keyOwner(key)).toBeUndefined();
  });
});
