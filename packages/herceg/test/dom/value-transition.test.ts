// Changes of values moving: bars and pie slices matched between two scenes
// and interpolated, evaluated at explicit times.
import { afterEach, describe, expect, it, vi } from "vitest";
import { category, encodedCategory } from "../../src/data/column.ts";
import { type TableChange, table } from "../../src/data/table.ts";
import {
  frameAt,
  MOVING_ITEMS,
  plan,
  type Shown,
  snapshot,
  type Tween,
  ValueAnimation,
} from "../../src/dom/value-transition.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { pie } from "../../src/marks/pie.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderSvg } from "../../src/render/svg.ts";
import type {
  ArcGeometry,
  RectGeometry,
  Scene,
  SegmentGeometry,
  TextGeometry,
} from "../../src/scene/scene.ts";

const clock = vi.hoisted(() => ({ frame: 0 }));
vi.mock("../../src/dom/scheduler.ts", () => ({ lastFrameTime: () => clock.frame }));

afterEach(() => {
  clock.frame = 0;
});

const VALUES = { duration: 200, values: true } as const;

/** A chart model drawn at 600 x 300 that animates values. */
function chart(config: Partial<ChartConfig> & Pick<ChartConfig, "marks">) {
  const model = new ChartModel({ locale: "en-US", animation: VALUES, ...config });
  model.setSize(600, 300, 1);
  return model;
}

/** What `model` showed, and how it moves to its next scene after `change`. */
function change(model: ChartModel, edit: () => void): { shown: Shown; tween: Tween | undefined } {
  const shown = snapshot(model.scene(estimateText), model.panels()[0], 0);
  expect(shown).toBeDefined();
  edit();
  const scene = model.scene(estimateText);
  return { shown: shown!, tween: plan(shown!, scene, model.panels()[0], 200) };
}

const bars = (scene: Scene) =>
  scene.panels[0]!.marks.filter((mark): mark is RectGeometry => mark.kind === "rect");
const rects = (mark: RectGeometry) =>
  Array.from({ length: mark.count }, (_, i) => Array.from(mark.rects.subarray(i * 4, i * 4 + 4)));
/** Rectangles alike to a thousandth of a pixel: frames compute them from rounded ends. */
function expectRects(actual: number[][], expected: number[][]) {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((rect, i) => {
    rect.forEach((value, k) => {
      expect(value).toBeCloseTo(expected[i]![k]!, 3);
    });
  });
}
const sectors = (scene: Scene) =>
  scene.panels[0]!.marks.find((m) => m.kind === "arc") as ArcGeometry;
const turns = (mark: ArcGeometry) =>
  Array.from({ length: mark.count }, (_, i) => [mark.arcs[i * 6 + 4]!, mark.arcs[i * 6 + 5]!]);

function barChart(values: number[]) {
  const data = table({ region: ["N", "S", "E"], sales: values });
  return { data, model: chart({ marks: [bar(data, { x: "region", y: "sales" })] }) };
}

