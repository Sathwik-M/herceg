// Maps zoomed and panned through the chart's viewport, in the plane's units,
// and their rows selected and highlighted through `rowSelection`.

import { describe, expect, it } from "vitest";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { type SelectionStore, selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Schema, type Table, table } from "../../src/data/table.ts";
import { emptyExtent, extendExtent, planProjection } from "../../src/geo/project.ts";
import { estimateText } from "../../src/layout/text.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { DIM } from "../../src/marks/mark.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { brushedRows, clickedRows } from "../../src/model/selected-rows.ts";
import { renderPdf } from "../../src/render/pdf.ts";
import { renderSvg } from "../../src/render/svg.ts";
import type { PointGeometry, PolygonGeometry, Scene } from "../../src/scene/scene.ts";

/** A square [lon, lat] ring, closed. */
const ring = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];

/** Ten countries of 10 degrees in a row, along the equator. */
const row = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: Array.from({ length: 10 }, (_, i) => ({
    type: "Feature" as const,
    properties: { name: `C${i}`, gdp: i * 10 },
    geometry: { type: "Polygon" as const, coordinates: [ring(i * 10, -5, 10)] },
  })),
});

const projection = "equirectangular" as const;
const radians = Math.PI / 180;

/** A map, equirectangular unless the config says otherwise. */
type MapConfig = Omit<ChartConfig, "projection"> & Partial<Pick<ChartConfig, "projection">>;

