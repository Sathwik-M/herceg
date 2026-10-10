import { describe, expect, it } from "vitest";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { geometry } from "../../src/data/geometry.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { type GeoShapeMark, geoshape } from "../../src/marks/geoshape.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { PointGeometry, PolygonGeometry, Scene } from "../../src/scene/scene.ts";
import { LIGHT, surface } from "../../src/theme.ts";

/** A square [lon, lat] ring, closed. */
const ring = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];

/** Four countries in a row, the first with a lake, and one without a shape. */
const countries = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: [
    ["Ada", 10, "North", [ring(0, 0, 10), ring(3, 3, 4)]],
    ["Bel", 40, "South", [ring(10, 0, 10)]],
    ["Cor", null, "North", [ring(20, 0, 10)]],
    ["Dun", 20, "East", [ring(30, 0, 10)]],
  ].map(([name, gdp, region, rings]) => ({
    type: "Feature" as const,
    properties: { name, gdp, region },
    geometry: { type: "Polygon", coordinates: rings as number[][][] },
  })),
});

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const polygons = (scene: Scene) =>
  scene.panels[0]!.marks.find((m) => m.kind === "polygons") as PolygonGeometry;
const points = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is PointGeometry => m.kind === "point");

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

/** The pixel of a longitude and latitude in a scene of an equirectangular map fitted to `box`. */
function pixelOf(scene: Scene, lon: number, lat: number, box: [number, number, number, number]) {
  const plot = scene.panels[0]!.plot;
  const [w, s, e, n] = box;
  const k = Math.min((plot.width - 2) / (e - w), (plot.height - 2) / (n - s));
  return {
    x: plot.x + plot.width / 2 + k * (lon - (w + e) / 2),
    y: plot.y + plot.height / 2 - k * (lat - (s + n) / 2),
  };
}

describe("geoshape", () => {
  it("fills regions on a continuous scale, with a color legend and no-data fill", () => {
    const world = fromGeoJSON(countries());
    const { model, scene } = build({
      projection: "equirectangular",
      marks: [geoshape(world, { name: "name", color: "gdp" })],
    });
    const shapes = polygons(scene);
    expect(shapes.shapes).toHaveLength(4);
    expect(shapes.stroke).toBe(surface(LIGHT));
    // Cor has no value: the theme's grid color, index 0.
    expect(shapes.colorIndex[2]).toBe(0);
    expect(shapes.colors[0]).toBe(LIGHT.grid);
    expect(scene.colorLegends).toHaveLength(1);
    expect(scene.colorLegends[0]!.title.text).toBe("gdp");
    const read = items(model);
    expect(read.map((item) => item.points[0]!.label)).toEqual(["Ada", "Bel", "Cor", "Dun"]);
    expect(read[1]!.label).toBe("gdp");
    expect(read[1]!.points[0]!.text).toBe("40");
    expect(read[2]!.points[0]!.text).toBe("no data");
    expect(read[2]!.value).toBeNaN();
    expect(model.layoutSummary()).toBe(
      "Map of 4 regions colored by gdp, from 10 (Ada) to 40 (Bel). 1 region has no value.",
    );
  });

  it("finds the region under the pointer, but not in its lake", () => {
    const world = fromGeoJSON(countries());
    const { model, scene } = build({
      projection: "equirectangular",
      marks: [geoshape(world, { name: "name", color: "gdp" })],
    });
    const box: [number, number, number, number] = [0, 0, 40, 10];
    const at = (lon: number, lat: number) => {
      const { x, y } = pixelOf(scene, lon, lat, box);
      return model.inspect(x, y) as ItemInspection | undefined;
    };
    expect(at(1, 1)?.points[0]?.label).toBe("Ada");
    expect(at(5, 5)).toBeUndefined();
    expect(at(25, 5)?.points[0]?.label).toBe("Cor");
    expect(at(39, 9)?.points[0]?.label).toBe("Dun");
    expect(at(41, 5)).toBeUndefined();
    // The keyboard's tooltip points inside the region, beside the lake.
    const ada = model.inspectItem(JSON.stringify([0, 0])) as ItemInspection;
    expect((model.inspect(ada.points[0]!.px, ada.points[0]!.py) as ItemInspection).key).toBe(
      ada.key,
    );
  });

  it("colors by category with a legend that grays regions out without moving the map", () => {
    const world = fromGeoJSON(countries());
    const config = {
      projection: "equal-earth" as const,
      marks: [geoshape(world, { color: "region" })],
    };
    const { model, scene } = build(config);
    expect(scene.legend.map((entry) => entry.label)).toEqual(["North", "South", "East"]);
    const before = polygons(scene);
    model.hidden.add(scene.legend[0]!.key);
    const after = polygons(model.scene(estimateText));
    expect(after.colorIndex[0]).toBe(0);
    expect(after.colorIndex[2]).toBe(0);
    expect(after.colorIndex[1]).not.toBe(0);
    // The same shapes, in the same places.
    expect(after.shapes[3]).toBe(before.shapes[3]);
    expect(model.layoutSummary()).toBe(
      "Map of 4 regions colored by region: North 2, South 1, East 1.",
    );
  });

  it("recolors without projecting again when values change", () => {
    const world = fromGeoJSON(countries());
    const { model, scene } = build({ marks: [geoshape(world, { color: "gdp" })] });
    const first = polygons(scene).shapes[0];
    world.replace("gdp", 0, [35]);
    const next = polygons(model.scene(estimateText));
    expect(next.shapes[0]).toBe(first);
    expect(next.colorIndex[0]).not.toBe(polygons(scene).colorIndex[0]);
  });

  it("draws rows by their codes, skipping rows without a shape", () => {
    const world = fromGeoJSON(countries());
    const { set } = world.geometries("geometry");
    const visits = table({
      place: ["Ada again", "nowhere", "Bel"],
      shape: geometry(set, Int32Array.from([0, -1, 1])),
    });
    const { model, scene } = build({ marks: [geoshape(visits, { name: "place" })] });
    expect(polygons(scene).shapes).toHaveLength(2);
    expect(items(model).map((item) => item.points[0]!.label)).toEqual(["Ada again", "Bel"]);
    expect(model.layoutSummary()).toBe("Map of 2 regions.");
  });

  it("refuses fields and options it cannot use", () => {
    const world = fromGeoJSON(countries());
    expect(() => geoshape(table({ a: [1] }))).toThrow(/needs a table with a geometry field/);
    const two = table({
      a: geometry(world.geometries("geometry").set),
      b: geometry(world.geometries("geometry").set),
    });
    expect(() => geoshape(two)).toThrow(/needs `geometry`: the table has "a", "b"/);
    expect((geoshape(two, { geometry: "b" }) as GeoShapeMark).field).toBe("b");
    expect(() => geoshape(world, { name: "gdp" as never })).toThrow(/needs category/);
    expect(() => geoshape(world, { color: "region", colors: ["#000000", "#ffffff"] })).toThrow(
      /for a number color field/,
    );
    expect(() => geoshape(world, { strokeWidth: -1 })).toThrow(/strokeWidth/);
  });
});

