import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { GraphMark, graph, MAX_LINKS, MAX_NODES } from "../../src/marks/graph.ts";
import { tablesOf } from "../../src/marks/layout-mark.ts";
import { line } from "../../src/marks/line.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { PathShape, Scene, ShapesGeometry, TextGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { DARK, LIGHT, surface } from "../../src/theme.ts";

// Two teams joined through Ana. Bo and Ana talk both ways (one link of 5).
// Left out: a link from Ana to herself, a row without a target, and, when
// messages are the value, a row of zero.
const links = () =>
  table({
    from: ["Ana", "Bo", "Ana", "Cy", "Dee", "Eve", "Dee", "Ana", "Ana", "Bo", "Cy"],
    to: [
      "Bo",
      "Ana",
      "Cy",
      "Bo",
      "Eve",
      "Fay",
      "Fay",
      "Dee",
      "Ana",
      "Cy",
      null as unknown as string,
    ],
    messages: [3, 2, 4, 1, 6, 2, 1, 1, 9, 0, 5],
  });
const people = () =>
  table({
    name: ["Ana", "Bo", "Cy", "Dee", "Eve", "Fay", "Gus"],
    team: ["Data", "Data", "Data", "Sales", "Sales", "Sales", "Sales"],
    followers: [900, 100, 400, 50, 300, 200, 10],
  });

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const teams = (options: { value?: "messages"; size?: "followers" } = {}) =>
  graph(links(), {
    source: "from",
    target: "to",
    nodes: people(),
    node: "name",
    group: "team",
    ...options,
  });

const shapes = (scene: Scene, key: string) =>
  (scene.panels[0]!.marks.find((m) => m.key === key) as ShapesGeometry).shapes as PathShape[];
const labels = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is TextGeometry => m.kind === "text");
/** A circle's center and radius, from the path data `circle` writes. */
const circleOf = ({ d }: PathShape) => {
  const [x, y, r] = d.match(/-?[\d.]+/g)!.map(Number);
  return { x: x! + r!, y: y!, r: r! };
};

/** Every item, in keyboard order. */
function items(model: ChartModel): ItemInspection[] {
  const out: ItemInspection[] = [];
  let key = model.stepItem(undefined, 1);
  while (key !== undefined && !out.some((item) => item.key === key)) {
    out.push(model.inspectItem(key) as ItemInspection);
    key = model.stepItem(key, 1);
  }
  return out;
}
const read = (model: ChartModel) =>
  items(model).map(({ points: [item] }) => `${item!.label}: ${item!.text}`);

