// The script HTML output and notebook frames run (browser.ts): a spec the
// engine refuses, or whose first frame fails, says so where the chart goes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "../browser.ts";

let element: HTMLDivElement;

beforeEach(() => {
  element = document.createElement("div");
  element.style.cssText = "width:500px;height:240px";
  document.body.append(element);
});

afterEach(() => element.remove());

const alert = () => element.querySelector<HTMLElement>('[role="alert"]');

describe("charts of Python's HTML", () => {
  it("show a spec the engine refuses in the chart's place, at its size", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const chart = render(element, { marks: [{ type: "line", x: "t", y: "v" }] }, []);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    expect(chart).toBeUndefined();
    expect(alert()!.textContent).toMatch(/^Chart could not be rendered\n.*no tables/);
    expect(alert()!.getBoundingClientRect()).toMatchObject({ width: 500, height: 240 });
  });

  it("show a first frame that fails as the chart does", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const chart = render(
      element,
      {
        data: { d: { columns: { t: [0, 1], v: [1, 2], kind: ["a", "b"], g: ["p", "p"] } } },
        marks: [{ type: "line", x: "t", y: "v", series: "g", color: "kind" }],
      },
      [],
    );
    // Lines colored by a field other than the series': the compiler loads, then refuses.
    await expect(chart!.ready).rejects.toThrow(/changes within series/);
    error.mockRestore();
    expect(alert()!.textContent).toMatch(
      /^Chart could not be rendered\n.*field "kind" changes within series "p"/,
    );
    chart!.destroy();
  });
});