describe("geopoint", () => {
  const cities = () =>
    table({
      city: ["Big", "Small", "Far", "North"],
      lon: [10, 10.8, 30, 0],
      lat: [5, 5, 5, 9],
      people: [1000, 10, 500, 5],
      kind: ["capital", "town", "town", "town"],
    });

  it("sizes points by area, draws the largest first, and ranks them in the legend", () => {
    const { scene } = build({
      projection: "equirectangular",
      marks: [geopoint(cities(), { longitude: "lon", latitude: "lat", r: "people", name: "city" })],
    });
    const [layer] = points(scene);
    expect(layer!.count).toBe(4);
    expect(Array.from(layer!.radii!)).toEqual([...layer!.radii!].sort((a, b) => b - a));
    expect(layer!.ring).toEqual({ color: surface(LIGHT), width: 1 });
    expect(layer!.opaque).toBe(false);
    expect(scene.glyphLegends).toHaveLength(1);
    expect(scene.glyphLegends[0]!.title.text).toBe("people");
  });

  it("finds the last-drawn point whose disc holds the pointer", () => {
    const { model, scene } = build({
      projection: "equirectangular",
      marks: [geopoint(cities(), { longitude: "lon", latitude: "lat", r: "people", name: "city" })],
    });
    const [layer] = points(scene);
    const place = (row: number) => {
      const { px, py } = (model.inspectItem(JSON.stringify([0, row])) as ItemInspection).points[0]!;
      return { px, py, r: layer!.radii![Array.from(layer!.coords).indexOf(px) / 2]! };
    };
    const [big, small] = [place(0), place(1)];
    const at = (x: number, y: number) =>
      (model.inspect(x, y) as ItemInspection | undefined)?.points[0]?.label;
    // Small is drawn over Big, whose disc it lies on.
    expect(small.px - big.px).toBeLessThan(big.r);
    expect(at(small.px, small.py)).toBe("Small");
    expect(at(big.px, big.py)).toBe("Big");
    // Nearer Small's center than Big's, but outside Small's disc: Big.
    // Reach: 3 px past the disc and half its 1-pixel ring.
    const x = small.px - small.r - 4;
    expect(small.px - x).toBeLessThan(x - big.px);
    expect(at(x, big.py)).toBe("Big");
    expect(at(big.px, big.py - big.r - 4)).toBeUndefined();
  });

  it("splits points into series whose legend hides them", () => {
    const { model, scene } = build({
      projection: "equirectangular",
      marks: [geopoint(cities(), { longitude: "lon", latitude: "lat", series: "kind" })],
    });
    expect(scene.legend.map((entry) => entry.label)).toEqual(["capital", "town"]);
    model.hidden.add(scene.legend[1]!.key);
    const shown = points(model.scene(estimateText));
    expect(shown.map((p) => p.count)).toEqual([1]);
    expect(items(model)).toHaveLength(1);
  });

  it("draw the largest first across series, and pick the smaller on top", () => {
    const places = table({
      lon: [0, 0, 20],
      lat: [0, 0, 10],
      n: [1, 100, 50],
      kind: ["small", "large", "mid"],
    });
    const { model, scene } = build({
      projection: "equirectangular",
      marks: [
        geopoint(places, {
          longitude: "lon",
          latitude: "lat",
          r: "n",
          series: "kind",
          fillOpacity: 1,
        }),
      ],
    });
    const [layer] = points(scene);
    expect(points(scene)).toHaveLength(1);
    expect(Array.from(layer!.radii!)).toEqual([...layer!.radii!].sort((a, b) => b - a));
    // Each point keeps its series' color.
    const colors = Array.from(layer!.colors!.index, (i) => layer!.colors!.palette[i]);
    expect(new Set(colors).size).toBe(3);
    const small = (model.inspectItem(JSON.stringify([0, 0])) as ItemInspection).points[0]!;
    expect((model.inspect(small.px, small.py) as ItemInspection).points[0]!.label).toBe("Point 1");
  });

  it("draw nothing, without failing, while every color value is missing", () => {
    const places = table({ lon: [0, 10], lat: [0, 5], v: [Number.NaN, Number.NaN] });
    const { model, scene } = build({
      marks: [geopoint(places, { longitude: "lon", latitude: "lat", color: "v" })],
    });
    expect(points(scene)[0]!.count).toBe(0);
    expect(model.layoutSummary()).toBe("Map with no points to show.");
    places.setColumn("v", [1, 2]);
    expect(points(model.scene(estimateText))[0]!.count).toBe(2);
  });

  it("show series in a neutral color when a color field fills the points", () => {
    const places = table({ lon: [0, 10], lat: [0, 5], v: [1, 2], kind: ["a", "b"] });
    const { scene } = build({
      marks: [
        geopoint(places, {
          longitude: "lon",
          latitude: "lat",
          color: "v",
          series: "kind",
          fill: "#ff0000",
        }),
      ],
    });
    expect(scene.legend.map((entry) => entry.color)).toEqual([LIGHT.muted, LIGHT.muted]);
  });

  it("keep their rings inside the plot", () => {
    const places = table({ lon: [0, 10], lat: [0, 0] });
    const { scene } = build({
      projection: "equirectangular",
      marks: [geopoint(places, { longitude: "lon", latitude: "lat", r: 4, strokeWidth: 20 })],
    });
    const [layer] = points(scene);
    const plot = scene.panels[0]!.plot;
    const left = Math.min(layer!.coords[0]!, layer!.coords[2]!);
    expect(left - 4 - 10).toBeGreaterThanOrEqual(plot.x);
  });

  it("leaves out points beyond Mercator's latitudes and points without a position", () => {
    const places = table({ lon: [0, 10, Number.NaN], lat: [0, 88, 10] });
    const { model } = build({
      projection: "mercator",
      marks: [geopoint(places, { longitude: "lon", latitude: "lat" })],
    });
    expect(items(model)).toHaveLength(1);
    expect(items(model)[0]!.points[0]!.text).toBe("0° N, 0° E");
    expect(model.layoutSummary()).toBe("1 point on the map.");
  });
});