describe("bars changing values", () => {
  it("start where they were, move their tips, and end as the new scene draws them", () => {
    // A fixed domain keeps the axis still while the values change.
    const data = table({ region: ["N", "S", "E"], sales: [10, 20, 30] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      y: { domain: [0, 40] },
    });
    const before = rects(bars(model.scene(estimateText))[0]!);
    const { tween } = change(model, () => data.setColumn("sales", [30, 20, 10]));
    const after = rects(bars(tween!.scene)[0]!);
    const at = (elapsed: number) => rects(bars(frameAt(tween!, elapsed))[0]!);
    expectRects(at(0), before);
    expectRects(at(200), after);
    // Half way in time, eased: seven eighths of the way, with bases and widths kept.
    const [n] = at(100);
    const [x, , width, height] = before[0]!;
    expect(n![0]).toBe(x);
    expect(n![2]).toBe(width);
    const grown = height! + (after[0]![3]! - height!) * 0.875;
    expect(n![3]).toBeCloseTo(grown, 3);
    expect(n![1]! + n![3]!).toBeCloseTo(before[0]![1]! + height!, 3);
  });

  it("match bars by category, not by row", () => {
    const data = table({ region: ["N", "S", "E"], sales: [10, 20, 30] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      y: { domain: [0, 40] },
    });
    const before = rects(bars(model.scene(estimateText))[0]!);
    // The same categories in another row order (with the same dictionary,
    // as Arrow and pandas give them), with S's value changed.
    const { tween } = change(model, () =>
      data.reset({
        region: encodedCategory(Int32Array.from([2, 0, 1]), ["N", "S", "E"]),
        sales: [30, 10, 25],
      }),
    );
    // Bars are matched by category: each starts where its category's was.
    const byX = (list: number[][]) => [...list].sort((a, b) => a[0]! - b[0]!);
    expectRects(byX(rects(bars(frameAt(tween!, 0))[0]!)), byX(before));
    const s = byX(rects(bars(frameAt(tween!, 200))[0]!))[1]!;
    expect(s[3]).toBeCloseTo(model.panels()[0]!.y.map(0) - model.panels()[0]!.y.map(25), 3);
  });

  it("shrink to their root and grow on its other side as values change sign", () => {
    const data = table({ region: ["N", "S"], sales: [10, -10] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      y: { domain: [-20, 20] },
      theme: { barRadius: 4 },
    });
    const zero = model.scene(estimateText) && model.panels()[0]!.y.map(0);
    const { tween } = change(model, () => data.setColumn("sales", [-10, 10]));
    // The tip passes the root a little before half time (eased): t = 1 - 0.5^(1/3).
    const crossing = (1 - 0.5 ** (1 / 3)) * 200;
    const top = (elapsed: number) => {
      const mark = bars(frameAt(tween!, elapsed))[0]!;
      return { rect: rects(mark)[0]!, end: mark.rounded!.ends[0] };
    };
    const early = top(crossing - 10);
    const late = top(crossing + 10);
    // N stands on zero, above it, then below it, its rounded end at its tip.
    expect(early.rect[1]! + early.rect[3]!).toBeCloseTo(zero, 3);
    expect(late.rect[1]).toBeCloseTo(zero, 3);
    expect(early.end).not.toBe(late.end);
    expect(top(crossing).rect[3]).toBeCloseTo(0, 1);
  });

  it("grow new bars from their root and shrink bars that go to theirs", () => {
    const data = table({ region: ["N", "S", "E"], sales: [10, Number.NaN, 30] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      y: { domain: [0, 40] },
    });
    const { tween } = change(model, () => data.setColumn("sales", [Number.NaN, 20, 30]));
    const zero = model.panels()[0]!.y.map(0);
    // Both stay drawn while they move: S (coming) first in the new order, N (going) last.
    const start = bars(frameAt(tween!, 0))[0]!;
    expect(start.count).toBe(3);
    expect(rects(start)[0]![3]).toBe(0);
    expect(rects(start)[0]![1]).toBeCloseTo(zero, 3);
    const end = rects(bars(frameAt(tween!, 200))[0]!);
    expect(end[2]![3]).toBe(0);
    // The last frame is the new scene itself, without N.
    expect(bars(tween!.scene)[0]!.count).toBe(2);
  });

  it("move horizontal bars along x and grouped bars in their slots", () => {
    const data = table({ region: ["N", "S"], a: [10, 20], b: [5, 15] });
    const model = chart({
      marks: [bar(data, { x: ["a", "b"], y: "region" })],
      x: { domain: [0, 40] },
    });
    const before = bars(model.scene(estimateText)).map(rects);
    const { tween } = change(model, () => data.setColumn("b", [25, 15]));
    expect(tween!.bars).toHaveLength(2);
    const [, b] = bars(frameAt(tween!, 100)).map(rects);
    // Lengths along x grow from the left; positions along y stay.
    expect(b![0]![0]).toBe(Math.fround(before[1]![0]![0]!));
    expect(b![0]![1]).toBe(Math.fround(before[1]![0]![1]!));
    expect(b![0]![2]).toBeGreaterThan(before[1]![0]![2]!);
  });

  it("do not move when the axes, the categories, or the series change", () => {
    // An automatic y domain grows with the values.
    const grows = barChart([10, 20, 30]);
    expect(change(grows.model, () => grows.data.setColumn("sales", [10, 20, 90])).tween).toBe(
      undefined,
    );
    // A new category changes the bands.
    const data = table({ region: ["N", "S"], sales: [10, 20] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      y: { domain: [0, 40] },
    });
    expect(
      change(model, () => data.reset({ region: ["N", "S", "E"], sales: [10, 20, 30] })).tween,
    ).toBe(undefined);
    // A series coming changes the slots.
    const split = table({ region: ["N", "S"], kind: ["a", "a"], sales: [10, 20] });
    const grouped = chart({
      marks: [bar(split, { x: "region", y: "sales", series: "kind" })],
      y: { domain: [0, 40] },
    });
    expect(
      change(grouped, () => split.reset({ region: ["N", "S"], kind: ["a", "b"], sales: [10, 20] }))
        .tween,
    ).toBe(undefined);
    // Nothing changed: nothing moves.
    const same = barChart([10, 20, 30]);
    expect(change(same.model, () => same.data.setColumn("sales", [10, 20, 30])).tween).toBe(
      undefined,
    );
  });

  it("do not move bars of one facet value to another's", () => {
    const data = table({ region: ["N", "S"], sales: [10, 20], group: ["old", "old"] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      facet: facet("group"),
      y: { domain: [0, 40] },
    });
    const { tween } = change(model, () =>
      data.reset({ region: ["N", "S"], sales: [30, 10], group: ["new", "new"] }),
    );
    expect(tween).toBeUndefined();
  });

  it("leave out stacks, labeled bars, log axes, and bars sharing a position", () => {
    const data = table({ region: ["N", "S"], a: [10, 20], b: [5, 15] });
    for (const config of [
      { marks: [bar(data, { x: "region", y: ["a", "b"], stack: true })] },
      { marks: [bar(data, { x: "region", y: "a", labels: true })] },
      { marks: [bar(data, { x: "region", y: "a" })], y: { type: "log" as const } },
    ]) {
      const model = chart(config);
      expect(snapshot(model.scene(estimateText), model.panels()[0], 0)).toBeUndefined();
    }
    // Two bars at one position have no identity: their series shows its new values.
    const twice = table({ region: ["N", "N", "S"], a: [10, 12, 20] });
    const model = chart({ marks: [bar(twice, { x: "region", y: "a" })], y: { domain: [0, 40] } });
    expect(change(model, () => twice.setColumn("a", [11, 13, 25])).tween).toBe(undefined);
  });

  it("keep copies of what was shown, which later scenes cannot overwrite", () => {
    const data = table({ region: ["N", "S", "E"], sales: [10, 20, 30] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      y: { domain: [0, 40] },
    });
    const scene = model.scene(estimateText);
    const drawn = rects(bars(scene)[0]!);
    const shown = snapshot(scene, model.panels()[0], 0)!;
    // Scenes reuse their geometry buffers.
    data.setColumn("sales", [1, 2, 3]);
    model.scene(estimateText);
    data.setColumn("sales", [30, 20, 10]);
    const tween = plan(shown, model.scene(estimateText), model.panels()[0], 200)!;
    expectRects(rects(bars(frameAt(tween, 0))[0]!), drawn);
  });

  it("draw exactly what a chart without animation draws once done", () => {
    const data = table({ region: ["N", "S", "E"], sales: [10, 20, 30] });
    const still = new ChartModel({
      locale: "en-US",
      marks: [bar(data, { x: "region", y: "sales" })],
    });
    still.setSize(600, 300, 1);
    const moving = chart({ marks: [bar(data, { x: "region", y: "sales" })] });
    const svg = (model: ChartModel) => renderSvg(model.scene(estimateText), { idPrefix: "c" });
    expect(svg(moving)).toBe(svg(still));
  });
});

