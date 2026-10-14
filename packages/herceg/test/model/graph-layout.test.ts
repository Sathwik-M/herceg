// Where networks' nodes go: positions kept by node as the data changes,
// nodes settling around a moved node, circular and layered layouts, and
// layouts spread over frames.

import { afterEach, describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { LINK_DISTANCE } from "../../src/layout/force.ts";
import { estimateText } from "../../src/layout/text.ts";
import { type GraphOptions, graph } from "../../src/marks/graph.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { checkSpec, validateSpec } from "../../src/spec/validate.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(600, 400, 1);
  model.scene(estimateText);
  return model;
}

/** A ring of `n` nodes named n0, n1, ... */
const ring = (n: number) =>
  table({
    from: Array.from({ length: n }, (_, i) => `n${i}`),
    to: Array.from({ length: n }, (_, i) => `n${(i + 1) % n}`),
  });

const network = (links: ReturnType<typeof ring>, options: Partial<GraphOptions<never>> = {}) =>
  build({ marks: [graph(links, { source: "from", target: "to", ...options } as never)] });

const key = (name: string) => JSON.stringify([0, name]);
/** Where node `name` is drawn, in layout units. */
const placeOf = (model: ChartModel, name: string): [number, number] => {
  const { px, py } = model.inspectItem(key(name))!.points[0]!;
  return model.items!.result()!.moves!.toLayout(key(name), px, py);
};
const places = (model: ChartModel, n: number) =>
  Array.from({ length: n }, (_, i) => placeOf(model, `n${i}`));
const distance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!);

/** A network of communities that takes many frames' time to lay out. */
const communities = () => {
  const from: string[] = [];
  const to: string[] = [];
  for (let i = 1; i < 1500; i++) {
    from.push(`n${i}`);
    to.push(`n${Math.floor(i / 20) * 20 + ((i * 7) % 20)}`);
    if (i % 20 === 0) {
      from.push(`n${i}`);
      to.push(`n${i - 20}`);
    }
  }
  return table({ from, to });
};

/** A network of 12,000 nodes and 24,000 links, which takes more than a frame to start. */
const large = () => {
  const from: string[] = [];
  const to: string[] = [];
  for (let i = 1; i < 12_000; i++) {
    from.push(`n${i}`, `n${i}`);
    to.push(`n${i - 1}`, `n${Math.floor(i / 3)}`);
  }
  return table({ from, to });
};