function build(config: MapConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", projection, ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const polygons = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is PolygonGeometry => m.kind === "polygons");
const plane = (model: ChartModel) => model.items!.result()!.plane!;

/** Keys of every item, in keyboard order. */
function itemKeys(model: ChartModel): string[] {
  const keys: string[] = [];
  let key = model.stepItem(undefined, 1);
  while (key !== undefined && !keys.includes(key)) {
    keys.push(key);
    key = model.stepItem(key, 1);
  }
  return keys;
}

/** Shows the plane box around a longitude and latitude, `span` degrees wide, as the map's controls do. */
function zoomTo(model: ChartModel, lon: number, lat: number, span: number) {
  const [x, y, half] = [lon * radians, lat * radians, (span / 2) * radians];
  model.items!.setView({ x: [x - half, x + half], y: [y - half / 2, y + half / 2] }, undefined);
  return model.scene(estimateText);
}

describe("map viewports", () => {
  it("draw the fitted map exactly, and report its plane", () => {
    const { model, scene } = build({
      marks: [geoshape(fromGeoJSON(row()), { labelField: "name" })],
    });
    const [regions] = polygons(scene);
    expect(regions!.transform).toBeUndefined();
    expect(regions!.shapes).toHaveLength(10);
    const { x, y, zoom } = plane(model);
    expect(zoom).toBe(1);
    // The room's middle is the plane's: the row of countries is centered on 50° E, 0° N.
    expect((x.domain[0] + x.domain[1]) / 2).toBeCloseTo(50 * radians, 6);
    expect((y.domain[0] + y.domain[1]) / 2).toBeCloseTo(0, 6);
    expect(model.items!.view()).toEqual({ x: null, y: null, yRight: null });
  });

  it("zoom and pan by the plane's ranges, projecting at a level and moving the pixels", () => {
    const { model } = build({ marks: [geoshape(fromGeoJSON(row()), { labelField: "name" })] });
    const fitted = plane(model);
    const scene = zoomTo(model, 25, 0, 20);
    const [regions] = polygons(scene);
    const t = regions!.transform!;
    // Shapes are projected at the next level up and drawn scaled down at most a level.
    expect(t.k).toBeGreaterThan(0.84);
    expect(t.k).toBeLessThanOrEqual(1);
    const zoomed = plane(model);
    // Its zoom is the scale drawn over the fitted one's, here about 5 times it.
    const factor = (scale: typeof zoomed.x) =>
      (scale.range[1] - scale.range[0]) / (scale.domain[1] - scale.domain[0]);
    expect(zoomed.zoom).toBeCloseTo(factor(zoomed.x) / factor(fitted.x), 9);
    expect(zoomed.zoom).toBeGreaterThan(4);
    // C2 is in the middle of the room, under the pointer.
    const { plot } = scene.panels[0]!;
    const middle = model.inspect(
      plot.x + plot.width / 2,
      plot.y + plot.height / 2,
    ) as ItemInspection;
    expect(middle.points[0]!.label).toBe("C2");
    // Only regions within the room are drawn and read: C1 to C3, in part.
    expect(regions!.shapes).toHaveLength(3);
    expect(itemKeys(model).map((key) => model.inspectItem(key)!.points[0]!.label)).toEqual([
      "C1",
      "C2",
      "C3",
    ]);
    // A pan moves the same pixels: nothing is projected again.
    const shape = regions!.shapes.find((_, i) => i === 1)!;
    const panned = zoomTo(model, 26, 0, 20);
    const after = polygons(panned)[0]!;
    expect(after.shapes).toContain(shape);
    expect(after.transform!.k).toBe(t.k);
    expect(after.transform!.x).toBeLessThan(t.x);
  });

  it("keep tooltips, outlines, and the keyboard on what is drawn", () => {
    const { model } = build({ marks: [geoshape(fromGeoJSON(row()), { labelField: "name" })] });
    const scene = zoomTo(model, 25, 0, 20);
    const { plot } = scene.panels[0]!;
    const c2 = model.inspectItem(model.stepItem(undefined, 2)!) as ItemInspection;
    const { px, py } = c2.points[0]!;
    expect(px).toBeGreaterThan(plot.x);
    expect(px).toBeLessThan(plot.x + plot.width);
    expect((model.inspect(px, py) as ItemInspection).key).toBe(c2.key);
    // The outline is where the region is drawn: C2 spans the middle 10 of
    // the 20 degrees shown, its sides; its top and bottom, beyond the plot,
    // are cut away with the drawing.
    const coords = c2.outline.match(/-?[\d.]+/g)!.map(Number);
    const xs = coords.filter((_, i) => i % 2 === 0);
    const ys = coords.filter((_, i) => i % 2 === 1);
    expect(Math.min(...xs)).toBeCloseTo(plot.x + plot.width / 4, -1);
    expect(Math.max(...xs)).toBeCloseTo(plot.x + (3 * plot.width) / 4, -1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(plot.y - 0.05);
    expect(Math.max(...ys)).toBeLessThanOrEqual(plot.y + plot.height + 0.05);
    expect(c2.outline).not.toContain("Z");
  });

  it("show a range along one axis about the fitted map's middle along the other", () => {
    const { model } = build({ marks: [geoshape(fromGeoJSON(row()))] });
    const fitted = plane(model);
    model.items!.setView([20 * radians, 40 * radians], undefined);
    model.scene(estimateText);
    const { x, y } = plane(model);
    expect(x.domain[0]).toBeCloseTo(20 * radians, 9);
    expect(x.domain[1]).toBeCloseTo(40 * radians, 9);
    expect((y.domain[0] + y.domain[1]) / 2).toBeCloseTo(
      (fitted.y.domain[0] + fitted.y.domain[1]) / 2,
      9,
    );
    // Both ranges are contained, centered: the wider of the two shows whole.
    model.items!.setView({ y: [-60 * radians, 60 * radians] }, undefined);
    model.scene(estimateText);
    const both = plane(model);
    expect(both.y.domain[0]).toBeCloseTo(-60 * radians, 9);
    expect(both.x.domain[1] - both.x.domain[0]).toBeGreaterThan(20 * radians);
    // The viewport given is what the chart reports, so setting it again changes nothing.
    expect(model.items!.view()!.x).toEqual([20 * radians, 40 * radians]);
  });

  it("draw points at the zoomed scale, and leave out those outside the room", () => {
    const cities = table({ lon: [5, 25, 95], lat: [0, 0, 0], name: ["a", "b", "c"] });
    const { model } = build({
      marks: [geopoint(cities, { longitude: "lon", latitude: "lat", labelField: "name" })],
    });
    const scene = zoomTo(model, 15, 0, 30);
    const points = scene.panels[0]!.marks.find((m): m is PointGeometry => m.kind === "point")!;
    expect(points.count).toBe(2);
    const { x } = plane(model);
    expect(points.coords[0]).toBeCloseTo(x.map(5 * radians), 3);
  });

  it("export the view shown, in SVG and PDF", () => {
    const { model } = build({ marks: [geoshape(fromGeoJSON(row()))] });
    const scene = zoomTo(model, 25, 0, 20);
    const t = polygons(scene)[0]!.transform!;
    const svg = renderSvg(scene);
    expect(svg).toContain(`transform="matrix(${t.k} 0 0 ${t.k} `);
    // Borders keep their width on screen.
    expect(svg).toContain(`stroke-width="${Math.round((0.75 / t.k) * 1e4) / 1e4}"`);
    const pdf = new TextDecoder("latin1").decode(renderPdf(scene));
    expect(pdf.length).toBeGreaterThan(0);
  });

  it("refuse zooming along one axis", () => {
    expect(() =>
      build({ marks: [geoshape(fromGeoJSON(row()))], interaction: { zoom: "x" } }),
    ).toThrow('geoshape zoom: expected interaction.zoom true or "xy"; received "x"');
    expect(() =>
      build({ marks: [geoshape(fromGeoJSON(row()))], interaction: { brush: "xy" } }),
    ).toThrow('geoshape brush: expected interaction.brush "lasso"; received "xy"');
    for (const interaction of [{ zoom: true }, { zoom: "xy" }, { brush: "lasso" }] as const) {
      const { model } = build({ marks: [geoshape(fromGeoJSON(row()))], interaction });
      expect(model.items!.asked()[0]?.kind).toBe("map");
    }
  });
});

/** A map bound to a store of its regions' table, as a mounted chart binds it. */
function bound<S extends Schema>(config: MapConfig, store: SelectionStore<S>) {
  const selection = rowSelection({ store, channel: "c" });
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

describe("map row selection", () => {
  it("selects a region's row by click, and its point's", () => {
    const regions = fromGeoJSON(row());
    const cities = table({ lon: [55], lat: [0] });
    const store = selectionStore(regions);
    const model = bound(
      {
        marks: [geoshape(regions), geopoint(cities, { longitude: "lon", latitude: "lat" })],
      },
      store,
    );
    const { x, y } = plane(model);
    const tables = new Set([regions as unknown as Table, cities as unknown as Table]);
    // C2's middle: its region; the city is on top of C5.
    expect(clickedRows(model, tables, x.map(25 * radians), y.map(0))?.rows).toEqual(
      Uint32Array.of(2),
    );
    const city = clickedRows(model, tables, x.map(55 * radians), y.map(0))!;
    expect(city.table).toBe(cities);
    expect(city.rows).toEqual(Uint32Array.of(0));
    // Only the bound table's rows are clicked.
    expect(
      clickedRows(model, new Set([regions as unknown as Table]), x.map(55 * radians), y.map(0)),
    ).toBeNull();
  });

  it("lassos regions by a point inside them, the same at any zoom", () => {
    const regions = fromGeoJSON(row());
    const store = selectionStore(regions);
    const model = bound({ marks: [geoshape(regions)], interaction: { brush: "lasso" } }, store);
    // A box around C3 to C5's middles, on the plane.
    const lasso = [
      [28 * radians, -3 * radians],
      [57 * radians, -3 * radians],
      [57 * radians, 3 * radians],
      [28 * radians, 3 * radians],
    ] as const;
    const selection = { x: null, y: null, lasso };
    const at = (rows: ReturnType<typeof brushedRows>) =>
      rows?.kind === "rows" ? [...rows.rows.positions()] : rows;
    const fitted = at(brushedRows(model, regions as unknown as Table, selection, null));
    expect(fitted).toEqual([3, 4, 5]);
    zoomTo(model, 45, 0, 40);
    expect(at(brushedRows(model, regions as unknown as Table, selection, null))).toEqual(fitted);
  });

  it("lasso a small region far from the plane's origin by a point inside it", () => {
    const ring = [
      [0.5, 89.999],
      [1.5, 89.999],
      [1.5, 89.999001],
      [0.5, 89.999001],
      [0.5, 89.999],
    ];
    const regions = fromGeoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Polar" },
          geometry: { type: "Polygon", coordinates: [ring] },
        },
      ],
    });
    const store = selectionStore(regions);
    const model = bound(
      {
        marks: [geoshape(regions, { labelField: "name" })],
        projection: { type: "conic-equal-area", parallels: [89.999, 89.999] },
        interaction: { brush: "lasso" },
      },
      store,
    );
    model.scene(estimateText);
    // A lasso around the region drawn, 2 pixels clear of it, in the plane.
    const outline = (model.inspectItem("[0,0]") as ItemInspection).outline;
    const coords = outline.match(/-?[\d.]+/g)!.map(Number);
    const xs = coords.filter((_, i) => i % 2 === 0);
    const ys = coords.filter((_, i) => i % 2 === 1);
    const [left, right] = [Math.min(...xs) - 2, Math.max(...xs) + 2];
    const [top, bottom] = [Math.min(...ys) - 2, Math.max(...ys) + 2];
    const { x, y } = plane(model);
    const lasso = [
      [x.invert(left), y.invert(top)],
      [x.invert(right), y.invert(top)],
      [x.invert(right), y.invert(bottom)],
      [x.invert(left), y.invert(bottom)],
    ] as const;
    const rows = brushedRows(model, regions as unknown as Table, { x: null, y: null, lasso }, null);
    expect(rows?.kind === "rows" && [...rows.rows.positions()]).toEqual([0]);
  });

  it("dims the regions and points whose rows are not selected", () => {
    const regions = fromGeoJSON(row());
    const store = selectionStore(regions);
    const model = bound({ marks: [geoshape(regions)] }, store);
    store.set("c", selectRows(new RowSet(regions).addAll([1, 2])));
    const [dimmed, lit] = polygons(model.scene(estimateText));
    expect(dimmed!.shapes).toHaveLength(8);
    expect(dimmed!.fillOpacity).toBe(DIM);
    expect(lit!.shapes).toHaveLength(2);
    expect(lit!.fillOpacity).toBe(1);
    store.set("c", null);
    expect(polygons(model.scene(estimateText))).toHaveLength(1);

    const cities = table({ lon: [5, 25, 45], lat: [0, 0, 0] });
    const places = selectionStore(cities);
    const map = bound({ marks: [geopoint(cities, { longitude: "lon", latitude: "lat" })] }, places);
    places.set("c", selectRows(new RowSet(cities).add(1)));
    const drawn = map
      .scene(estimateText)
      .panels[0]!.marks.filter((m): m is PointGeometry => m.kind === "point");
    expect(drawn.map(({ count, fillOpacity }) => [count, fillOpacity])).toEqual([
      [2, 0.8 * DIM],
      [1, 0.8],
    ]);
  });
});

