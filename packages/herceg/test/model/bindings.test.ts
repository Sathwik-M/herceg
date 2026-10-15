import { describe, expect, it } from "vitest";
import { Bindings } from "../../src/model/bindings.ts";
import type { InteractionSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";

const keys = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
const wheel = (deltaX: number, deltaY: number, held: Partial<typeof keys> = {}) => ({
  ...keys,
  ...held,
  deltaX,
  deltaY,
});
const drag = (held: Partial<typeof keys> = {}, button = 0, pointerType = "mouse") => ({
  ...keys,
  ...held,
  button,
  pointerType,
});
const key = (name: string, held: Partial<typeof keys> = {}) => ({ ...keys, ...held, key: name });

/** The action an input takes in a chart of `interaction`, by type. */
function action(
  interaction: InteractionSpec,
  type: Parameters<Bindings["match"]>[0],
  event: Parameters<Bindings["match"]>[1],
  focused = false,
) {
  return new Bindings(interaction).match(type, event, undefined, focused)?.action;
}

describe("presets", () => {
  it("leave the vertical wheel to the page and zoom with Ctrl or Meta held", () => {
    const zoom = { zoom: "x" } as const;
    expect(action(zoom, "wheel", wheel(0, 100))).toBeUndefined();
    expect(action(zoom, "wheel", wheel(0, 100, { ctrlKey: true }))).toEqual({
      type: "zoom",
      axes: "x",
    });
    expect(action(zoom, "wheel", wheel(0, 100, { metaKey: true }))?.type).toBe("zoom");
    // Exactly the keys listed: Ctrl with Alt is not Ctrl.
    expect(action(zoom, "wheel", wheel(0, 100, { ctrlKey: true, altKey: true }))).toBeUndefined();
  });

  it("pan with drags and the wheel sideways, Shift with the wheel included", () => {
    const pan = { pan: "x" } as const;
    expect(action(pan, "drag", drag())).toEqual({ type: "pan", axes: "x" });
    expect(action(pan, "wheel", wheel(100, 10))).toEqual({ type: "pan", axes: "x" });
    expect(action(pan, "wheel", wheel(0, 100, { shiftKey: true }))?.type).toBe("pan");
    expect(action(pan, "wheel", wheel(0, 100))).toBeUndefined();
    // Panning alone does not zoom.
    expect(action(pan, "wheel", wheel(0, 100, { ctrlKey: true }))).toBeUndefined();
    expect(action(pan, "doubleClick", keys)).toEqual({ type: "reset" });
  });

  it("let zoom pan, unless pan is false", () => {
    expect(action({ zoom: true }, "drag", drag())).toEqual({ type: "pan" });
    expect(action({ zoom: true, pan: false }, "drag", drag())?.type).toBe("orbit");
    expect(action({ zoom: true, pan: "y" }, "drag", drag())).toEqual({ type: "pan", axes: "y" });
    // Only x pans with the wheel.
    expect(action({ zoom: true, pan: "y" }, "wheel", wheel(100, 0))).toBeUndefined();
  });

  it("brush with drags, Shift panning, and zoom to brushes their axes zoom", () => {
    expect(action({ brush: "x", zoom: "x" }, "drag", drag())).toEqual({
      type: "brush",
      shape: "x",
      zoom: true,
    });
    expect(action({ brush: "xy", zoom: "x" }, "drag", drag())).toMatchObject({ zoom: false });
    expect(action({ brush: "lasso", zoom: "xy" }, "drag", drag())).toMatchObject({ zoom: false });
    expect(action({ brush: "x", zoom: "x" }, "drag", drag({ shiftKey: true }))?.type).toBe("pan");
    expect(action({ brush: "x" }, "drag", drag({ shiftKey: true }))?.type).toBe("brush");
  });

  it("zoom with plus and minus, Shift not counted for symbols, and reset with 0", () => {
    const zoom = { zoom: "x" } as const;
    expect(action(zoom, "key", key("+"))).toMatchObject({ type: "zoom", factor: 1.25 });
    expect(action(zoom, "key", key("+", { shiftKey: true }))).toMatchObject({ factor: 1.25 });
    expect(action(zoom, "key", key("-"))).toMatchObject({ factor: 0.8 });
    expect(action(zoom, "key", key("0"))).toEqual({ type: "reset" });
    expect(action(zoom, "key", key("+", { ctrlKey: true }))).toBeUndefined();
    expect(action({ zoom: "x" }, "pinch", keys)?.type).toBe("zoom");
  });

  it("turn 3D charts and move networks' nodes with drags", () => {
    expect(action({}, "drag", drag())).toEqual({ type: "orbit" });
    expect(action({ rotate: false }, "drag", drag())).toBeUndefined();
    expect(action({ drag: true }, "drag", drag())).toEqual({ type: "moveItem" });
  });
});

describe("bindings", () => {
  it("come before the presets, and the first that applies takes the input", () => {
    const interaction: InteractionSpec = {
      zoom: "x",
      bindings: [
        { gesture: { type: "wheel", axis: "y" }, action: { type: "zoom", axes: "x" } },
        { gesture: { type: "drag", button: 1 }, action: { type: "pan" } },
      ],
    };
    expect(action(interaction, "wheel", wheel(0, 100))?.type).toBe("zoom");
    expect(action(interaction, "drag", drag({}, 1))?.type).toBe("pan");
    const bound = new Bindings(interaction);
    // An action that does not apply where the input happened leaves it to the next.
    expect(bound.match("drag", drag(), ({ type }) => type !== "pan")?.action.type).toBe("orbit");
  });

  it("leave a gesture to the page with pageScroll", () => {
    const interaction: InteractionSpec = {
      pan: "x",
      bindings: [{ gesture: { type: "wheel", axis: "x" }, action: { type: "pageScroll" } }],
    };
    expect(action(interaction, "wheel", wheel(100, 0))?.type).toBe("pageScroll");
  });

  it("match wheels while focused, by button, and by kind of pointer", () => {
    const interaction: InteractionSpec = {
      bindings: [
        { gesture: { type: "wheel", focused: true }, action: { type: "zoom" } },
        { gesture: { type: "drag", pointer: "touch" }, action: { type: "cursor" } },
      ],
    };
    expect(action(interaction, "wheel", wheel(0, 100))).toBeUndefined();
    expect(action(interaction, "wheel", wheel(0, 100), true)?.type).toBe("zoom");
    expect(action(interaction, "drag", drag({}, 0, "touch"))?.type).toBe("cursor");
    expect(action(interaction, "drag", drag())?.type).toBe("orbit");
  });

  it("refuse a gesture bound twice, whatever the order of its modifiers", () => {
    expect(
      () =>
        new Bindings({
          bindings: [
            { gesture: { type: "wheel", modifiers: ["ctrl", "alt"] }, action: { type: "zoom" } },
            { gesture: { type: "wheel", modifiers: ["alt", "ctrl"] }, action: { type: "pan" } },
          ],
        }),
    ).toThrow("interaction.bindings[1]: duplicates binding 0; remove one or change its gesture");
  });

  it("refuse keys the keyboard cursor takes, and brushes that zoom while selecting rows", () => {
    expect(
      () =>
        new Bindings({
          bindings: [{ gesture: { type: "key", key: "ArrowLeft" }, action: { type: "reset" } }],
        }),
    ).toThrow('interaction.bindings[0].gesture.key: "ArrowLeft" moves the keyboard cursor');
    expect(
      () =>
        new Bindings({
          bindings: [
            {
              gesture: { type: "key", key: "ArrowLeft", modifiers: ["alt"] },
              action: { type: "pan", step: [-0.1, 0] },
            },
          ],
        }),
    ).not.toThrow();
    expect(
      () =>
        new Bindings(
          {
            bindings: [
              { gesture: { type: "drag" }, action: { type: "brush", shape: "x", zoom: true } },
            ],
          },
          true,
        ),
    ).toThrow("interaction.bindings[0].action.zoom: brushes select rows for rowSelection");
  });
});

describe("limits and sync in specs", () => {
  it("refuse limits that run backwards, in code as in specs", () => {
    expect(() => new Bindings({ limits: { x: { extent: [100, 0] } } })).toThrow(
      "interaction.limits.x.extent: expected two finite numbers, ascending",
    );
    expect(() => new Bindings({ limits: { y: { edge: { threshold: -1 } } } })).toThrow(
      "interaction.limits.y.edge.threshold: expected a fraction of the view, at least 0",
    );
  });

  it("take how cursors snap and show on the cursor's channel and across panels, and nowhere else", () => {
    const spec = (sync: unknown) =>
      ({
        version: 1,
        data: { t: { columns: { x: [0, 1], y: [1, 2] } } },
        marks: [{ type: "line", data: "t", x: "x", y: "y" }],
        interaction: { sync },
      }) as never;
    expect(() =>
      validateSpec(
        spec({ cursor: { group: "a", snap: "previous", tooltip: true }, panels: { snap: "next" } }),
      ),
    ).not.toThrow();
    expect(() => validateSpec(spec({ panels: false }))).not.toThrow();
    expect(() => validateSpec(spec({ cursor: { group: "a", snap: "later" } }))).toThrow(
      'interaction.sync.cursor.snap: expected "nearest", "previous", or "next"',
    );
    expect(() => validateSpec(spec({ viewport: { group: "a", snap: "previous" } }))).toThrow(
      "interaction.sync.viewport",
    );
    expect(() => validateSpec(spec({ panels: { group: "a" } }))).toThrow("interaction.sync.panels");
  });
});
