import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { ArcGeometry, RectGeometry, Scene, TextGeometry } from "../../src/scene/scene.ts";
import { legendOf } from "../helpers/guides.ts";

const sales = table({
  region: ["Europe", "Europe", "Asia", "Asia", "Asia"],
  country: ["France", "Spain", "Japan", "India", "Korea"],
  revenue: [30, 10, 40, 15, 5],
});

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const marks = <K extends string>(scene: Scene, kind: K) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind);

describe("treemap", () => {
  const chart = () =>
    build({ marks: [treemap(sales, { path: ["region", "country"], value: "revenue" })] });

  it("gives leaves areas in proportion to their values, in their branch's color", () => {
    const { scene } = chart();
    expect(legendOf(scene).map((entry) => entry.label)).toEqual(["Asia", "Europe"]);
    const leaves = (marks(scene, "rect") as RectGeometry[]).filter((m) => m.fillOpacity === 1);
    expect(leaves.map((m) => m.count)).toEqual([3, 2]);
    expect(leaves[0]!.fill).toBe(legendOf(scene)[0]!.color);
    const areas = leaves.flatMap((m) =>
      Array.from({ length: m.count }, (_, i) => m.rects[i * 4 + 2]! * m.rects[i * 4 + 3]!),
    );
    // Japan 40 and Korea 5: areas about 8 to 1, less the gaps between rectangles.
    expect(areas[0]! / areas[2]!).toBeGreaterThan(6);
    expect(areas[0]! / areas[2]!).toBeLessThan(10);
    const labels = (marks(scene, "text") as TextGeometry[]).flatMap((m) => m.labels);
    expect(labels).toEqual(expect.arrayContaining(["Asia", "Europe", "Japan", "France"]));
  });

  it("finds the deepest node under a point, and steps through nodes depth first", () => {
    const { scene, model } = chart();
    const japan = (marks(scene, "rect") as RectGeometry[]).find((m) => m.fillOpacity === 1)!;
    const [x, y, w, h] = Array.from(japan.rects.subarray(0, 4));
    const hit = model.inspect(x! + w! / 2, y! + h! / 2) as ItemInspection;
    expect([hit.axis, hit.points[0]!.label, hit.value]).toEqual(["item", "Asia / Japan", 40]);
    expect(hit.points[0]!.text).toBe("40 (40%)");
    const keys: string[] = [];
    let key = model.stepItem(undefined, 1);
    while (key && !keys.includes(key)) {
      keys.push(key);
      key = model.stepItem(key, 1);
    }
    expect(keys.map((k) => JSON.parse(k).slice(1).join("/"))).toEqual([
      "Asia",
      "Asia/Japan",
      "Asia/India",
      "Asia/Korea",
      "Europe",
      "Europe/France",
      "Europe/Spain",
    ]);
  });

  it("gives the room of hidden branches to the others", () => {
    const { model } = chart();
    model.hidden.add(legendOf(model.scene(estimateText))[0]!.key);
    const scene = model.scene(estimateText);
    const leaves = (marks(scene, "rect") as RectGeometry[]).filter((m) => m.fillOpacity === 1);
    expect(leaves.map((m) => m.count)).toEqual([2]);
    expect(model.layoutSummary()).toBe(
      "Treemap of revenue by region / country: 2 leaves in 1 group totaling 40. Largest: Europe 100%.",
    );
  });

  it("builds trees from node and parent fields, and refuses bad ones", () => {
    const org = table({ node: ["root", "a", "b"], up: [null, "root", "root"], cost: [0, 2, 3] });
    const { model } = build({
      marks: [treemap(org, { node: "node", parent: "up", value: "cost" })],
    });
    expect(model.layoutSummary()).toBe(
      "Treemap of cost by node: 2 leaves in 1 group totaling 5. Largest: root 100%.",
    );
    const loop = table({ node: ["a", "b"], up: ["b", "a"] });
    expect(() => build({ marks: [treemap(loop, { node: "node", parent: "up" })] })).toThrow(
      "its own ancestor",
    );
    expect(() => treemap(sales, { path: [] })).toThrow("at least one field");
  });
});