describe("maps", () => {
  it("draw regions and points on one projection, read layer by layer", () => {
    const world = fromGeoJSON(countries());
    const places = table({ name: ["Port"], lon: [15], lat: [5], size: [3] });
    const { model, scene } = build({
      projection: "equirectangular",
      marks: [
        geoshape(world, { name: "name", color: "gdp" }),
        geopoint(places, { longitude: "lon", latitude: "lat", r: "size", name: "name" }),
      ],
    });
    expect(scene.panels[0]!.marks.map((m) => m.kind)).toEqual(["polygons", "point"]);
    const read = items(model);
    expect(read.map((item) => item.points[0]!.label)).toEqual(["Ada", "Bel", "Cor", "Dun", "Port"]);
    expect(read[4]!.label).toBe("size");
    // The point is above the region it lies in.
    const port = read[4]!.points[0]!;
    expect((model.inspect(port.px, port.py) as ItemInspection).key).toBe(read[4]!.key);
    expect(describeChart(model)).toBe(
      "Map of 4 regions colored by gdp, from 10 (Ada) to 40 (Bel). 1 region has no value. 1 point on the map sized by size; largest Port (3). Color shows gdp from 10 to 40. Size shows size: 3.",
    );
  });

  it("fit the data, the world, or a box", () => {
    const world = fromGeoJSON(countries());
    let plot = { width: 0, height: 0 };
    const width = (fit: "data" | "world" | [[number, number], [number, number]]) => {
      const { scene } = build({
        projection: { type: "equirectangular", fit },
        marks: [geoshape(world)],
      });
      plot = scene.panels[0]!.plot;
      const box = polygons(scene).shapes.reduce(
        (acc, shape) => {
          for (let i = 0; i < shape.coords.length; i += 2) {
            acc[0] = Math.min(acc[0]!, shape.coords[i]!);
            acc[1] = Math.max(acc[1]!, shape.coords[i]!);
          }
          return acc;
        },
        [Infinity, -Infinity],
      );
      return box[1]! - box[0]!;
    };
    // The plot less an inset of a pixel and half a border on each side.
    const room = () => ({ width: plot.width - 2.75, height: plot.height - 2.75 });
    expect(width("data")).toBeCloseTo(room().width, 3);
    // 40 of the world's 360 degrees, as wide as the plot allows.
    const world40 = width("world");
    expect(world40).toBeCloseTo(40 * Math.min(room().width / 360, room().height / 180), 3);
    const boxed = width([
      [0, -10],
      [80, 10],
    ]);
    expect(boxed).toBeCloseTo(40 * Math.min(room().width / 80, room().height / 20), 3);
  });

  it("show the world when there is nothing to fit, and a little around a single point", () => {
    const empty = table({ lon: [] as number[], lat: [] as number[] });
    const { model } = build({ marks: [geopoint(empty, { longitude: "lon", latitude: "lat" })] });
    expect(model.layoutSummary()).toBe("Map with no points to show.");
    const one = table({ lon: [5], lat: [5] });
    const { scene } = build({ marks: [geopoint(one, { longitude: "lon", latitude: "lat" })] });
    const [layer] = points(scene);
    expect(layer!.count).toBe(1);
    expect(layer!.coords[0]).toBeCloseTo(300, 0);
  });

  it("share a chart only with other layers of maps", () => {
    const world = fromGeoJSON(countries());
    const data = table({ x: [1, 2], y: [3, 4], c: ["a", "b"] });
    expect(() => build({ marks: [geoshape(world), line(data, { x: "x", y: "y" })] })).toThrow(
      /chart to itself/,
    );
    expect(() => build({ marks: [geoshape(world), pie(data, { category: "c" })] })).toThrow(
      /shares its chart only with geoshape and geopoint marks, not a pie/,
    );
    expect(() => build({ marks: [pie(data, { category: "c" }), geoshape(world)] })).toThrow(
      /pie mark has its chart to itself/,
    );
    expect(() =>
      build({ marks: [geoshape(world, { id: "a" }), geoshape(world, { id: "a" })] }),
    ).toThrow(/Duplicate mark id "a"/);
    // Maps zoom both ways, and sync nothing.
    expect(() => build({ marks: [geoshape(world)], interaction: { zoom: "y" } })).toThrow(/zoom/);
    expect(() => build({ marks: [geoshape(world)], interaction: { sync: "a" } })).toThrow(/sync/);
  });

  it("render as static SVG with even-odd regions", () => {
    const world = fromGeoJSON(countries());
    const svg = renderToSVG({
      width: 400,
      height: 200,
      title: "Map",
      marks: [geoshape(world, { name: "name", color: "gdp" })],
    });
    expect(svg.match(/fill-rule="evenodd"/g)).toHaveLength(4);
  });

  it("can be drawn by two charts of different sizes", () => {
    const world = fromGeoJSON(countries());
    const mark = geoshape(world, { color: "gdp" });
    const small = build({ marks: [mark] }, 300, 150);
    const large = build({ marks: [mark] }, 900, 450);
    const width = (scene: Scene) => {
      const xs = polygons(scene).shapes.flatMap((shape) =>
        Array.from(shape.coords.filter((_, i) => i % 2 === 0)),
      );
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(width(large.scene)).toBeGreaterThan(2.5 * width(small.scene));
    expect(width(small.model.scene(estimateText))).toBeCloseTo(width(small.scene), 6);
  });
});