describe("highlighted maps", () => {
  it("find the selected region or point drawn above the others where they overlap", () => {
    // Two squares on the same place: the second drawn on top until the first is selected.
    const twice: FeatureCollection = {
      type: "FeatureCollection",
      features: [0, 1].map((i) => ({
        type: "Feature" as const,
        properties: { name: `R${i}` },
        geometry: { type: "Polygon" as const, coordinates: [ring(0, -5, 10)] },
      })),
    };
    const regions = fromGeoJSON(twice);
    const store = selectionStore(regions);
    const model = bound({ marks: [geoshape(regions, { labelField: "name" })] }, store);
    const plot = model.scene(estimateText).panels[0]!.plot;
    const middle = [plot.x + plot.width / 2, plot.y + plot.height / 2] as const;
    const found = () => (model.inspect(...middle) as ItemInspection | undefined)?.key;
    expect(found()).toBe("[0,1]");
    store.set("c", selectRows(new RowSet(regions).add(0)));
    model.scene(estimateText);
    expect(found()).toBe("[0,0]");
    // Read in row order all the same.
    expect(itemKeys(model)).toEqual(["[0,0]", "[0,1]"]);

    const cities = table({ name: ["P0", "P1"], lon: [5, 5], lat: [0, 0] });
    const places = selectionStore(cities);
    const map = bound(
      { marks: [geopoint(cities, { longitude: "lon", latitude: "lat", labelField: "name" })] },
      places,
    );
    map.scene(estimateText);
    const point = map.items!.result()!.item(0);
    const at = () => (map.inspect(point.px, point.py) as ItemInspection | undefined)?.key;
    expect(at()).toBe("[0,1]");
    places.set("c", selectRows(new RowSet(cities).add(0)));
    map.scene(estimateText);
    expect(at()).toBe("[0,0]");
    expect(itemKeys(map)).toEqual(["[0,0]", "[0,1]"]);
  });
});