describe("tree navigation", () => {
  it("visits only nodes that are drawn, and copes with deep and wide trees", () => {
    // In a 40 x 40 chart, header strips leave the children no room.
    const { model } = build(
      { marks: [treemap(sales, { path: ["region", "country"] })], legend: false },
      40,
      40,
    );
    const visited: string[] = [];
    for (
      let key = model.stepItem(undefined, 1);
      key && !visited.includes(key);
      key = model.stepItem(key, 1)
    )
      visited.push(key);
    for (const key of visited) expect(model.inspectItem(key)?.axis).toBe("item");
    expect(visited.length).toBeLessThan(7);
    // A long chain and a wide fan-out read without overflowing the stack.
    const n = 20_000;
    const ids = Array.from({ length: n }, (_, i) => `n${i}`);
    const chain = table({ id: ids, up: [null, ...ids.slice(0, -1)] });
    const deep = build({ marks: [treemap(chain, { node: "id", parent: "up" })] }).model;
    expect(() => deep.stepItem(undefined, Number.POSITIVE_INFINITY)).not.toThrow();
    const wide = table({ g: Array.from({ length: n }, () => "all"), leaf: ids });
    const fan = build({ marks: [treemap(wide, { path: ["g", "leaf"] })] }).model;
    expect(() => fan.stepItem(undefined, Number.POSITIVE_INFINITY)).not.toThrow();
  });
});

describe("sunburst", () => {
  const chart = () =>
    build({ marks: [sunburst(sales, { path: ["region", "country"], value: "revenue" })] });

  it("draws a ring per depth, each node's angle its share", () => {
    const { scene } = chart();
    const [inner, outer] = marks(scene, "arc") as ArcGeometry[];
    expect([inner!.count, outer!.count]).toEqual([2, 5]);
    // Asia, 60 of 100, starts at the top and goes 60% of the way round.
    const sectors = [0, 1].map((i) => Array.from(inner!.arcs.subarray(i * 6, i * 6 + 6)));
    const asia = sectors.find(([, , , , a0]) => Math.abs(a0! + Math.PI / 2) < 1e-5)!;
    const [, , r0, r1, a0, a1] = asia;
    expect(a1! - a0!).toBeCloseTo(0.6 * 2 * Math.PI, 5);
    expect(outer!.arcs[2]!).toBeGreaterThan(r1!);
    expect(r0).toBeGreaterThan(0);
    expect(outer!.fillOpacity).toBeLessThan(inner!.fillOpacity);
  });

  it("finds the node under a point by ring and angle", () => {
    const { scene, model } = chart();
    const [inner, outer] = marks(scene, "arc") as ArcGeometry[];
    const [cx, cy, r0, r1] = Array.from(inner!.arcs.subarray(0, 4)) as number[];
    const at = (radius: number, angle: number) =>
      model.inspect(cx! + radius * Math.cos(angle), cy! + radius * Math.sin(angle)) as
        | ItemInspection
        | undefined;
    const top = -Math.PI / 2 + 0.05;
    expect(at((r0! + r1!) / 2, top)!.points[0]!.label).toBe("Asia");
    expect(at((outer!.arcs[2]! + outer!.arcs[3]!) / 2, top)!.points[0]!.label).toBe("Asia / Japan");
    expect(at(r0! / 2, top)).toBeUndefined();
    // Between the rings, nothing is drawn and nothing is found.
    expect(at(r1! + 0.5, top)).toBeUndefined();
    expect(
      renderToSVG({ width: 400, height: 300, marks: [sunburst(sales, { path: ["region"] })] }),
    ).toMatch(/A[\d.]+ [\d.]+ 0 0 1/);
  });

  it("keeps labels inside their sectors, shortening or leaving out the rest", () => {
    const long = table({ g: ["A rather long region name", "b"], v: [3, 1] });
    const { scene } = build({ marks: [sunburst(long, { path: ["g"] })] }, 260, 220);
    const labels = (
      scene.panels[0]!.marks.filter((m) => m.kind === "text") as TextGeometry[]
    ).flatMap((m) => m.labels);
    for (const label of labels) expect(estimateText(label, "12px sans-serif")).toBeLessThan(200);
    expect(labels).not.toContain("A rather long region name");
  });

  it("labels short names that fit, and keeps keys to their own mark", () => {
    const short = table({ g: ["A", "B"], v: [1, 1] });
    const { scene, model } = build(
      { marks: [sunburst(short, { path: ["g"], id: "rings" })] },
      400,
      400,
    );
    const labels = (
      scene.panels[0]!.marks.filter((m) => m.kind === "text") as TextGeometry[]
    ).flatMap((m) => m.labels);
    expect(labels.sort()).toEqual(["A", "B"]);
    expect(model.inspectItem('["rings","A"]')).toBeDefined();
    expect(model.inspectItem('["other","A"]')).toBeUndefined();
  });
});