describe("graph", () => {
  it("draws a circle per node in its group's color, ringed, over a path per kind of link", () => {
    const { scene, model } = build({ marks: [teams()] });
    expect(scene.legend.map(({ label }) => label)).toEqual(["Data", "Sales"]);
    const [data, sales] = scene.legend.map(({ color }) => color);
    const nodes = shapes(scene, "graph-nodes");
    // Gus has no links but is in the nodes table, so it is drawn.
    expect(nodes).toHaveLength(7);
    expect(new Set(nodes.map(({ fill }) => fill))).toEqual(new Set([data, sales]));
    for (const node of nodes) {
      expect(node.stroke).toBe(surface(LIGHT));
      expect(node.d).toMatch(/^M[\d.]+ [\d.]+a([\d.]+) \1 0 1 0 [\d.]+ 0a\1 \1 0 1 0 -[\d.]+ 0Z$/);
    }
    // Links within a team take its color; Ana — Dee, between teams, is muted.
    const paths = shapes(scene, "graph-links");
    expect(paths.map(({ stroke }) => stroke)).toEqual([LIGHT.muted, data, sales]);
    expect(paths.map(({ d }) => d.split("M").length - 1)).toEqual([1, 3, 3]);
    for (const path of paths) {
      expect(path.fill).toBe("none");
      expect(path.opacity).toBe(0.45);
    }
    expect(model.inspectItem(JSON.stringify([0, "Ana", "Dee"]))!.points[0]!.color).toBe(
      LIGHT.muted,
    );
  });

  it("reads nodes in the nodes table's order, then links in the order rows name them", () => {
    const { model } = build({ marks: [teams()] });
    expect(read(model)).toEqual([
      "Ana: 3 links (team Data)",
      "Bo: 2 links (team Data)",
      "Cy: 2 links (team Data)",
      "Dee: 3 links (team Sales)",
      "Eve: 2 links (team Sales)",
      "Fay: 2 links (team Sales)",
      "Gus: 0 links (team Sales)",
      // Rows each way between Ana and Bo count as one link.
      "Ana — Bo: 2",
      "Ana — Cy: 1",
      // Without a value, rows count, so Bo — Cy's zero counts too.
      "Cy — Bo: 2",
      "Dee — Eve: 1",
      "Eve — Fay: 1",
      "Dee — Fay: 1",
      "Ana — Dee: 1",
    ]);
    const [first] = items(model);
    expect([first!.axis, first!.label, first!.value]).toEqual(["item", "Links", 3]);
    // Links are found by their names either way round.
    expect((model.inspectItem(JSON.stringify([0, "Bo", "Ana"])) as ItemInspection).key).toBe(
      JSON.stringify([0, "Ana", "Bo"]),
    );
    expect(model.inspectItem(JSON.stringify([0, "Bo", "Dee"]))).toBeUndefined();
    expect(model.inspectItem("not json")).toBeUndefined();
    expect(model.layoutSummary()).toBe(
      "Network of 7 nodes and 7 links in 2 groups; most connected: Ana (3 links). 1 link from a node to itself is not drawn.",
    );
  });

  it("sums values per pair into links' widths, and reports values and sizes", () => {
    const { model, scene } = build({ marks: [teams({ value: "messages", size: "followers" })] });
    expect(read(model).slice(0, 2)).toEqual([
      "Ana: 3 links, messages 10 (team Data, followers 900)",
      "Bo: 2 links, messages 6 (team Data, followers 100)",
    ]);
    expect(read(model)).toContain("Ana — Bo: 5");
    // Widths run from 1 px toward 6 px at the heaviest link (Dee — Eve, 6).
    const widths = shapes(scene, "graph-links").map(({ strokeWidth }) => strokeWidth);
    expect(Math.max(...widths)).toBe(6);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(1);
    // Sizes by area: Ana's circle is the largest, Gus' the smallest.
    const radius = (name: string) => {
      const { points } = model.inspectItem(JSON.stringify([0, name]))!;
      const hit = shapes(scene, "graph-nodes")
        .map(circleOf)
        .find(({ x, y }) => Math.hypot(x - points[0]!.px, y - points[0]!.py) < 0.2)!;
      return hit.r;
    };
    expect(radius("Ana")).toBe(14);
    expect(radius("Gus")).toBe(3.3);
    expect(model.layoutSummary()).toBe(
      "Network of 7 nodes and 7 links in 2 groups; most connected: Ana (3 links). Strongest link: Dee — Eve, messages 6. 1 link from a node to itself is not drawn.",
    );
  });

  it("treats infinite sizes as missing, and says when a node's total is too large", () => {
    const huge = table({ from: ["a", "a"], to: ["b", "c"], v: [1e308, 1e308] });
    const sizes = table({ id: ["a", "b", "c"], size: [1, Number.POSITIVE_INFINITY, Number.NaN] });
    const { model, scene } = build({
      marks: [
        graph(huge, {
          source: "from",
          target: "to",
          value: "v",
          nodes: sizes,
          node: "id",
          size: "size",
        }),
      ],
    });
    // Each link's total is finite; a's sum of them is not.
    const [a, b, c] = read(model);
    expect(a).toBe("a: 2 links, v too large to total (size 1)");
    expect(Number.isNaN(model.inspectItem(JSON.stringify([0, "a"]))!.points[0]!.value)).toBe(true);
    // Only a's size is a size: it is drawn largest, b and c smallest, without sizes in their tooltips.
    const radii = shapes(scene, "graph-nodes").map((shape) => circleOf(shape).r);
    expect(radii).toEqual([14, 3, 3]);
    expect([b, c].some((text) => text!.includes("size"))).toBe(false);
  });

  it("keeps nodes apart and inside the room", () => {
    const { scene } = build({ marks: [teams({ size: "followers" })] }, 300, 200);
    const circles = shapes(scene, "graph-nodes").map(circleOf);
    const { plot } = scene.panels[0]!;
    for (const [i, a] of circles.entries()) {
      expect(a.x - a.r).toBeGreaterThanOrEqual(plot.x);
      expect(a.x + a.r).toBeLessThanOrEqual(plot.x + plot.width);
      expect(a.y - a.r).toBeGreaterThanOrEqual(plot.y);
      expect(a.y + a.r).toBeLessThanOrEqual(plot.y + plot.height);
      for (const b of circles.slice(i + 1))
        expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(a.r + b.r);
    }
  });

  it("hides a group's nodes and their links from the legend, leaving the rest in place", () => {
    const { model, scene } = build({ marks: [teams()] });
    const before = model.inspectItem(JSON.stringify([0, "Ana"]))!.points[0]!;
    model.hidden.add(scene.legend[1]!.key);
    const hidden = model.scene(estimateText);
    expect(shapes(hidden, "graph-nodes")).toHaveLength(3);
    expect(shapes(hidden, "graph-links").map(({ d }) => d.split("M").length - 1)).toEqual([3]);
    const after = model.inspectItem(JSON.stringify([0, "Ana"]))!.points[0]!;
    expect([after.px, after.py]).toEqual([before.px, before.py]);
    expect(model.inspectItem(JSON.stringify([0, "Dee"]))).toBeUndefined();
    expect(read(model)).toHaveLength(6);
    // Counts and the most connected node follow what is drawn: Ana's link to Dee is hidden.
    expect(model.layoutSummary()).toBe(
      "Network of 3 nodes and 3 links in 1 group; most connected: Ana (2 links). 1 link from a node to itself is not drawn.",
    );
    expect(read(model)[0]).toBe("Ana: 2 links (team Data)");
  });

  it("finds the node under the pointer, else the nearest link, else nothing", () => {
    const { model } = build({ marks: [teams()] });
    const at = (x: number, y: number) => model.inspect(x, y) as ItemInspection | undefined;
    const ana = model.inspectItem(JSON.stringify([0, "Ana"])) as ItemInspection;
    const { px, py } = ana.points[0]!;
    expect(at(px, py)?.key).toBe(ana.key);
    // Reach extends 4 px past the edge of a 5 px node.
    expect(at(px + 8.5, py)?.key).toBe(ana.key);
    expect(ana.outline).toMatch(/^M[\d.]+ [\d.]+a/);
    const link = model.inspectItem(JSON.stringify([0, "Eve", "Fay"])) as ItemInspection;
    expect(at(link.points[0]!.px, link.points[0]!.py)?.key).toBe(link.key);
    expect(link.outline).toMatch(/^M[\d. ]+L[\d. ]+L[\d. ]+L[\d. ]+Z$/);
    expect(at(1, 399)).toBeUndefined();
  });

  it("labels nodes beside them, without overlapping labels or other nodes", () => {
    const { scene } = build({ marks: [teams()] });
    const placed = labels(scene);
    expect(placed.every(({ halo }) => halo)).toBe(true);
    const names = placed.flatMap(({ labels }) => labels);
    expect(names.length).toBeGreaterThan(4);
    expect(names).toContain("Ana");
    const circles = shapes(scene, "graph-nodes").map(circleOf);
    const boxes = placed.flatMap((mark) =>
      mark.labels.map((text, i) => {
        const x = mark.coords[i * 2]!;
        const y = mark.coords[i * 2 + 1]!;
        const width = estimateText(text, "12px sans-serif");
        const left = mark.anchor === "start" ? x : x - width;
        return { left, right: left + width, top: y - 7.5, bottom: y + 7.5, y };
      }),
    );
    for (const [i, box] of boxes.entries()) {
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(600);
      for (const other of boxes.slice(i + 1))
        expect(
          box.left < other.right &&
            box.right > other.left &&
            box.top < other.bottom &&
            box.bottom > other.top,
        ).toBe(false);
      // No node, its own included, lies under a label.
      const covered = circles.filter(
        ({ x, y, r }) =>
          box.left < x + r && box.right > x - r && box.top < y + r && box.bottom > y - r,
      );
      expect(covered).toHaveLength(0);
    }
    const bare = graph(links(), { source: "from", target: "to", labels: false });
    expect(labels(build({ marks: [bare] }).scene)).toEqual([]);
  });

  it("labels fewer of the most connected nodes as networks grow", () => {
    // A star of 199 leaves around a hub, in a large room: only the hub and a few leaves.
    const star = table({
      from: Array.from({ length: 199 }, () => "hub"),
      to: Array.from({ length: 199 }, (_, i) => `leaf ${i}`),
    });
    const { scene } = build({ marks: [graph(star, { source: "from", target: "to" })] }, 2000, 2000);
    const names = labels(scene).flatMap(({ labels }) => labels);
    expect(names).toContain("hub");
    expect(names.length).toBeLessThanOrEqual(25);
  });

  it("draws one color without groups, and muted nodes outside the nodes table", () => {
    const plain = build({ marks: [graph(links(), { source: "from", target: "to" })] });
    expect(plain.scene.legend).toEqual([]);
    const fills = new Set(shapes(plain.scene, "graph-nodes").map(({ fill }) => fill));
    expect(fills).toEqual(new Set([LIGHT.palette[0]]));
    expect(shapes(plain.scene, "graph-links").map(({ stroke }) => stroke)).toEqual([LIGHT.muted]);
    expect(plain.model.layoutSummary()).toMatch(/^Network of 6 nodes and 7 links; most connected/);
    // Fay is missing from the nodes table; a later row moves Bo to Sales; a row without a name is left out.
    const partial = table({
      name: ["Ana", "Bo", "Cy", "Dee", "Eve", null as unknown as string, "Bo"],
      team: ["Data", "Data", "Data", "Sales", "Sales", "Data", "Sales"],
    });
    const { model, scene } = build({
      marks: [
        graph(links(), {
          source: "from",
          target: "to",
          nodes: partial,
          node: "name",
          group: "team",
        }),
      ],
    });
    expect(read(model).slice(0, 6)).toEqual([
      "Ana: 3 links (team Data)",
      "Bo: 2 links (team Sales)",
      "Cy: 2 links (team Data)",
      "Dee: 3 links (team Sales)",
      "Eve: 2 links (team Sales)",
      "Fay: 2 links",
    ]);
    expect(model.inspectItem(JSON.stringify([0, "Fay"]))!.points[0]!.color).toBe(LIGHT.muted);
    expect(scene.legend.map(({ label }) => label)).toEqual(["Data", "Sales"]);
  });

  it("follows both tables as they change", () => {
    const edges = table({ from: ["a"], to: ["b"] });
    const nodes = table({ id: ["a", "b"], kind: ["x", "y"] });
    const mark = graph(edges, { source: "from", target: "to", nodes, node: "id", group: "kind" });
    expect(tablesOf(mark)).toEqual([edges, nodes]);
    const { model } = build({ marks: [mark] });
    expect(model.layoutSummary()).toMatch(/^Network of 2 nodes and 1 link in 2 groups;/);
    edges.append({ from: ["b"], to: ["c"] });
    nodes.append({ id: ["d"], kind: ["z"] });
    model.scene(estimateText);
    expect(model.layoutSummary()).toBe(
      "Network of 4 nodes and 2 links in 3 groups; most connected: b (2 links).",
    );
  });

  it("is deterministic, and rings nodes in the surface color", () => {
    // SVG ids aside, which count charts.
    const svg = (config: ChartConfig) =>
      renderToSVG({ width: 500, height: 300, ...config }).replace(/herceg-svg-\d+/g, "id");
    expect(svg({ marks: [teams()] })).toBe(svg({ marks: [teams()] }));
    expect(svg({ theme: "dark", marks: [teams()] })).toContain(`stroke="${surface(DARK)}"`);
  });

  it("says when there is nothing to show, and refuses networks too large to lay out", () => {
    const empty = table({ from: category([]), to: category([]) });
    const blank = build({ marks: [graph(empty, { source: "from", target: "to" })] });
    expect(shapes(blank.scene, "graph-nodes")).toEqual([]);
    expect(blank.model.inspect(300, 200)).toBeUndefined();
    expect(blank.model.stepItem(undefined, 1)).toBeUndefined();
    expect(describeChart(blank.model)).toBe("Network with nothing to show.");

    const many = (n: number) =>
      table({
        from: Array.from({ length: n }, (_, i) => `a${i}`),
        to: Array.from({ length: n }, (_, i) => `b${i}`),
      });
    const limits = `(a network draws at most ${MAX_NODES} nodes and ${MAX_LINKS} links)`;
    expect(() => graph(many(MAX_NODES / 2 + 1), { source: "from", target: "to" })).toThrow(
      `Network of ${MAX_NODES + 2} nodes and ${MAX_NODES / 2 + 1} links: too many to lay out ${limits}`,
    );
    // A dense network of few nodes is refused too: its springs would take seconds.
    const clique = { from: [] as string[], to: [] as string[] };
    for (let i = 0; i < 201; i++)
      for (let j = i + 1; j < 201; j++) {
        clique.from.push(`n${i}`);
        clique.to.push(`n${j}`);
      }
    expect(() => graph(table(clique), { source: "from", target: "to" })).toThrow(
      `Network of 201 nodes and 20100 links: too many to lay out ${limits}`,
    );
    // Rows streamed in later draw nothing, and say why.
    const grows = many(1);
    const { model } = build({ marks: [graph(grows, { source: "from", target: "to" })] });
    grows.append({
      from: Array.from({ length: MAX_NODES / 2 }, (_, i) => `c${i}`),
      to: Array.from({ length: MAX_NODES / 2 }, (_, i) => `d${i}`),
    });
    const scene = model.scene(estimateText);
    expect(scene.panels[0]!.marks).toEqual([]);
    expect(scene.legend).toEqual([]);
    expect(model.layoutSummary()).toBe(
      `Network of ${MAX_NODES + 2} nodes and ${MAX_NODES / 2 + 1} links: too many to lay out ${limits}.`,
    );
    // So do specs, such as a live chart's snapshot after rows streamed in,
    // which later changes can bring back.
    const names = Array.from({ length: MAX_NODES + 1 }, (_, i) => `n${i}`);
    const { config, tables } = loadSpec(
      {
        data: {
          talks: {
            columns: {
              from: { type: "category", codes: [0], dictionary: ["n0"] },
              to: { type: "category", codes: [0], dictionary: ["n1"] },
            },
          },
          people: {
            columns: { id: { type: "category", codes: names.map((_, i) => i), dictionary: names } },
          },
        },
        marks: [
          {
            type: "graph",
            data: "talks",
            source: "from",
            target: "to",
            nodes: "people",
            node: "id",
          },
        ],
      },
      [],
    );
    const loaded = build(config);
    expect(loaded.model.layoutSummary()).toMatch(/^Network of 5,?001 nodes and 1 link: too many/);
    tables.get("people")!.reset({ id: category(["n0", "n1", "n2"]) });
    loaded.model.scene(estimateText);
    expect(loaded.model.layoutSummary()).toMatch(/^Network of 3 nodes and 1 link;/);
  });

  it("refuses other marks, axis interaction, and fields of the wrong kind or table", () => {
    const network = graph(links(), { source: "from", target: "to" });
    const series = table({ t: [1, 2], v: [1, 2] });
    expect(() => build({ marks: [network, line(series, { x: "t", y: "v" })] })).toThrow(
      "has its chart to itself",
    );
    expect(() => build({ marks: [network], interaction: { zoom: true } })).toThrow("no x axis");
    expect(() => graph(links(), { source: "from", target: "messages" as never })).toThrow(
      "graph target needs category",
    );
    expect(() =>
      graph(links(), {
        source: "from",
        target: "to",
        nodes: people(),
        node: "name",
        size: "team" as never,
      }),
    ).toThrow("graph size needs number");
    // Marks take tables of any schema; specs from other languages reach them unchecked.
    const [edges, nodes] = [links(), people()] as unknown as [Table, Table];
    expect(
      () => new GraphMark({ type: "graph", source: "from", target: "to", group: "team" }, edges),
    ).toThrow("fields of a nodes table");
    expect(
      () => new GraphMark({ type: "graph", source: "from", target: "to" }, edges, nodes),
    ).toThrow("graph nodes need `node`");
  });

  it("loads from specs with a nodes table, and renders to SVG", () => {
    const spec: ChartSpec = {
      version: 2,
      width: 500,
      height: 300,
      title: "Team",
      data: {
        talks: {
          columns: {
            from: { type: "category", codes: [0, 0, 1], dictionary: ["Ana", "Bo"] },
            to: { type: "category", codes: [0, 1, 1], dictionary: ["Bo", "Cy"] },
            n: [5, 2, 4],
          },
        },
        people: {
          columns: {
            name: { type: "category", codes: [0, 1, 2], dictionary: ["Ana", "Bo", "Cy"] },
            team: { type: "category", codes: [0, 0, 1], dictionary: ["Data", "Sales"] },
          },
        },
      },
      marks: [
        {
          type: "graph",
          data: "talks",
          source: "from",
          target: "to",
          value: "n",
          nodes: "people",
          node: "name",
          group: "team",
        },
      ],
    };
    const { config, tables } = loadSpec(spec, []);
    expect(tablesOf(config.marks[0]!)).toEqual([tables.get("talks"), tables.get("people")]);
    const svg = renderToSVG({ ...config, width: 500, height: 300 });
    expect(svg.match(/<path d="M[\d.]+ [\d.]+a/g)).toHaveLength(3);
    expect(svg).toContain(">Ana</text>");
    expect(svg).toContain('stroke-opacity="0.45"');
    // Specs from outside TypeScript, which the type checker cannot help.
    const bad = (mark: Record<string, unknown>) => () =>
      loadSpec(
        {
          ...spec,
          marks: [{ type: "graph", data: "talks", source: "from", ...mark }],
        } as ChartSpec,
        [],
      );
    expect(bad({})).toThrow("marks[0].target: required");
    expect(bad({ target: "to", nodes: 3 })).toThrow("marks[0].nodes: expected a string");
    expect(bad({ target: "to", nodes: "staff", node: "name" })).toThrow('no table named "staff"');
    expect(bad({ target: "to", nodes: "people" })).toThrow("graph nodes need `node`");
    expect(bad({ target: "to", group: "team" })).toThrow("fields of a nodes table");
    expect(bad({ target: "to", labels: "yes" })).toThrow("marks[0].labels: expected true or false");
  });
});