describe("zoomed maps", () => {
  it("draw and find a region zoomed into where its edge bows past its points", () => {
    // A degree of a parallel, whose middle (the central meridian) bows below
    // its two ends: in mid-latitudes, and a hair from the pole, where it
    // bows by far less than any rounding threshold would keep.
    const cases = [
      { south: 40, north: 40.5, projection: { type: "conic-equal-area" } as const },
      {
        south: 89.999,
        north: 89.999001,
        projection: { type: "conic-equal-area", parallels: [89.999, 89.999] } as const,
      },
    ];
    for (const { south, north, projection } of cases) {
      const ring = [
        [0.5, south],
        [1.5, south],
        [1.5, north],
        [0.5, north],
        [0.5, south],
      ];
      const bowed: FeatureCollection = {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { name: "Bowed" },
            geometry: { type: "Polygon", coordinates: [ring] },
          },
        ],
      };
      const model = new ChartModel({
        locale: "en-US",
        projection,
        marks: [geoshape(fromGeoJSON(bowed), { labelField: "name" })],
      });
      model.setSize(600, 400, 1);
      model.scene(estimateText);
      const extent = emptyExtent();
      extendExtent(extent, 0.5, south);
      extendExtent(extent, 1.5, north);
      const plan = planProjection(projection, extent);
      const at = (lon: number, lat: number) => {
        const out = new Float64Array(2);
        plan.raw((lon - plan.clipper.center) * radians, lat * radians, out);
        return [out[0]!, out[1]!] as const;
      };
      const [dx, dip] = at(1, south);
      const [, end] = at(0.5, south);
      // A view 256 times the map's scale whose top is halfway between the dip and the ends.
      const fitted = plane(model).view(undefined);
      const width = (fitted.x[1] - fitted.x[0]) / 256;
      const height = (fitted.y[1] - fitted.y[0]) / 256;
      const top = (dip + end) / 2;
      model.items!.setView(
        { x: [dx - width / 2, dx + width / 2], y: [top - height, top] },
        undefined,
      );
      const scene = model.scene(estimateText);
      const { plot } = scene.panels[0]!;
      // The sliver of the region shown is pixels deep.
      expect(((top - dip) * plot.height) / height).toBeGreaterThan(4);
      expect(polygons(scene)[0]!.shapes).toHaveLength(1);
      // At the top of the view, above the dip.
      const found = model.inspect(plot.x + plot.width / 2, plot.y + 1);
      expect((found as ItemInspection | undefined)?.key).toBe("[0,0]");
    }
  });

  it("place a small map's regions where they are at 256 times its scale", () => {
    // Two regions a hundredth of a degree wide, meeting at 51.001 degrees north.
    const square = (south: number, north: number) => [
      [0, south],
      [0.01, south],
      [0.01, north],
      [0, north],
      [0, south],
    ];
    const small: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        [50.996, 51.001],
        [51.001, 51.006],
      ].map(([south, north], i) => ({
        type: "Feature" as const,
        properties: { name: `R${i}` },
        geometry: { type: "Polygon" as const, coordinates: [square(south!, north!)] },
      })),
    };
    const { model } = build({ marks: [geoshape(fromGeoJSON(small), { labelField: "name" })] });
    const scene = zoomTo(model, 0.005, 51.001, 0.01 / 256);
    const { plot } = scene.panels[0]!;
    const middle = plot.y + plot.height / 2;
    const key = (y: number) =>
      (model.inspect(plot.x + plot.width / 2, y) as ItemInspection | undefined)?.key;
    expect(key(middle - 5)).toBe("[0,1]");
    expect(key(middle + 5)).toBe("[0,0]");
  });

  it("read only the regions some of which the view shows, anchored in that part", () => {
    // A frame with a hole of 20 degrees, and two squares 30 degrees apart.
    const features: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Frame" },
          geometry: { type: "Polygon", coordinates: [ring(0, -20, 40), ring(10, -10, 20)] },
        },
        {
          type: "Feature",
          properties: { name: "Pair" },
          geometry: {
            type: "MultiPolygon",
            coordinates: [[ring(50, -5, 10)], [ring(90, -5, 10)]],
          },
        },
      ],
    };
    const { model } = build({ marks: [geoshape(fromGeoJSON(features), { labelField: "name" })] });
    // Inside the hole, then between the pair's squares: boxes overlap, nothing shows.
    for (const [lon, lat] of [
      [20, 0],
      [75, 0],
    ] as const) {
      zoomTo(model, lon, lat, 6);
      expect(itemKeys(model)).toEqual([]);
      expect(model.layoutSummary()).toBe("Map with no regions to show.");
    }
    // The frame's left edge in view: read, its anchor in the part shown.
    const scene = zoomTo(model, 1, 0, 6);
    const { plot } = scene.panels[0]!;
    expect(itemKeys(model)).toEqual(["[0,0]"]);
    const { px, py } = model.inspectItem("[0,0]")!.points[0]!;
    expect(px).toBeGreaterThanOrEqual(plot.x);
    expect(px).toBeLessThanOrEqual(plot.x + plot.width);
    expect(py).toBeGreaterThanOrEqual(plot.y);
    expect(py).toBeLessThanOrEqual(plot.y + plot.height);
    expect((model.inspect(px, py) as ItemInspection).key).toBe("[0,0]");
  });

  it("anchor the keyboard's tooltip in a strip of a region thinner than a line apart", () => {
    // A frame a degree wide, of which the view shows a strip of a few pixels.
    const frame: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Frame" },
          geometry: { type: "Polygon", coordinates: [ring(-10, -10, 20), ring(-9, -9, 18)] },
        },
      ],
    };
    const { model } = build({ marks: [geoshape(fromGeoJSON(frame), { labelField: "name" })] });
    model.items!.setView({ x: [0, 2 * radians], y: [8.01 * radians, 9.01 * radians] }, undefined);
    const { plot } = model.scene(estimateText).panels[0]!;
    expect(itemKeys(model)).toEqual(["[0,0]"]);
    const { px, py } = model.inspectItem("[0,0]")!.points[0]!;
    expect(px).toBeGreaterThanOrEqual(plot.x);
    expect(px).toBeLessThanOrEqual(plot.x + plot.width);
    expect(py).toBeGreaterThanOrEqual(plot.y);
    expect(py).toBeLessThanOrEqual(plot.y + plot.height);
    expect((model.inspect(px, py) as ItemInspection).key).toBe("[0,0]");
  });

  it("export zoomed regions far from the plane's middle where they are drawn and found", () => {
    const far: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Far" },
          geometry: { type: "Polygon", coordinates: [ring(169.9, 69.95, 0.2)] },
        },
      ],
    };
    const model = new ChartModel({
      locale: "en-US",
      projection: { type: "equirectangular", fit: "world" },
      marks: [geoshape(fromGeoJSON(far), { labelField: "name" })],
    });
    model.setSize(600, 400, 1);
    model.scene(estimateText);
    const scene = zoomTo(model, 170, 70, 360 / 256);
    const svg = renderSvg(scene);
    const [, k, x, y] = svg.match(
      /transform="matrix\(([-\d.e]+) 0 0 \S+ ([-\d.e]+) ([-\d.e]+)\)"/,
    )!;
    const path = svg.match(/<path d="M([-\d.]+) ([-\d.]+)[^"]*"[^>]*transform="matrix/)!;
    const exported = [
      Number(x) + Number(k) * Number(path[1]),
      Number(y) + Number(k) * Number(path[2]),
    ];
    const item = model.inspectItem("[0,0]") as ItemInspection;
    const [, ox, oy] = item.outline.match(/^M([-\d.]+) ([-\d.]+)/)!;
    expect(Math.abs(exported[0]! - Number(ox))).toBeLessThan(0.2);
    expect(Math.abs(exported[1]! - Number(oy))).toBeLessThan(0.2);
  });

  it("say what a viewport shows, fitted to the room as the map fits it", () => {
    const { model } = build({ marks: [geoshape(fromGeoJSON(row()))] });
    const { view, x } = plane(model);
    const fitted = view(undefined);
    expect(fitted.zoom).toBe(1);
    expect(fitted.x).toEqual(x.domain);
    // An x range alone keeps the fitted map's middle along y.
    const [x0, x1] = fitted.x;
    const half = view({ x: [x0, x0 + (x1 - x0) / 2], y: null });
    expect(half.zoom).toBeCloseTo(2, 9);
    expect((half.y[0] + half.y[1]) / 2).toBeCloseTo((fitted.y[0] + fitted.y[1]) / 2, 9);
    // Ranges of another shape than the room's show the larger one, uniformly.
    const wide = view({ x: [x0, x0 + (x1 - x0) / 2], y: [0, 1e-6] });
    expect(wide.zoom).toBeCloseTo(2, 9);
    expect(wide.y[1] - wide.y[0]).toBeCloseTo(half.y[1] - half.y[0], 9);
  });

  it("find nothing outside the room, where shapes reach but are not drawn", () => {
    const { model } = build({ marks: [geoshape(fromGeoJSON(row()), { labelField: "name" })] });
    const scene = zoomTo(model, 25, 0, 6);
    const { plot } = scene.panels[0]!;
    const middle = plot.x + plot.width / 2;
    expect(model.inspect(middle, plot.y + plot.height / 2)).toBeDefined();
    expect(model.inspect(middle, plot.y - 4)).toBeUndefined();
  });
});
