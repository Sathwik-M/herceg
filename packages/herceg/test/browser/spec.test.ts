import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chartFromSpec } from "../../src/from-spec.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => host.remove());

describe("chartFromSpec", () => {
  it("renders a spec whose columns arrive as binary buffers", () => {
    const x = new Float64Array([0, 1, 2]);
    const y = new Float32Array([3, 1, 2]);
    const codes = new Int32Array([0, 0, 0]);
    const chart = chartFromSpec(
      host,
      {
        title: "From a spec",
        data: {
          t: {
            columns: {
              x: { type: "number", dtype: "float64", buffer: 0 },
              y: { type: "number", dtype: "float32", buffer: 1 },
              host: { type: "category", codes: 2, dictionary: ["web"] },
            },
          },
        },
        marks: [{ type: "line", x: "x", y: "y", series: "host" }],
      },
      // As delivered by a notebook comm: views over larger buffers.
      [new DataView(x.buffer), new Uint8Array(y.buffer), codes.buffer],
    );
    expect(chart.root.getAttribute("aria-label")).toBe("From a spec");
    expect(
      modelOf(chart)
        .series()
        .map((s) => s.label),
    ).toEqual(["web"]);
    expect(chart.root.querySelectorAll("svg g[clip-path] path")).toHaveLength(1);
    chart.destroy();
  });
});