describe("pies changing values", () => {
  function pieChart(
    rows: { region: string[]; sales: number[] },
    sort: "value" | "input" = "input",
  ) {
    const data = table(rows);
    return {
      data,
      model: chart({ marks: [pie(data, { category: "region", value: "sales", sort })] }),
    };
  }

  it("move shared boundaries, so slices never overlap and always make a turn", () => {
    const { data, model } = pieChart({ region: ["N", "S", "E"], sales: [10, 20, 30] });
    const before = turns(sectors(model.scene(estimateText)));
    const { tween } = change(model, () => data.setColumn("sales", [30, 20, 10]));
    expect(turns(sectors(frameAt(tween!, 0)))).toEqual(before);
    for (const elapsed of [20, 100, 180]) {
      const at = turns(sectors(frameAt(tween!, elapsed)));
      expect(at[0]![0]).toBeCloseTo(-Math.PI / 2, 5);
      for (let i = 1; i < at.length; i++) expect(at[i]![0]).toBe(at[i - 1]![1]);
      expect(at.at(-1)![1]).toBeCloseTo(1.5 * Math.PI, 5);
    }
    expect(turns(sectors(frameAt(tween!, 200)))).toEqual(turns(sectors(tween!.scene)));
  });

  it("open new slices from nothing and close slices that go, with their labels", () => {
    const { data, model } = pieChart({ region: ["N", "S"], sales: [10, 20] });
    const labels = (scene: Scene) =>
      scene.panels[0]!.marks.filter((m): m is TextGeometry => m.kind === "text")
        .flatMap((m) => m.labels)
        .sort();
    const { tween } = change(model, () => data.reset({ region: ["N", "E"], sales: [10, 20] }));
    // S goes and E comes in its place: at first only N and S show.
    expect(sectors(frameAt(tween!, 0)).count).toBe(2);
    expect(labels(frameAt(tween!, 0))).toEqual(["N", "S"]);
    const middle = frameAt(tween!, 50);
    expect(sectors(middle).count).toBe(3);
    expect(labels(middle)).toEqual(["E", "N", "S"]);
    const leaders = middle.panels[0]!.marks.find((m) => m.kind === "segments") as SegmentGeometry;
    expect(leaders.count).toBe(12);
    // S keeps its label while it shows, however thin.
    expect(labels(frameAt(tween!, 199))).toEqual(["E", "N", "S"]);
    expect(labels(tween!.scene)).toEqual(["E", "N"]);
  });

  it("sweep from the top when a pie fills, and do not move when kept slices change order", () => {
    // Without a legend, which would take room once there are slices to list.
    const data = table({ region: category([]), sales: [] });
    const model = chart({
      marks: [pie(data, { category: "region", value: "sales", sort: "input" })],
      legend: false,
    });
    const { tween } = change(model, () => data.reset({ region: ["N", "S"], sales: [10, 30] }));
    const half = turns(sectors(frameAt(tween!, 100)));
    // Seven eighths of the turn after half the time.
    expect(half.at(-1)![1]! - half[0]![0]!).toBeCloseTo(0.875 * 2 * Math.PI, 5);
    // Sorted by value, N and S swap places: they would cross.
    const sorted = pieChart({ region: ["N", "S"], sales: [10, 30] }, "value");
    expect(
      change(sorted.model, () => sorted.data.setColumn("sales", [30, 10])).tween,
    ).toBeUndefined();
  });
});

