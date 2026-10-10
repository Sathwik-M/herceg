// Networks' directed links and link labels, nodes moved by the chart's
// user, and rows of either table selected and highlighted.

import { describe, expect, it } from "vitest";
import { RowSet } from "../../src/data/row-set.ts";
import { type SelectionStore, selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { graph } from "../../src/marks/graph.ts";
import { DIM } from "../../src/marks/mark.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { clickedRows } from "../../src/model/selected-rows.ts";
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
    nodeStore.set("c", selectRows(new RowSet(nodes).add(2)));
    linkStore.set("c", selectRows(new RowSet(links).add(3)));
    const scene = model.scene(estimateText);
    const points = marksOf<PointGeometry>(scene, "point", "graph-nodes");
    expect(points.map(({ key, count, fillOpacity }) => [key, count, fillOpacity])).toEqual([
      ["graph-nodes-dimmed", 3, DIM],
      ["graph-nodes", 1, 1],
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
