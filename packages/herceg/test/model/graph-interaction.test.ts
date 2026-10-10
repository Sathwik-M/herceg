// Networks' directed links and link labels, nodes moved by the chart's
// user, and rows of either table selected and highlighted.

import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { type SelectionStore, selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { graph } from "../../src/marks/graph.ts";
import { DIM } from "../../src/marks/mark.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { brushedRows, clickedRows } from "../../src/model/selected-rows.ts";
import type {
  PointGeometry,
  Scene,
  SegmentGeometry,
  ShapesGeometry,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { checkSpec, validateSpec } from "../../src/spec/validate.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const marksOf = <T>(scene: Scene, kind: string, prefix: string) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind && m.key.startsWith(prefix)) as T[];
const at = (model: ChartModel, name: string) => {
  const { px, py } = model.inspectItem(JSON.stringify([0, name]))!.points[0]!;
  return [px, py] as const;
};

const follows = () =>
  table({
    from: ["a", "b", "a", "c", "c"],
    to: ["b", "a", "c", "d", "d"],
    kind: ["likes", "likes", "knows", "knows", "follows"],
  });

it("picks a link across a fractional bottom plot row with both nodes offscreen", () => {
  const { model, scene } = build(
    {
      marks: [
        graph(table({ from: ["a"], to: ["b"] }), { source: "from", target: "to", labels: false }),
      ],
    },
    600,
    400.1,
  );
  const plane = model.items!.result()!.plane!;
  const plot = scene.panels[0]!.plot;
  const y = plot.y + plot.height - 0.05;
  model.items!.setItemPosition('[0,"a"]', { x: plane.x.invert(-1000), y: plane.y.invert(y) });
  model.items!.setItemPosition('[0,"b"]', { x: plane.x.invert(2000), y: plane.y.invert(y) });
  model.scene(estimateText);
  const found = model.inspect(300, y);
  expect(found?.axis === "item" && found.key).toBe('[0,"a","b"]');
});

describe("directed networks", () => {
  it("keep a link each way, bow a pair's two apart, and point arrowheads at targets", () => {
    const { model, scene } = build({
      marks: [graph(follows(), { source: "from", target: "to", directed: true })],
    });
    const read = (key: unknown[]) => model.inspectItem(JSON.stringify(key)) as ItemInspection;
    expect(read([0, "a", "b"]).points[0]!.label).toBe("a → b");
    expect(read([0, "b", "a"]).points[0]!.label).toBe("b → a");
    // c → d's two rows are one link; d → c is none.
    expect(read([0, "c", "d"]).points[0]!.text).toBe("2");
    expect(read([0, "d", "c"])).toBeUndefined();
    // a ⇄ b bow apart as curves; a → c and c → d are straight, each with an arrowhead of two strokes.
    const bows = marksOf<ShapesGeometry>(scene, "shapes", "graph-bows");
    expect(
      bows
        .flatMap(({ shapes }) => shapes)
        .map((shape) => (shape as { d: string }).d.split("Q").length - 1),
    ).toEqual([2]);
    const segments = marksOf<SegmentGeometry>(scene, "segments", "graph-links");
    expect(segments.reduce((n, g) => n + g.count, 0)).toBe(2 + 4 * 2);
    // The link into d ends at d's ring, not its center, where its arrowhead's strokes start.
    const [dx, dy] = at(model, "d");
    const ends = segments.flatMap((g) =>
      Array.from({ length: g.count }, (_, i) =>
        Math.hypot(g.coords[i * 4 + 2]! - dx, g.coords[i * 4 + 3]! - dy),
      ),
    );
    const starts = segments.flatMap((g) =>
      Array.from({ length: g.count }, (_, i) =>
        Math.hypot(g.coords[i * 4]! - dx, g.coords[i * 4 + 1]! - dy),
      ),
    );
    const tip = Math.min(...ends);
    expect(tip).toBeGreaterThan(4);
    expect(tip).toBeLessThan(8);
    expect(starts.filter((d) => Math.abs(d - tip) < 1e-3)).toHaveLength(2);
    expect(model.layoutSummary()).toMatch(/^Network of 4 nodes and 4 directed links;/);
  });
});

describe("link labels", () => {
  it("write links' names where there is room, and none where rows name a link differently", () => {
    const { model, scene } = build({
      marks: [graph(follows(), { source: "from", target: "to", linkLabelField: "kind" })],
    });
    const names = marksOf<TextGeometry>(scene, "text", "graph-link-labels").flatMap(
      ({ labels }) => labels,
    );
    expect(names.sort()).toEqual(["knows", "likes"]);
    const read = (key: unknown[]) =>
      (model.inspectItem(JSON.stringify(key)) as ItemInspection).points[0]!.text;
    expect(read([0, "a", "b"])).toBe("likes: 2");
    expect(read([0, "c", "d"])).toBe("2");
    expect(model.layoutSummary()).toContain("1 link whose rows name it differently has no label.");
  });

  it("load from specs", () => {
    const spec = (mark: Record<string, unknown>) => ({
      data: { l: { columns: { from: ["a"], to: ["b"], kind: ["x"] } } },
      marks: [{ type: "graph", data: "l", source: "from", target: "to", ...mark }],
    });
    expect(checkSpec(spec({ directed: true, linkLabelField: "kind" }) as never)).toEqual([]);
    expect(checkSpec(spec({ directed: false }) as never)).toEqual([]);
    expect(() => validateSpec(spec({ directed: "yes" }))).toThrow(/marks\[0\]\.directed/);
  });
});

const ring = () => table({ from: ["a", "b", "c", "d"], to: ["b", "c", "d", "a"], w: [1, 2, 3, 4] });

describe("moved nodes", () => {
  it("draw where they were put, in layout units, with their links, leaving the others", () => {
    const { model } = build({ marks: [graph(ring(), { source: "from", target: "to" })] });
    const before = ["a", "b", "c", "d"].map((name) => at(model, name));
    const moves = model.items!.result()!.moves!;
    const [x, y] = moves.toLayout('[0,"a"]', 100, 120);
    expect(model.items!.setItemPosition('[0,"a"]', { x, y })).toEqual({
      key: '[0,"a"]',
      position: { x, y },
    });
    const scene = model.scene(estimateText);
    const [ax, ay] = at(model, "a");
    expect(ax).toBeCloseTo(100, 6);
    expect(ay).toBeCloseTo(120, 6);
    expect(["b", "c", "d"].map((name) => at(model, name))).toEqual(before.slice(1));
    // a's links start where it is now.
    const coords = marksOf<SegmentGeometry>(scene, "segments", "graph-links").flatMap((g) =>
      Array.from(g.coords),
    );
    expect(coords).toContain(Math.fround(100));
    // The same place again changes nothing; null puts it back.
    expect(model.items!.setItemPosition('[0,"a"]', { x, y })).toBeUndefined();
    expect(model.items!.setItemPosition('[0,"a"]', null)).toEqual({
      key: '[0,"a"]',
      position: null,
    });
    model.scene(estimateText);
    expect(at(model, "a")).toEqual(before[0]);
    expect(() => model.items!.setItemPosition('[0,"z"]', { x, y })).toThrow(
      "setItemPosition: no node",
    );
    expect(() => model.items!.setItemPosition('[0,"a","b"]', { x, y })).toThrow(
      "setItemPosition: no node",
    );
    expect(() => model.items!.setItemPosition('[0,"a"]', { x: Number.NaN, y })).toThrow(
      `setItemPosition position: expected finite x and y; received x NaN, y ${y}`,
    );
  });

  it("follow a resize in layout units, and go when the network changes", () => {
    const links = ring();
    const { model } = build({ marks: [graph(links, { source: "from", target: "to" })] });
    const moves = model.items!.result()!.moves!;
    const [x, y] = moves.toLayout('[0,"c"]', 80, 90);
    model.items!.setItemPosition('[0,"c"]', { x, y });
    model.setSize(900, 600, 1);
    model.scene(estimateText);
    const after = model.items!.result()!.moves!;
    expect(after.toLayout('[0,"c"]', ...at(model, "c"))[0]).toBeCloseTo(x, 6);
    links.append({ from: ["d"], to: ["e"], w: [1] });
    model.scene(estimateText);
    expect(model.items!.movedItems.size).toBe(0);
  });
});

/** A network bound to stores of its tables, as a mounted chart binds it. */
function bound<L extends Schema, N extends Schema>(
  config: ChartConfig,
  links: SelectionStore<L>,
  nodes?: SelectionStore<N>,
) {
  const selection = nodes
    ? rowSelection({ store: links, channel: "c" }, { store: nodes, channel: "c" })
    : rowSelection({ store: links, channel: "c" });
  const { model } = build({ ...config, rowSelection: selection });
  const chart = { selection: null, select() {}, render() {}, root: new EventTarget() as never };
  selection.mount(
    undefined,
    model,
    chart,
    { emit() {} },
    () => {},
    () => null,
    {
      textContent: null,
    },
  );
  return model;
}

describe("network row selection", () => {
  const people = () => table({ name: ["a", "b", "c", "d", "a"], team: ["x", "x", "y", "y", "z"] });

  it("selects a node's rows of the nodes table, and a link's rows of the links table", () => {
    const links = follows();
    const nodes = people();
    const model = bound(
      { marks: [graph(links, { source: "from", target: "to", nodes, node: "name" })] },
      selectionStore(links),
      selectionStore(nodes),
    );
    const tables = new Set([links, nodes] as unknown as Table[]);
    // a is named by two rows of the nodes table.
    expect(clickedRows(model, tables, ...at(model, "a"))).toEqual({
      table: nodes,
      rows: Uint32Array.of(0, 4),
    });
    // a — b's rows each way, of the links table.
    const link = model.inspectItem('[0,"a","b"]')!.points[0]!;
    expect(clickedRows(model, tables, link.px, link.py)).toEqual({
      table: links,
      rows: Uint32Array.of(0, 1),
    });
    // With the links table alone bound, a node stands for none of its rows.
    const linksOnly = bound(
      { marks: [graph(links, { source: "from", target: "to", nodes, node: "name" })] },
      selectionStore(links),
    );
    expect(
      clickedRows(linksOnly, new Set([links as unknown as Table]), ...at(linksOnly, "a")),
    ).toBeNull();
  });

  it("dims nodes and links none of whose rows are selected", () => {
    const links = follows();
    const nodes = people();
    const linkStore = selectionStore(links);
    const nodeStore = selectionStore(nodes);
    const model = bound(
      { marks: [graph(links, { source: "from", target: "to", nodes, node: "name" })] },
      linkStore,
      nodeStore,
    );
    nodeStore.set("c", selectRows(new RowSet(nodes).add(2).add(3)));
    linkStore.set("c", selectRows(new RowSet(links).add(3)));
    const scene = model.scene(estimateText);
    const points = marksOf<PointGeometry>(scene, "point", "graph-nodes");
    expect(points.map(({ key, count, fillOpacity }) => [key, count, fillOpacity])).toEqual([
      ["graph-nodes-dimmed", 2, DIM],
      ["graph-nodes", 2, 1],
    ]);
    const segments = marksOf<SegmentGeometry>(scene, "segments", "graph-links");
    const lit = segments.filter((g) => g.opacity === 0.45);
    expect(lit.reduce((n, g) => n + g.count, 0)).toBe(1);
  });
});

describe("overlapping nodes and links", () => {
  /** Nodes a and b moved to one place, and what the pointer finds there. */
  const stacked = (model: ChartModel) => {
    const moves = model.items!.result()!.moves!;
    for (const key of ['[0,"a"]', '[0,"b"]']) {
      const [x, y] = moves.toLayout(key, 300, 200);
      model.items!.setItemPosition(key, { x, y });
    }
    model.scene(estimateText);
    const [px, py] = at(model, "a");
    return () => (model.inspect(px, py) as ItemInspection | undefined)?.key;
  };

  it("find the one drawn on top: the selection's, then the smaller, then the later", () => {
    const links = follows();
    const nodes = table({ name: ["a", "b", "c", "d"], weight: [1, 1, 1, 1] });
    const nodeStore = selectionStore(nodes);
    const model = bound(
      { marks: [graph(links, { source: "from", target: "to", nodes, node: "name" })] },
      selectionStore(links),
      nodeStore,
    );
    const found = stacked(model);
    expect(found()).toBe('[0,"b"]');
    nodeStore.set("c", selectRows(new RowSet(nodes).add(0)));
    model.scene(estimateText);
    expect(found()).toBe('[0,"a"]');
    // A click there selects the rows of the node on top.
    const tables = new Set([links, nodes] as unknown as Table[]);
    expect(clickedRows(model, tables, ...at(model, "a"))).toEqual({
      table: nodes,
      rows: Uint32Array.of(0),
    });
    // Keys still read nodes in order.
    expect(model.stepItem(undefined, 1)).toBe('[0,"a"]');

    // A larger node is drawn below a smaller one.
    const sized = table({ name: ["a", "b", "c", "d"], weight: [1, 9, 1, 1] });
    const { model: bySize } = build({
      marks: [
        graph(links, { source: "from", target: "to", nodes: sized, node: "name", size: "weight" }),
      ],
    });
    const below = stacked(bySize);
    expect(below()).toBe('[0,"a"]');
  });

  it("find the link drawn on top where links overlap: the selection's, then the later", () => {
    const links = table({ from: ["a", "c"], to: ["b", "d"] });
    const linkStore = selectionStore(links);
    const model = bound({ marks: [graph(links, { source: "from", target: "to" })] }, linkStore);
    // c — d laid over a — b.
    const moves = model.items!.result()!.moves!;
    for (const [key, px, py] of [
      ['[0,"a"]', 200, 200],
      ['[0,"c"]', 200, 200],
      ['[0,"b"]', 400, 200],
      ['[0,"d"]', 400, 200],
    ] as const) {
      const [x, y] = moves.toLayout(key, px, py);
      model.items!.setItemPosition(key, { x, y });
    }
    model.scene(estimateText);
    const found = () => (model.inspect(300, 200) as ItemInspection | undefined)?.key;
    expect(found()).toBe('[0,"c","d"]');
    linkStore.set("c", selectRows(new RowSet(links).add(0)));
    model.scene(estimateText);
    expect(found()).toBe('[0,"a","b"]');
    expect(clickedRows(model, new Set([links as unknown as Table]), 300, 200)).toEqual({
      table: links,
      rows: Uint32Array.of(0),
    });
  });
});

describe("node colors", () => {
  it("draw more than 256 colors, each node its own", () => {
    const count = 300;
    const names = Array.from({ length: count }, (_, i) => `n${i}`);
    const palette = names.map((_, i) => `#${(i + 1).toString(16).padStart(6, "0")}`);
    const links = table({ from: names.slice(0, -1), to: names.slice(1) });
    const nodes = table({ name: names, team: names });
    const { model, scene } = build({
      marks: [
        graph(links, {
          source: "from",
          target: "to",
          nodes,
          node: "name",
          color: "team",
          labels: false,
        }),
      ],
      theme: { palette },
    });
    const drawn = marksOf<PointGeometry>(scene, "point", "graph-nodes");
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.reduce((n, g) => n + g.count, 0)).toBe(count);
    // The nodes drawn in the colors their items report, every one of them.
    const colors = drawn.flatMap((g) =>
      Array.from({ length: g.count }, (_, k) =>
        g.colors ? g.colors.palette[g.colors.index[k]!]! : g.fill,
      ),
    );
    const reported = names.map(
      (name) => model.inspectItem(JSON.stringify([0, name]))!.points[0]!.color,
    );
    expect(colors.sort()).toEqual(reported.sort());
    expect(new Set(colors).size).toBe(count);
  });
});

describe("interaction.drag in specs", () => {
  it("needs a network to move", () => {
    const spec = (type: string) => ({
      data: { l: { columns: { from: ["a"], to: ["b"] } } },
      interaction: { drag: true },
      marks: [
        type === "graph"
          ? { type, data: "l", source: "from", target: "to" }
          : { type, data: "l", category: "from" },
      ],
    });
    expect(() => validateSpec(spec("pie"))).toThrow(
      /spec\.interaction\.drag: expected a spec with a graph mark/,
    );
    validateSpec(spec("graph"));
  });
});

describe("network moves and rows, kept apart from what changes", () => {
  it("keep moves when the mark is made again with other styles", () => {
    const links = ring();
    const { model } = build({ marks: [graph(links, { source: "from", target: "to" })] });
    const moves = model.items!.result()!.moves!;
    const [x, y] = moves.toLayout('[0,"a"]', 90, 80);
    model.items!.setItemPosition('[0,"a"]', { x, y });
    model.update({ marks: [graph(links, { source: "from", target: "to", labels: false })] });
    model.scene(estimateText);
    expect(model.items!.movedItems.size).toBe(1);
    expect(at(model, "a")[0]).toBeCloseTo(90, 6);
  });

  it("leave a selection alone when a node with no row of its nodes table is clicked", () => {
    const links = follows();
    const nodes = table({ name: ["a", "b"], team: ["x", "y"] });
    const model = bound(
      { marks: [graph(links, { source: "from", target: "to", nodes, node: "name" })] },
      selectionStore(links),
      selectionStore(nodes),
    );
    const tables = new Set([links, nodes] as unknown as Table[]);
    // d is only named by links.
    expect(clickedRows(model, tables, ...at(model, "d"))).toBeNull();
    expect(clickedRows(model, tables, ...at(model, "a"))?.rows).toEqual(Uint32Array.of(0));
  });
});

describe("moves across charts, groups, and changes", () => {
  it("keep each chart's moves while another draws the same tables laid out otherwise", () => {
    const links = ring();
    const a = build({ marks: [graph(links, { source: "from", target: "to" })] }).model;
    const b = build({ marks: [graph(links, { source: "from", target: "to", value: "w" })] }).model;
    const [x, y] = a.items!.result()!.moves!.toLayout('[0,"a"]', 70, 60);
    a.items!.setItemPosition('[0,"a"]', { x, y });
    for (let i = 0; i < 2; i++) {
      a.scene(estimateText);
      b.scene(estimateText);
    }
    expect(a.items!.movedItems.size).toBe(1);
    expect(at(a, "a")[0]).toBeCloseTo(70, 6);
  });

  it("put back a node moved before its group was hidden, and drop moves of another mark id", () => {
    const links = ring();
    const nodes = table({ name: ["a", "b", "c", "d"], team: ["x", "x", "y", "y"] });
    const marks = (id?: string) => [
      graph(links, {
        source: "from",
        target: "to",
        nodes,
        node: "name",
        color: "team",
        ...(id && { id }),
      }),
    ];
    const { model, scene } = build({ marks: marks() });
    const [x, y] = model.items!.result()!.moves!.toLayout('[0,"a"]', 70, 60);
    model.items!.setItemPosition('[0,"a"]', { x, y });
    model.hidden.add(scene.legend[0]!.key);
    model.scene(estimateText);
    expect(model.items!.setItemPosition('[0,"a"]', null)).toEqual({
      key: '[0,"a"]',
      position: null,
    });
    model.hidden.clear();
    model.scene(estimateText);
    model.items!.setItemPosition('[0,"b"]', { x, y });
    model.update({ marks: marks("net") });
    model.scene(estimateText);
    expect(model.items!.movedItems.size).toBe(0);
  });

  it("leave a drag's place behind when the network changes under it", () => {
    const links = ring();
    const { model } = build({ marks: [graph(links, { source: "from", target: "to" })] });
    const moves = model.items!.result()!.moves!;
    model.items!.drag('[0,"a"]', moves.toLayout('[0,"a"]', 50, 50));
    model.scene(estimateText);
    expect(at(model, "a")[0]).toBeCloseTo(50, 6);
    links.append({ from: ["a"], to: ["e"], w: [1] });
    model.scene(estimateText);
    const automatic = at(model, "a");
    model.scene(estimateText);
    expect(at(model, "a")).toEqual(automatic);
    expect(automatic[0]).not.toBeCloseTo(50, 0);
  });
});

describe("network navigation and lassos", () => {
  const half = (range: readonly [number, number]) =>
    [range[0] + (range[1] - range[0]) / 4, range[1] - (range[1] - range[0]) / 4] as const;

  it("magnifies the separated placement without changing radii, widths, or layout positions", () => {
    const { model, scene } = build({
      marks: [graph(ring(), { source: "from", target: "to", labels: false })],
      interaction: { zoom: "xy", drag: true },
    });
    const before = ["a", "b", "c", "d"].map((name) => at(model, name));
    const base = model.items!.result()!.plane!;
    const identity = model.items!.result()!.moves!.layout;
    model.setViewport(half(base.x.domain));
    model.setYViewport({ y: half(base.y.domain), yRight: null });
    const zoomed = model.scene(estimateText);
    const plane = model.items!.result()!.plane!;
    const { plot } = scene.panels[0]!;
    for (const [i, name] of ["a", "b", "c", "d"].entries()) {
      const [x, y] = at(model, name);
      expect(x).toBeCloseTo(
        plot.x + plot.width / 2 + (before[i]![0] - plot.x - plot.width / 2) * 2,
      );
      expect(y).toBeCloseTo(
        plot.y + plot.height / 2 + (before[i]![1] - plot.y - plot.height / 2) * 2,
      );
    }
    expect(plane.zoom).toBeCloseTo(2);
    expect(model.items!.result()!.moves!.layout).toBe(identity);
    const radii = (s: Scene) =>
      marksOf<PointGeometry>(s, "point", "graph-nodes").map((g) => Array.from(g.radii!));
    expect(radii(zoomed)).toEqual(radii(scene));
    expect(
      marksOf<SegmentGeometry>(zoomed, "segments", "graph-links").map((g) => g.strokeWidth),
    ).toEqual(marksOf<SegmentGeometry>(scene, "segments", "graph-links").map((g) => g.strokeWidth));
    model.setViewport(null);
    model.setYViewport({ y: null, yRight: null });
    model.scene(estimateText);
    expect(["a", "b", "c", "d"].map((name) => at(model, name))).toEqual(before);
  });

  it("uses layout coordinates for moves while zoomed and lets moved nodes leave the view", () => {
    const { model } = build({ marks: [graph(ring(), { source: "from", target: "to" })] });
    const fitted = model.items!.result()!.plane!;
    const layout = model.items!.result()!.moves!.layout;
    model.setViewport(half(fitted.x.domain));
    model.setYViewport({ y: half(fitted.y.domain), yRight: null });
    model.scene(estimateText);
    const drawn = model.items!.result()!;
    const [x, y] = drawn.moves!.toLayout('[0,"a"]', 250, 180);
    expect(x).toBeCloseTo(drawn.plane!.x.invert(250));
    expect(y).toBeCloseTo(drawn.plane!.y.invert(180));
    model.items!.setItemPosition('[0,"a"]', { x, y });
    model.scene(estimateText);
    expect(at(model, "a")[0]).toBeCloseTo(250);
    expect(at(model, "a")[1]).toBeCloseTo(180);
    // A public move is not clipped to the current view, and comes back when it is reset.
    model.items!.setItemPosition('[0,"a"]', { x: fitted.x.domain[0] + 1, y });
    model.scene(estimateText);
    expect(at(model, "a")[0]).toBeLessThan(0);
    model.setViewport(null);
    model.setYViewport({ y: null, yRight: null });
    model.scene(estimateText);
    expect(model.items!.result()!.moves!.layout).toBe(layout);
    expect(at(model, "a")[0]).toBeCloseTo(fitted.x.map(fitted.x.domain[0] + 1));
  });

  it("selects every row naming a lassoed node, excludes hidden nodes, and dims their links", () => {
    const links = ring();
    const nodes = table({ name: ["a", "b", "c", "d", "a"], team: ["x", "x", "y", "y", "x"] });
    const store = selectionStore(nodes);
    const model = bound(
      {
        marks: [graph(links, { source: "from", target: "to", nodes, node: "name", color: "team" })],
        interaction: { brush: "lasso" },
      },
      selectionStore(links),
      store,
    );
    const plane = model.items!.result()!.plane!;
    const [ax, ay] = at(model, "a");
    const polygon = [
      [ax - 8, ay - 8],
      [ax + 8, ay - 8],
      [ax + 8, ay + 8],
      [ax - 8, ay + 8],
    ] as const;
    const selection = {
      x: null,
      y: null,
      lasso: polygon.map(([x, y]) => [plane.x.invert(x), plane.y.invert(y)] as const),
    };
    const rows = brushedRows(model, nodes as unknown as Table, selection, null)!;
    expect(rows.kind === "rows" && [...rows.rows.positions()]).toEqual([0, 4]);
    expect(brushedRows(model, links as unknown as Table, selection, null)).toBeUndefined();
    store.set("c", selectRows(new RowSet(nodes).addAll([0, 4])));
    const scene = model.scene(estimateText);
    expect(
      marksOf<PointGeometry>(scene, "point", "graph-nodes").map((g) => [g.count, g.fillOpacity]),
    ).toEqual([
      [3, DIM],
      [1, 1],
    ]);
    expect(
      marksOf<SegmentGeometry>(scene, "segments", "graph-links").every(
        (g) => (g.opacity ?? 1) < 0.45,
      ),
    ).toBe(true);
    const all = [
      [0, 0],
      [600, 0],
      [600, 400],
      [0, 400],
    ] as const;
    model.hidden.add(scene.legend[0]!.key);
    model.scene(estimateText);
    expect(model.items!.result()!.lassoed!(all, nodes as unknown as Table)).toEqual([2, 3]);
    expect(
      model.items!.result()!.lassoed!(
        [
          [0, 0],
          [1, 0],
          [1, 1],
        ],
        nodes as unknown as Table,
      ),
    ).toEqual([]);
  });

  it("keeps links crossing the view pickable when both nodes are offscreen", () => {
    const { model } = build({
      marks: [
        graph(table({ from: ["a"], to: ["b"] }), { source: "from", target: "to", labels: false }),
      ],
    });
    const plane = model.items!.result()!.plane!;
    const y = plane.y.invert(200);
    model.items!.setItemPosition('[0,"a"]', { x: plane.x.invert(-1000), y });
    model.items!.setItemPosition('[0,"b"]', { x: plane.x.invert(2000), y });
    model.scene(estimateText);
    expect((model.inspect(300, 200) as ItemInspection).key).toBe('[0,"a","b"]');
    expect(model.inspect(300, -1)).toBeUndefined();
  });

  it("rebuilds picking candidates when groups are hidden or shown", () => {
    const links = table({ from: ["a", "c"], to: ["b", "d"] });
    const nodes = table({ name: ["a", "b", "c", "d"], team: ["x", "x", "y", "y"] });
    const { model, scene } = build({
      marks: [graph(links, { source: "from", target: "to", nodes, node: "name", color: "team" })],
    });
    const a = at(model, "a");
    const link = model.inspectItem('[0,"a","b"]')!.points[0]!;
    expect((model.inspect(...a) as ItemInspection).key).toBe('[0,"a"]');
    expect((model.inspect(link.px, link.py) as ItemInspection).key).toBe('[0,"a","b"]');
    model.hidden.add(scene.legend[0]!.key);
    model.scene(estimateText);
    expect(model.inspect(...a)).toBeUndefined();
    expect(model.inspect(link.px, link.py)).toBeUndefined();
    model.hidden.clear();
    model.scene(estimateText);
    expect((model.inspect(...a) as ItemInspection).key).toBe('[0,"a"]');
  });

  it("fits pending views per axis and handles empty or single-node layouts", () => {
    for (const names of [[], ["a"]]) {
      const { model } = build({
        marks: [
          graph(table({ from: category([]), to: category([]) }), {
            source: "from",
            target: "to",
            nodes: table({ name: category(names) }),
            node: "name",
          }),
        ],
        interaction: { zoom: true },
      });
      const plane = model.items!.result()!.plane!;
      const view = plane.view({ x: half(plane.x.domain), y: null });
      expect(view.zoom).toBeCloseTo(2);
      expect((view.y[0] + view.y[1]) / 2).toBeCloseTo((plane.y.domain[0] + plane.y.domain[1]) / 2);
      model.setViewport(view.x);
      model.setYViewport({ y: view.y, yRight: null });
      expect(() => model.scene(estimateText)).not.toThrow();
    }
  });
});