describe("value animation", () => {
  const scene = (model: ChartModel) => model.scene(estimateText);
  const VALUES_CHANGED = { dropped: 0, appended: 0, updated: null, fields: [], reset: true };
  const APPENDED = { ...VALUES_CHANGED, appended: 1, reset: false };

  function animated() {
    const data = table({ region: ["N", "S", "E"], sales: [10, 20, 30] });
    const model = chart({
      marks: [bar(data, { x: "region", y: "sales" })],
      y: { domain: [0, 40] },
    });
    const animation = new ValueAnimation(model, null, true);
    animation.start(scene(model), 0);
    return { data, model, animation };
  }

  it("play a change from when it was made, and end it when asked", () => {
    vi.spyOn(performance, "now").mockReturnValue(1000);
    const { data, model, animation } = animated();
    const shown = scene(model);
    animation.changed(shown, VALUES_CHANGED, 0);
    data.setColumn("sales", [30, 20, 10]);
    const destination = scene(model);
    vi.spyOn(performance, "now").mockReturnValue(1100);
    const first = animation.start(destination, 0);
    expect(animation.playing).toBe(true);
    expect(first).not.toBe(destination);
    // Ended early (by a pointer, say), nothing more plays.
    expect(animation.settle()).toBe(true);
    expect(animation.step(0)).toBeUndefined();
    vi.restoreAllMocks();
  });

  it("show appends, changes while moving, and changes soon after at once", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const { data, model, animation } = animated();
    let shown = scene(model);
    animation.start(shown, 0);
    /** Whether a change to `values` moves. */
    const go = (values: number[], change: TableChange = VALUES_CHANGED) => {
      animation.changed(shown, change, 0);
      data.setColumn("sales", values);
      shown = animation.start(scene(model), 0);
      return animation.playing;
    };
    expect(go([10, 20, 35], APPENDED)).toBe(false);
    // Rows streamed in until a moment ago: still too soon.
    now.mockReturnValue(100);
    expect(go([10, 25, 35])).toBe(false);
    now.mockReturnValue(400);
    expect(go([15, 25, 35])).toBe(true);
    // A change while it moves ends it, and the next one soon after shows at once.
    now.mockReturnValue(450);
    animation.changed(undefined, VALUES_CHANGED, 0);
    expect(animation.playing).toBe(false);
    now.mockReturnValue(600);
    expect(go([5, 25, 35])).toBe(false);
    now.mockReturnValue(900);
    expect(go([5, 30, 35])).toBe(true);
    // Its last frame is the new scene.
    now.mockReturnValue(1200);
    expect(animation.step(0)).toBeDefined();
    expect(animation.playing).toBe(false);
    vi.restoreAllMocks();
  });

  it("show changes at once in slow charts, under other options, and with series hidden", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const { data, model, animation } = animated();
    animation.changed(scene(model), VALUES_CHANGED, 12);
    data.setColumn("sales", [30, 20, 10]);
    animation.start(scene(model), 0);
    expect(animation.playing).toBe(false);
    clock.frame = 15;
    animation.changed(scene(model), VALUES_CHANGED, 0);
    data.setColumn("sales", [10, 20, 30]);
    animation.start(scene(model), 0);
    expect(animation.playing).toBe(false);
    clock.frame = 0;
    // Options changed since the scene on screen was built.
    const shown = animation.start(scene(model), 0);
    model.update({ ...model.config, title: "Sales" });
    animation.changed(shown, VALUES_CHANGED, 0);
    data.setColumn("sales", [30, 20, 10]);
    animation.start(scene(model), 0);
    expect(animation.playing).toBe(false);
    // So does a series hidden since: it would move away rather than go at once.
    const drawn = animation.start(scene(model), 0);
    model.hidden.add(model.series()[0]!.key);
    animation.changed(drawn, VALUES_CHANGED, 0);
    data.setColumn("sales", [10, 20, 30]);
    animation.start(scene(model), 0);
    expect(animation.playing).toBe(false);
    vi.restoreAllMocks();
  });

  it("leave out more bars than it can move every frame, before copying them", () => {
    const n = MOVING_ITEMS + 1;
    const data = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, () => 1),
    });
    const model = chart({ marks: [bar(data, { x: "x", y: "y" })] });
    const shown = model.scene(estimateText);
    const copies = vi.spyOn(bars(shown)[0]!.bars!.at, "slice");
    expect(snapshot(shown, model.panels()[0], 0)).toBeUndefined();
    expect(copies).not.toHaveBeenCalled();
  });
});