/** Mounts a model's items as a browser chart does, so scenes take a frame's time for layouts. */
function mount(model: ChartModel) {
  const controls = { busy: false, update() {}, draw() {}, dispose() {} };
  model.items!.updateControls(() => Promise.resolve(controls));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("force layouts as the data changes", () => {
  it("keep nodes that remain where they were, and put new ones beside their neighbors", () => {
    const links = ring(30);
    const model = network(links);
    const before = places(model, 30);
    links.append({ from: ["n0"], to: ["new"] });
    model.scene(estimateText);
    const after = places(model, 30);
    // Nodes far from the change do not move at all; near ones a little.
    expect(after[15]).toEqual(before[15]);
    for (let i = 0; i < 30; i++)
      expect(distance(after[i]!, before[i]!)).toBeLessThan(LINK_DISTANCE);
    expect(distance(placeOf(model, "new"), placeOf(model, "n0"))).toBeLessThan(2 * LINK_DISTANCE);
    // A change of nothing the layout reads moves nothing.
    links.append({ from: ["n1"], to: ["n2"] });
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(after);
  });

  it("put a new component beside the rest, and keep moved nodes where they were put", () => {
    const links = ring(12);
    const model = network(links);
    model.items!.setItemPosition(key("n3"), { x: 400, y: -300 });
    model.scene(estimateText);
    const right = Math.max(...places(model, 12).map(([x], i) => (i === 3 ? -Infinity : x)));
    links.append({ from: ["a", "b"], to: ["b", "c"] });
    model.scene(estimateText);
    expect(model.items!.positions()).toEqual({ [key("n3")]: { x: 400, y: -300 } });
    const { plane } = model.items!.result()!;
    const { px, py } = model.inspectItem(key("n3"))!.points[0]!;
    expect([px, py]).toEqual([plane!.x.map(400), plane!.y.map(-300)]);
    for (const name of ["a", "b", "c"]) expect(placeOf(model, name)[0]).toBeGreaterThan(right);
  });

  it("keep their places when the mark is made again over new tables of the same nodes", () => {
    const model = network(ring(30));
    const before = places(model, 30);
    // As an adapter renders again: a new mark, over a new table.
    model.update({ marks: [graph(ring(30), { source: "from", target: "to", labels: false })] });
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(before);
  });

  it("are the same for the same data and changes", () => {
    const run = () => {
      const links = ring(40);
      const model = network(links);
      links.append({ from: ["n5", "x"], to: ["x", "y"] });
      model.scene(estimateText);
      return places(model, 40);
    };
    expect(run()).toEqual(run());
  });
});

describe("settling around moved nodes", () => {
  it("moves the nodes near a moved node and no others, and not the moved node", () => {
    const model = network(ring(30));
    const before = places(model, 30);
    const [x, y] = before[0]!;
    model.items!.setItemPosition(key("n0"), { x: x + 60, y: y + 60 });
    model.scene(estimateText);
    const after = places(model, 30);
    expect(after[0]![0]).toBeCloseTo(x + 60, 6);
    expect(after[0]![1]).toBeCloseTo(y + 60, 6);
    // Its neighbors follow it; nodes three links away and more stay.
    expect(distance(after[1]!, before[1]!)).toBeGreaterThan(5);
    expect(distance(after[29]!, before[29]!)).toBeGreaterThan(5);
    for (let i = 3; i <= 27; i++) expect(after[i]).toEqual(before[i]);
    // Settled nodes are no moves.
    expect(Object.keys(model.items!.positions())).toEqual([key("n0")]);
  });

  it("put a node let go back where the layout puts it, and settle the same whatever the order", () => {
    const model = network(ring(30));
    const first = places(model, 30);
    const [x, y] = first[0]!;
    model.items!.setItemPosition(key("n0"), { x: x + 60, y: y + 60 });
    model.scene(estimateText);
    model.items!.setItemPosition(key("n0"), null);
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(first);
    // Two moves settle the network alike in either order, at once or one by one.
    const moves = [
      [key("n0"), { x: x + 60, y }],
      [key("n10"), { x: 0, y: 0 }],
    ] as const;
    for (const [k, at] of moves) {
      model.items!.setItemPosition(k, at);
      model.scene(estimateText);
    }
    const settled = places(model, 30);
    const other = network(ring(30));
    for (const [k, at] of [...moves].reverse()) other.items!.setItemPosition(k, at);
    other.scene(estimateText);
    expect(places(other, 30)).toEqual(settled);
    model.items!.resetItemPositions();
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(first);
    expect(model.items!.movedItems().size).toBe(0);
  });

  it("settles nothing with settle off: a node put back goes where it was", () => {
    const model = network(ring(30), { layout: { type: "force", settle: false } });
    const first = places(model, 30);
    model.items!.setItemPosition(key("n0"), { x: 100, y: 100 });
    model.scene(estimateText);
    expect(places(model, 30).slice(1)).toEqual(first.slice(1));
    model.items!.setItemPosition(key("n0"), null);
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(first);
  });

  it("settles nothing while a node is dragged, only once it is dropped", () => {
    const model = network(ring(30));
    const before = places(model, 30);
    model.items!.drag(key("n0"), [before[0]![0] + 60, before[0]![1]]);
    model.scene(estimateText);
    expect(places(model, 30).slice(1)).toEqual(before.slice(1));
    // A drag let go of (Escape) leaves everything as it was.
    model.items!.drag(null);
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(before);
  });

  it("settles held nodes once a first layout ends, in the same scene", () => {
    const links = ring(30);
    const plain = network(links);
    const moved = { x: plain.items!.result()!.plane!.x.domain[0], y: 0 };
    plain.items!.setItemPosition(key("n0"), moved);
    plain.scene(estimateText);
    const settled = places(plain, 30);
    // A chart whose moves are restored before it is first drawn ends the same.
    const restored = new ChartModel({
      locale: "en-US",
      marks: [graph(links, { source: "from", target: "to" })],
    });
    restored.setSize(600, 400, 1);
    restored.scene(estimateText);
    restored.items!.setItemPosition(key("n0"), moved);
    restored.scene(estimateText);
    expect(places(restored, 30)).toEqual(settled);
  });
});

describe("settling and data changes, from review", () => {
  it("settle alike whatever order the moves come in, past the limits on how many nodes settle", () => {
    // Two stars of 600 leaves each: their hubs' neighborhoods together pass the limit.
    const from: string[] = [];
    const to: string[] = [];
    for (const hub of ["a", "b"])
      for (let i = 0; i < 600; i++) {
        from.push(hub);
        to.push(`${hub}${i}`);
      }
    const links = table({ from, to });
    const moved = (order: readonly string[]) => {
      const model = build({ marks: [graph(links, { source: "from", target: "to" })] });
      for (const hub of order)
        model.items!.setItemPosition(key(hub), { x: 0, y: hub === "a" ? 0 : 50 });
      model.scene(estimateText);
      return ["a3", "a300", "b3", "b300"].map((name) => placeOf(model, name));
    };
    expect(moved(["a", "b"])).toEqual(moved(["b", "a"]));
  });

  it("show a first layout of data that changes every frame", () => {
    const links = large();
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(links, { source: "from", target: "to" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    let frame = 0;
    for (; frame < 2000 && !model.items!.result()?.plane; frame++) {
      links.append({ from: [`x${frame}`], to: ["n1"] });
      model.scene(estimateText);
    }
    expect(model.items!.result()!.plane).toBeDefined();
    for (const name of ["n1", "x0", `x${frame - 1}`])
      for (const v of placeOf(model, name)) expect(Number.isFinite(v)).toBe(true);
  });

  it("lay a large new component out over frames, ending as a whole layout does", () => {
    const run = (clock: boolean) => {
      const links = table({ from: ["a"], to: ["b"] });
      const model = new ChartModel({
        locale: "en-US",
        marks: [graph(links, { source: "from", target: "to" })],
      });
      model.setSize(600, 400, 1);
      if (clock) mount(model);
      model.scene(estimateText);
      // A new component of 6,000 nodes, reaching neither a nor b.
      const from = Array.from({ length: 6000 }, (_, i) => `c${i + 1}`);
      links.append({ from, to: from.map((_, i) => `c${Math.floor(i / 2)}`) });
      model.scene(estimateText);
      const pending = model.items!.pending;
      // New nodes have places at once, on their way to where they go.
      for (const v of placeOf(model, "c3000")) expect(Number.isFinite(v)).toBe(true);
      for (let frame = 0; frame < 100_000 && model.items!.pending; frame++)
        model.scene(estimateText);
      return { pending, places: ["a", "c1", "c3000"].map((name) => placeOf(model, name)) };
    };
    const sliced = run(true);
    expect(sliced.pending).toBe(true);
    expect(sliced.places).toEqual(run(false).places);
  });

  it("show every node of a layered network the data grew while its layout ran, with reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const links = table({ from: ["a"], to: ["b"] });
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(links, { source: "from", target: "to", layout: "layered" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    model.scene(estimateText);
    links.append({ from: ["b"], to: ["c"] });
    model.scene(estimateText);
    for (let frame = 0; frame < 1000 && model.items!.pending; frame++) {
      for (const name of "abc")
        for (const v of placeOf(model, name)) expect(Number.isFinite(v)).toBe(true);
      model.scene(estimateText);
    }
    expect(placeOf(model, "c")[1]).toBeGreaterThan(placeOf(model, "b")[1]);
  });

  it("find a node moved far out, and its links, once the view pans there", () => {
    const model = build({
      marks: [graph(ring(12), { source: "from", target: "to", layout: "circular" })],
      interaction: { zoom: true },
    });
    model.items!.setItemPosition(key("n0"), { x: 10_000, y: 0 });
    model.items!.setView({ x: [9_900, 10_100], y: [-100, 100] }, undefined);
    model.scene(estimateText);
    const { px, py } = model.inspectItem(key("n0"))!.points[0]!;
    const found = model.inspect(px, py);
    expect(found?.axis === "item" && found.key).toBe(key("n0"));
    // Along its link toward n1, a little way from n0.
    const { plane } = model.items!.result()!;
    const [x1, y1] = placeOf(model, "n1");
    const [lx, ly] = [10_000 + (x1 - 10_000) * 0.01, y1 * 0.01];
    const link = model.inspect(plane!.x.map(lx), plane!.y.map(ly));
    expect(link?.axis === "item" && link.key.startsWith('[0,"n0"')).toBe(true);
  });

  it("settle nothing while a moved node is dragged again, until it is dropped", () => {
    const model = network(ring(30));
    const [x, y] = placeOf(model, "n0");
    model.items!.setItemPosition(key("n0"), { x: x + 60, y });
    model.scene(estimateText);
    const settled = places(model, 30);
    model.items!.drag(key("n0"), [x - 60, y]);
    model.scene(estimateText);
    expect(places(model, 30).slice(1)).toEqual(settled.slice(1));
    // Escape: the drag ends, and nothing moved.
    model.items!.drag(null);
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(settled);
  });

  it("ease the nodes near a second move from where they are, not jump them", () => {
    // Two rings of 20, n and m.
    const from = ["n", "m"].flatMap((ring) => Array.from({ length: 20 }, (_, i) => `${ring}${i}`));
    const links = table({
      from,
      to: from.map((name) => `${name[0]}${(Number(name.slice(1)) + 1) % 20}`),
    });
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(links, { source: "from", target: "to" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    for (let frame = 0; frame < 10_000 && (frame === 0 || model.items!.pending); frame++)
      model.scene(estimateText);
    const [nx, ny] = placeOf(model, "n0");
    model.items!.setItemPosition(key("n0"), { x: nx + 80, y: ny });
    model.scene(estimateText);
    model.scene(estimateText);
    // A second move, in the other ring, while the first one's nodes ease.
    const before = placeOf(model, "m1");
    const [mx, my] = placeOf(model, "m0");
    model.items!.setItemPosition(key("m0"), { x: mx - 80, y: my });
    model.scene(estimateText);
    const next = placeOf(model, "m1");
    const end = performance.now() + 2000;
    while (model.items!.pending && performance.now() < end) model.scene(estimateText);
    const settled = placeOf(model, "m1");
    expect(distance(settled, before)).toBeGreaterThan(5);
    // Just after the move, m1 is still near where it was.
    expect(distance(next, before)).toBeLessThan(distance(settled, before) / 2);
  });
});

describe("data changes during work, from review", () => {
  it("finish a layout while rows that change nothing it reads stream in", () => {
    const links = communities();
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(links, { source: "from", target: "to" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    let frame = 0;
    for (; frame < 100_000 && (frame === 0 || model.items!.pending); frame++) {
      // A row of a link the network has: nothing to lay out again.
      links.append({ from: ["n1"], to: ["n0"] });
      model.scene(estimateText);
    }
    expect(model.items!.pending).toBe(false);
  });

  it("keep settled nodes where they are when such rows come", () => {
    const links = ring(30);
    const model = network(links);
    const [x, y] = placeOf(model, "n0");
    model.items!.setItemPosition(key("n0"), { x: x + 60, y });
    model.scene(estimateText);
    const settled = places(model, 30);
    links.append({ from: ["n1"], to: ["n2"] });
    model.scene(estimateText);
    expect(places(model, 30)).toEqual(settled);
  });

  it("lay out a large new component that more data follows before it has its places", () => {
    // The leaves' links of a new tree of 6,001 nodes, laid out with more data or without.
    const leaves = (more: boolean) => {
      const links = table({ from: ["a"], to: ["b"] });
      const model = new ChartModel({
        locale: "en-US",
        marks: [graph(links, { source: "from", target: "to" })],
      });
      model.setSize(600, 400, 1);
      mount(model);
      model.scene(estimateText);
      const from = Array.from({ length: 6001 }, (_, i) => `c${i + 1}`);
      links.append({ from, to: from.map((_, i) => `c${Math.floor(i / 2)}`) });
      model.scene(estimateText);
      if (more) links.append({ from: ["a"], to: ["d"] });
      for (let frame = 0; frame < 100_000 && model.items!.pending; frame++)
        model.scene(estimateText);
      let total = 0;
      for (let i = 5801; i <= 6000; i++)
        total += distance(placeOf(model, `c${i}`), placeOf(model, `c${Math.floor((i - 1) / 2)}`));
      return total / 200;
    };
    // On the spiral the tree starts on, they are hundreds of units long.
    const alone = leaves(false);
    expect(alone).toBeLessThan(6 * LINK_DISTANCE);
    expect(leaves(true)).toBeLessThan(alone * 1.5);
  }, 30_000);

  it("draw the data a layered layout changed to, though the layout before it failed", () => {
    const from: string[] = [];
    const to: string[] = [];
    for (let i = 0; i < 2000; i++) {
      from.push(`n${i}`);
      to.push(`n${i + 1}`);
    }
    for (let i = 2; i <= 2000; i++) {
      from.push("n0");
      to.push(`n${i}`);
    }
    const links = table({ from, to });
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(links, { source: "from", target: "to", layout: "layered" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    // Every scene takes one step: its deadline has passed when work looks.
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
    model.scene(estimateText);
    expect(model.items!.pending).toBe(true);
    // The data changes before the layout of the data before finds it cannot route its links.
    links.reset({ from: ["a"], to: ["b"] });
    let frame = 0;
    do model.scene(estimateText);
    while (++frame < 10_000 && model.items!.pending);
    vi.restoreAllMocks();
    expect(model.layoutSummary()).toMatch(/^Network of 2 nodes and 1 link;/);
  });
});

describe("data changes during work, from the third review", () => {
  /** A mounted model whose every scene takes one step of work. */
  const stepwise = (links: ReturnType<typeof ring>, options: Partial<GraphOptions<never>> = {}) => {
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(links as never, { source: "from", target: "to", ...options } as never)],
    });
    model.setSize(600, 400, 1);
    mount(model);
    let clock = 0;
    vi.spyOn(performance, "now").mockImplementation(() => (clock += 1000));
    return model;
  };
  const finish = (model: ChartModel) => {
    let frame = 0;
    do model.scene(estimateText);
    while (++frame < 100_000 && model.items!.pending);
    vi.restoreAllMocks();
  };

  it("lay out the latest data after rows that change nothing follow rows that do", () => {
    for (const layout of ["layered", "force"] as const) {
      const links = table({ from: ["a"], to: ["b"] });
      const model = stepwise(links as never, { layout });
      model.scene(estimateText);
      links.append({ from: ["b"], to: ["c"] });
      model.scene(estimateText);
      // A row of a link the network has, while work for the data before may go on.
      links.append({ from: ["a"], to: ["b"] });
      finish(model);
      for (const v of placeOf(model, "c")) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("keep a layered layout's bends with their links when rows come in another order", () => {
    const rows = { from: ["a", "b", "a", "c"], to: ["b", "c", "d", "d"] };
    const links = table(rows);
    // A nodes table keeps the nodes in one order.
    const nodes = table({ name: ["a", "b", "c", "d"] });
    const model = network(links as never, { layout: "layered", nodes, node: "name" } as never);
    const middles = () =>
      ["a b", "b c", "a d", "c d"].map((pair) => {
        const { px, py } = model.inspectItem(JSON.stringify([0, ...pair.split(" ")]))!.points[0]!;
        return [Math.round(px), Math.round(py)];
      });
    const before = middles();
    links.reset({ from: [...rows.from].reverse(), to: [...rows.to].reverse() });
    model.scene(estimateText);
    expect(middles()).toEqual(before);
  });

  it("find a circle's links where they are drawn after rows come in another order", () => {
    const from = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const to = from.map((_, i) => `n${(i + 7) % 30}`);
    const links = table({ from, to });
    const nodes = table({ name: from });
    const model = network(links as never, { layout: "circular", nodes, node: "name" } as never);
    links.reset({ from: [...from].reverse(), to: [...to].reverse() });
    model.scene(estimateText);
    for (let i = 0; i < 30; i += 5) {
      const link = JSON.stringify([0, from[i], to[i]]);
      const { px, py } = model.inspectItem(link)!.points[0]!;
      const item = model.inspect(px, py);
      expect(item?.axis === "item" && item.key).toBe(link);
    }
  });

  it("draw nodes at their new sizes when only the sizes change", () => {
    const links = table({ from: ["a"], to: ["b"] });
    const nodes = table({ name: ["a", "b"], weight: [1, 2] });
    const model = build({
      marks: [graph(links, { source: "from", target: "to", nodes, node: "name", size: "weight" })],
    });
    const radii = () =>
      model
        .scene(estimateText)
        .panels[0]!.marks.filter((m) => m.kind === "point")
        .flatMap((m) => Array.from((m as unknown as { radii: Float32Array }).radii));
    // Sizes scale by area against the largest: b's node shrinks once a's outweighs it.
    const before = Math.min(...radii());
    nodes.set("weight", 0, 16);
    expect(Math.min(...radii())).toBeLessThan(before - 1);
  });

  it("settle alike whether link values change before a move or after", () => {
    const make = () =>
      table({
        from: Array.from({ length: 20 }, (_, i) => `n${i}`),
        to: Array.from({ length: 20 }, (_, i) => `n${(i + 1) % 20}`),
        w: Array.from({ length: 20 }, () => 1),
      });
    const settled = (first: "move" | "value") => {
      const links = make();
      const model = build({ marks: [graph(links, { source: "from", target: "to", value: "w" })] });
      const [x, y] = placeOf(model, "n0");
      const move = () => model.items!.setItemPosition(key("n0"), { x: x + 50, y });
      const value = () => links.set("w", 1, 9);
      for (const step of first === "move" ? [move, value] : [value, move]) {
        step();
        model.scene(estimateText);
      }
      return places(model, 20);
    };
    expect(settled("move")).toEqual(settled("value"));
  });
});

describe("picking and memory, from the fourth review", () => {
  const found = (model: ChartModel, px: number, py: number) => {
    const item = model.inspect(px, py);
    return item?.axis === "item" ? item.key : undefined;
  };

  it("find each chart's nodes where it draws them, though the charts share a mark", () => {
    const names = Array.from({ length: 30 }, (_, i) => `n${i}`);
    const links = table({ from: ["n0"], to: ["n1"] });
    const mark = graph(links, { source: "from", target: "to" });
    const a = build({ marks: [mark] });
    // The charts see other data on the way to the same ring, so place its nodes otherwise.
    links.reset({ from: names.slice(1), to: names.slice(1).map(() => "n0") });
    const b = build({ marks: [mark] });
    links.reset({ from: names, to: names.map((_, i) => names[(i + 1) % 30]!) });
    for (const model of [a, b]) {
      model.scene(estimateText);
      for (const name of names) {
        const { px, py } = model.inspectItem(key(name))!.points[0]!;
        expect(found(model, px, py)).toBe(key(name));
      }
    }
  });

  it("find a link where it bows out past its nodes, once the view is panned there", () => {
    const links = table({ from: ["a", "b", "a", "b"], to: ["b", "a", "c", "c"] });
    const model = build({
      marks: [graph(links, { source: "from", target: "to", directed: true, layout: "circular" })],
      interaction: { zoom: true },
    });
    // a and b 50 px above the room, the link from b to a bowing up past them.
    const plane = model.items!.result()!.plane!;
    const top = plane.y.invert(-50);
    model.items!.setItemPosition(key("a"), { x: plane.x.invert(150), y: top });
    model.items!.setItemPosition(key("b"), { x: plane.x.invert(450), y: top });
    model.scene(estimateText);
    const [y0, y1] = plane.y.domain;
    model.items!.setView(
      { x: plane.x.domain, y: [y0 - (y1 - y0) / 2, y1 - (y1 - y0) / 2] },
      undefined,
    );
    model.scene(estimateText);
    const link = JSON.stringify([0, "b", "a"]);
    const { px, py } = model.inspectItem(link)!.points[0]!;
    expect(py).toBeGreaterThan(0);
    expect(py).toBeLessThan(model.inspectItem(key("a"))!.points[0]!.py - 10);
    expect(found(model, px, py)).toBe(link);
  });

  it("keep moves of the nodes a network too large to draw has, for when it is drawn again", () => {
    const links = table({ from: ["a", "b"], to: ["b", "c"] });
    const model = network(links as never);
    model.items!.setItemPosition(key("a"), { x: 1, y: 2 });
    model.items!.setItemPosition(key("c"), { x: 3, y: 4 });
    const many = Array.from({ length: 50_001 }, (_, i) => `m${i}`);
    links.reset({ from: ["a", ...many], to: ["b", ...many.map(() => "b")] });
    model.scene(estimateText);
    expect(model.layoutSummary()).toMatch(/too many to lay out/);
    // c has gone; a stays moved, and can be moved meanwhile.
    expect(model.items!.positions()).toEqual({ [key("a")]: { x: 1, y: 2 } });
    model.items!.setItemPosition(key("b"), { x: 5, y: 6 });
    links.reset({ from: ["a"], to: ["b"] });
    model.scene(estimateText);
    expect(placeOf(model, "a")).toEqual([1, 2]);
    expect(placeOf(model, "b")).toEqual([5, 6]);
  });
});

describe("moving nodes of hidden groups", () => {
  it("move a node its group hides, drawn there once shown", () => {
    const links = table({ from: ["a", "b"], to: ["b", "c"] });
    const nodes = table({ name: ["a", "b", "c"], team: ["x", "y", "y"] });
    const model = build({
      marks: [graph(links, { source: "from", target: "to", nodes, node: "name", color: "team" })],
    });
    const legend = model.scene(estimateText).legend;
    model.hidden.add(legend.find(({ label }) => label === "x")!.key);
    model.scene(estimateText);
    expect(model.items!.setItemPosition(key("a"), { x: 7, y: 8 })).toEqual({
      key: key("a"),
      position: { x: 7, y: 8 },
    });
    expect(() => model.items!.setItemPosition(key("z"), { x: 1, y: 1 })).toThrow(
      /setItemPosition: no node .* in the network/,
    );
    model.hidden.clear();
    model.scene(estimateText);
    const [x, y] = placeOf(model, "a");
    expect([x, y].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([7, 8]);
  });
});

describe("settling, from the fifth review", () => {
  it("settle around a node moved however far", () => {
    const model = network(table({ from: ["a"], to: ["b"] }) as never);
    model.items!.setItemPosition(key("a"), { x: 1e20, y: 0 });
    // The nodes near where it was put are looked up in a few cells, however far out.
    model.scene(estimateText);
    expect(model.items!.positions()).toEqual({ [key("a")]: { x: 1e20, y: 0 } });
  });
});

describe("circular and layered layouts", () => {
  const tree = () =>
    table({ from: ["a", "a", "b", "b", "c"], to: ["b", "c", "d", "e", "f"] }) as never;

  it("put nodes on a circle, the most connected first from the top, clockwise", () => {
    const model = network(tree(), { layout: "circular" });
    const radius = (6 * LINK_DISTANCE) / (2 * Math.PI);
    for (const name of "abcdef") expect(Math.hypot(...placeOf(model, name))).toBeCloseTo(radius);
    // b has three links: first, at the top; then a and c (two links), by name.
    expect(placeOf(model, "b")[0]).toBeCloseTo(0);
    expect(placeOf(model, "b")[1]).toBeCloseTo(-radius);
    const angle = (name: string) => {
      const [x, y] = placeOf(model, name);
      return (Math.atan2(y, x) + 2.5 * Math.PI) % (2 * Math.PI);
    };
    expect(angle("a") < angle("c") && angle("c") < angle("d")).toBe(true);
    const named = network(tree(), { layout: { type: "circular", sort: "name" } });
    expect(placeOf(named, "a")[1]).toBeCloseTo(-radius);
  });

  it("turn a circle to move nodes least when one is added", () => {
    const links = ring(20);
    const model = network(links as never, { layout: { type: "circular", sort: "input" } });
    const before = places(model, 20);
    links.append({ from: ["n19"], to: ["n20"] });
    model.scene(estimateText);
    const after = places(model, 20);
    let total = 0;
    for (let i = 0; i < 20; i++) total += distance(after[i]!, before[i]!);
    // The circle grows by a slot; turned, nodes move about a slot's worth at most.
    expect(total / 20).toBeLessThan(LINK_DISTANCE);
  });

  it("lay a tree out in layers, links curving through the layers", () => {
    const model = network(tree(), { layout: { type: "layered", direction: "right" } });
    const [ax] = placeOf(model, "a");
    const [bx] = placeOf(model, "b");
    const [dx] = placeOf(model, "d");
    expect(bx - ax).toBeGreaterThan(LINK_DISTANCE);
    expect(dx - bx).toBeCloseTo(bx - ax);
    // Curves are drawn as chords.
    const links = model
      .scene(estimateText)
      .panels[0]!.marks.filter((m) => m.key.startsWith("graph-links"));
    expect(
      links.reduce((sum, m) => sum + (m as unknown as { count: number }).count, 0),
    ).toBeGreaterThan(5);
  });

  it("fit a layered layout's bending links in the room", () => {
    // Every forward pair of 20 nodes: long links bend far out beside the chain.
    const from: string[] = [];
    const to: string[] = [];
    for (let i = 0; i < 20; i++)
      for (let j = i + 1; j < 20; j++) {
        from.push(`n${i}`);
        to.push(`n${j}`);
      }
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(table({ from, to }), { source: "from", target: "to", layout: "layered" })],
    });
    model.setSize(600, 400, 1);
    const scene = model.scene(estimateText);
    const { plot, marks } = scene.panels[0]!;
    for (const mark of marks.filter((m) => m.key.startsWith("graph-links"))) {
      const { coords } = mark as unknown as { coords: Float32Array };
      for (let i = 0; i < coords.length; i += 2) {
        expect(coords[i]!).toBeGreaterThanOrEqual(plot.x - 1);
        expect(coords[i]!).toBeLessThanOrEqual(plot.x + plot.width + 1);
      }
    }
  });

  it("keep a layered layout's links each way apart, and find both", () => {
    const pair = table({ from: ["a", "b"], to: ["b", "a"] }) as never;
    const model = network(pair, { layout: "layered", directed: true });
    const ab = model.inspectItem(JSON.stringify([0, "a", "b"]))!.points[0]!;
    const ba = model.inspectItem(JSON.stringify([0, "b", "a"]))!.points[0]!;
    expect(Math.abs(ab.px - ba.px) + Math.abs(ab.py - ba.py)).toBeGreaterThan(4);
    const found = (x: number, y: number) => {
      const item = model.inspect(x, y);
      return item?.axis === "item" ? item.key : undefined;
    };
    expect(found(ab.px, ab.py)).toBe(JSON.stringify([0, "a", "b"]));
    expect(found(ba.px, ba.py)).toBe(JSON.stringify([0, "b", "a"]));
  });

  it("say which links close cycles in a layered layout", () => {
    const cycle = table({ from: ["a", "b", "c"], to: ["b", "c", "a"] }) as never;
    const model = network(cycle, { layout: "layered", directed: true });
    expect(model.layoutSummary()).toContain("1 link closes a cycle and runs against the layers.");
  });

  it("draw nothing, and say why, where links span too many layers to route", () => {
    const from: string[] = [];
    const to: string[] = [];
    for (let i = 0; i < 2000; i++) {
      from.push(`n${i}`);
      to.push(`n${i + 1}`);
    }
    for (let i = 2; i <= 2000; i++) {
      from.push("n0");
      to.push(`n${i}`);
    }
    const model = network(table({ from, to }) as never, { layout: "layered" });
    expect(model.layoutSummary()).toBe(
      "Network of 2,001 nodes and 3,999 links: too many layers between linked nodes to route (1,999,000 bend points, more than the 500,000 a layered layout routes); use another layout, or filter the links.",
    );
    // Its nodes can be moved meanwhile, and keep their moves.
    model.items!.setItemPosition(key("n1"), { x: 1, y: 2 });
    model.scene(estimateText);
    expect(model.items!.positions()).toEqual({ [key("n1")]: { x: 1, y: 2 } });
  });

  it("keep moved nodes where they were put as the layout changes", () => {
    const links = tree();
    const model = network(links);
    model.items!.setItemPosition(key("d"), { x: 5, y: 6 });
    model.update({ marks: [graph(links, { source: "from", target: "to", layout: "layered" })] });
    model.scene(estimateText);
    expect(placeOf(model, "d")).toEqual([5, 6]);
    expect(model.items!.movedItems().size).toBe(1);
  });
});

describe("layouts over frames", () => {
  it("lay out a little each frame of a mounted chart, ending where a whole layout does", () => {
    const links = communities();
    const whole = network(links as never);
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(links, { source: "from", target: "to" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    let frames = 0;
    do {
      model.scene(estimateText);
      model.items!.drawControls(model.scene(estimateText));
      frames++;
    } while (model.items!.pending && frames < 10_000);
    expect(frames).toBeGreaterThan(1);
    expect(places(model, 100)).toEqual(places(whole, 100));
  });

  it("say they are arranging until there is something to draw", () => {
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(communities(), { source: "from", target: "to" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    const pending = model.items!.controlsLoading;
    model.scene(estimateText);
    expect(model.items!.pending).toBe(true);
    expect(model.layoutSummary()).toMatch(
      /^Arranging the network of 1,500 nodes and \d{1,3}(,\d{3})* links\.$|The nodes are still being arranged\./,
    );
    expect(pending).toBeInstanceOf(Promise);
  });

  it("work between frames that draw, which show large networks' progress now and then", () => {
    const small = new ChartModel({
      locale: "en-US",
      marks: [graph(communities(), { source: "from", target: "to" })],
    });
    small.setSize(600, 400, 1);
    mount(small);
    small.scene(estimateText);
    // A small network's progress shows at every frame.
    expect(small.items!.workLayouts()).toBe(true);
    const big = new ChartModel({
      locale: "en-US",
      marks: [graph(large(), { source: "from", target: "to" })],
    });
    big.setSize(600, 400, 1);
    mount(big);
    // Until there is something to show, and just after it was shown, frames only work.
    for (let frame = 0; frame < 1000; frame++) {
      big.scene(estimateText);
      if (big.items!.result()!.plane) break;
      big.items!.workLayouts();
    }
    expect(big.items!.pending).toBe(true);
    expect(big.items!.workLayouts()).toBe(false);
  });

  it("take moves while arranging, which hold once there is something to draw", () => {
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(large(), { source: "from", target: "to" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    model.scene(estimateText);
    expect(model.items!.result()!.plane).toBeUndefined();
    model.items!.setItemPosition(key("n1"), { x: 7, y: 8 });
    expect(() => model.items!.setItemPosition(key("nobody"), { x: 0, y: 0 })).toThrow(
      "setItemPosition: no node",
    );
    for (let frame = 0; frame < 100_000 && model.items!.pending; frame++) model.scene(estimateText);
    expect(model.items!.positions()).toEqual({ [key("n1")]: { x: 7, y: 8 } });
    const { plane } = model.items!.result()!;
    const { px, py } = model.inspectItem(key("n1"))!.points[0]!;
    expect([px, py]).toEqual([plane!.x.map(7), plane!.y.map(8)]);
  });

  it("show only where work starts and ends with reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const model = new ChartModel({
      locale: "en-US",
      marks: [graph(communities(), { source: "from", target: "to" })],
    });
    model.setSize(600, 400, 1);
    mount(model);
    const seen = new Set<string>();
    for (let frame = 0; frame < 10_000; frame++) {
      model.scene(estimateText);
      const inspection = model.inspectItem(key("n1"));
      if (inspection) seen.add(`${inspection.points[0]!.px} ${inspection.points[0]!.py}`);
      if (!model.items!.pending) break;
    }
    expect(model.items!.pending).toBe(false);
    expect(seen.size).toBeLessThanOrEqual(2);
  });
});

describe("layout options", () => {
  const links = () => table({ from: ["a"], to: ["b"] });

  it("refuse layouts and options a layout does not have", () => {
    const make = (layout: unknown) => () =>
      graph(links(), { source: "from", target: "to", layout: layout as never });
    expect(make("tree")).toThrow(
      'graph layout: expected "force", "circular", or "layered"; received "tree"',
    );
    expect(make({ type: "circular", settle: true })).toThrow(
      'graph layout.settle: only a force layout settles; drop settle, or use type "force"',
    );
    expect(make({ type: "force", direction: "down" })).toThrow(
      'graph layout.direction: only a layered layout has a direction; drop direction, or use type "layered"',
    );
    expect(make({ type: "layered", direction: "sideways" })).toThrow(
      'graph layout.direction: expected "down", "right", "up", or "left"; received "sideways"',
    );
    expect(make({ type: "circular", sort: "size" })).toThrow(
      'graph layout.sort: expected "degree", "input", or "name"; received "size"',
    );
    expect(make({ type: "force", speed: 2 })).toThrow(
      "graph layout.speed: not an option of a force layout; drop speed",
    );
    expect(make({ type: "force", settle: "yes" })).toThrow(
      'graph layout.settle: expected true or false; received "yes"',
    );
  });

  it("travel in specs, checked there", () => {
    const spec = (layout: unknown) => ({
      version: 1,
      data: { talks: { columns: { from: ["a"], to: ["b"] } } },
      marks: [{ type: "graph", source: "from", target: "to", layout }],
    });
    expect(() => checkSpec(spec({ type: "layered", direction: "up" }) as never)).not.toThrow();
    expect(() => checkSpec(spec("spiral") as never)).toThrow(
      'marks[0].layout: expected "force", "circular", or "layered"; received "spiral"',
    );
    expect(checkSpec(spec({ type: "circular", direction: "up" }) as never)).toEqual([
      "marks[0].layout.direction",
    ]);
    expect(() => validateSpec(spec({ type: "circular", direction: "up" }))).toThrow(
      /marks\[0\]\.layout\.direction/,
    );
    const mark = graph(links(), { source: "from", target: "to", layout: { type: "circular" } });
    expect(mark.spec.layout).toEqual({ type: "circular" });
    const { config } = loadSpec(
      {
        data: {
          t: {
            columns: {
              from: { type: "category", codes: [0], dictionary: ["a"] },
              to: { type: "category", codes: [0], dictionary: ["b"] },
            },
          },
        },
        marks: [{ type: "graph", source: "from", target: "to", layout: "layered" }],
      },
      [],
    );
    expect(config.marks[0]!.spec).toMatchObject({ layout: "layered" });
  });
});
