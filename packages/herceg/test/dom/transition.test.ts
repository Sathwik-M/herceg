import { describe, expect, it, vi } from "vitest";
import { domainsAt, durationOf, type Transition, ViewAnimation } from "../../src/dom/transition.ts";
import type { ChartModel, PanelInfo } from "../../src/model/model.ts";

// Frames are counted by the scheduler, which runs none in Node.
const clock = vi.hoisted(() => ({ frames: 0 }));
vi.mock("../../src/dom/scheduler.ts", () => ({
  frameCount: () => clock.frames,
  lastFrameTime: () => 0,
}));

const transition = (domains: Transition["domains"], log = false): Transition => ({
  batch: { frame: 0, costs: new Map() },
  domains,
  to: undefined,
  log: { x: false, y: log, yRight: false },
  start: 0,
  duration: 200,
});

describe("view transitions", () => {
  it("take 250 ms when on, a given duration, or none", () => {
    expect(durationOf(undefined)).toBe(0);
    expect(durationOf(false)).toBe(0);
    expect(durationOf(true)).toBe(250);
    expect(durationOf({})).toBe(250);
    expect(durationOf({ duration: 0 })).toBe(0);
    expect(durationOf({ duration: 400 })).toBe(400);
  });

  it("ease out from the start to the end without overshooting", () => {
    const moving = transition({ x: [0, 100], y: [0, 10], yRight: null });
    const to = { x: [50, 60], y: [0, 20], yRight: null } as const;
    expect(domainsAt(moving, to, 0)).toEqual({ x: [0, 100], y: [0, 10], yRight: null });
    // Cubic ease-out: seven eighths of the way at half time.
    const half = domainsAt(moving, to, 100);
    expect(half.x![0]).toBeCloseTo(43.75);
    expect(half.x![1]).toBeCloseTo(65);
    let previous = 0;
    for (let elapsed = 0; elapsed <= 300; elapsed += 10) {
      const [lo] = domainsAt(moving, to, elapsed).x!;
      expect(lo).toBeGreaterThanOrEqual(previous);
      expect(lo).toBeLessThanOrEqual(50);
      previous = lo;
    }
    expect(domainsAt(moving, to, 500).x).toEqual([50, 60]);
  });

  it("move log axes evenly in log space, and snap axes they cannot move", () => {
    const moving = transition({ x: [0, 1], y: [1, 10], yRight: null }, true);
    const at = domainsAt(moving, { x: [0, 1], y: [1, 1000], yRight: [5, 6] }, 100);
    expect(at.y![1]).toBeCloseTo(10 ** 2.75);
    // A right axis appearing has nothing to move from.
    expect(at.yRight).toEqual([5, 6]);
    const unusable = transition({ x: [0, 1], y: [0, 10], yRight: null }, true);
    expect(domainsAt(unusable, { x: [0, 1], y: [1, 100], yRight: null }, 100).y).toEqual([1, 100]);
  });

  it("count each chart once toward the first frame of the charts moving together", () => {
    const model = { setTransitionDomains() {} } as unknown as ChartModel;
    const scale = (domain: number[]) => ({ type: "linear", domain }) as unknown as PanelInfo["x"];
    const panel = { x: scale([0, 100]), y: scale([0, 10]) } as PanelInfo;
    const plan = () => ({ x: scale([20, 40]), y: scale([0, 5]) }) as PanelInfo;
    const animation = new ViewAnimation(model, null);
    // Asked for twice before a frame, a 3 ms chart still plans one view and draws one frame.
    expect(animation.start(panel, true, 3)).toBe(true);
    expect(animation.start(panel, true, 3)).toBe(true);
    expect(animation.step(plan, 3)).toBe(true);
    // Three such charts moving together would take 18 ms: all jump, whichever
    // draws first.
    animation.settle();
    clock.frames++;
    const together = [animation, new ViewAnimation(model, null), new ViewAnimation(model, null)];
    for (const each of together) each.start(panel, true, 3);
    expect(together.map((each) => each.step(plan, 3))).toEqual([false, false, false]);
    expect(durationOf({ duration: Number.POSITIVE_INFINITY })).toBe(0);
  });
});
