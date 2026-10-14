import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { line } from "../../src/marks/line.ts";
import { line3d } from "../../src/marks/line3d.ts";
import { point } from "../../src/marks/point.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { surface } from "../../src/marks/surface.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { cloudPainter } from "../../src/render/webgl.ts";
import type { Camera } from "../../src/three/camera.ts";
import { MOUSE, modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:500px;height:400px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Enough 3D points for the GPU. */
const cloud = table({
  x: Float64Array.from({ length: 30_000 }, (_, i) => Math.sin(i)),
  y: Float64Array.from({ length: 30_000 }, (_, i) => Math.cos(i * 1.3)),
  z: Float64Array.from({ length: 30_000 }, (_, i) => (i % 100) / 100),
});

const points = table({
  x: [0, 1, 2, 3],
  y: [3, 2, 1, 0],
  z: [0, 1, 2, 3],
  kind: category(["a", "a", "b", "b"]),
});

async function mount(options: Partial<ChartOptions> = {}): Promise<Chart> {
  const chart = createChart(host, {
    locale: "en-US",
    marks: [point3d(points, { x: "x", y: "y", z: "z", series: "kind" })],
    ...options,
  });
  // The orbit is loaded the first time a 3D chart draws.
  await chart.loading;
  return chart;
}

function at(chart: Chart, type: string, x: number, y: number, init: PointerEventInit = {}) {
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      pointerId: MOUSE,
      clientX: rect.left + x,
      clientY: rect.top + y,
      ...init,
    }),
  );
}

const key = (chart: Chart, k: string, shiftKey = false) =>
  chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true }));

describe("3D charts", () => {
  it.each([false, true])(
    "refreshes the live description after a camera turn (subplots: %s)",
    async (subplots) => {
      const chart = await mount({
        camera: { azimuth: 20 },
        ...(subplots && {
          panels: panels([
            { id: "a", title: "Cloud" },
            { id: "b", camera: { azimuth: 90 } },
          ]),
          marks: [
            point3d(points, { x: "x", y: "y", z: "z", panel: "a" }),
            point3d(points, { x: "x", y: "y", z: "z", panel: "b" }),
          ],
        }),
      });
      try {
        const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
        expect(description.textContent).toContain("azimuth 20°");
        chart.setCamera({ azimuth: 40 }, subplots ? { panel: "a" } : undefined);
        chart.render();
        await expect
          .poll(() => description.textContent, { timeout: 2000 })
          .toContain("azimuth 40°");
        expect(description.textContent).not.toContain("azimuth 20°");
        if (subplots) expect(description.textContent).toContain("azimuth 90°");
      } finally {
        chart.destroy();
      }
    },
  );

  it("turn when dragged, reporting the camera once a frame, and go back on double-click", async () => {
    const chart = await mount();
    const cameras: Camera[] = [];
    chart.on("camera", ({ camera }) => cameras.push(camera));
    const start = chart.getCamera()!;
    at(chart, "pointerdown", 250, 200);
    at(chart, "pointermove", 260, 205);
    at(chart, "pointermove", 300, 220);
    // Dragging shows no tooltip.
    expect(chart.root.textContent).not.toContain("x 0");
    await frame();
    expect(cameras).toHaveLength(1);
    expect(cameras[0]!.azimuth).toBeCloseTo(start.azimuth - 50 * 0.4);
    expect(cameras[0]!.elevation).toBeCloseTo(start.elevation + 20 * 0.4);
    at(chart, "pointerup", 300, 220);
    chart.root.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await frame();
    expect(chart.getCamera()).toEqual(start);
    expect(cameras).toHaveLength(2);
    chart.destroy();
  });

  it("show the point under the pointer, and click it", async () => {
    const chart = await mount();
    const clicks: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicks.push(inspection?.points[0]?.text));
    const first = modelOf(chart).inspectItem(modelOf(chart).stepItem(undefined, 1)!)!.points[0]!;
    at(chart, "pointermove", first.px + 1, first.py);
    await frame();
    expect(chart.root.textContent).toContain("x 0, y 3, z 0");
    at(chart, "pointerdown", first.px, first.py);
    at(chart, "pointerup", first.px, first.py);
    expect(clicks).toEqual(["x 0, y 3, z 0"]);
    chart.destroy();
  });

  it("turn with Shift and the arrow keys, zoom with plus and minus, and read points with the arrows", async () => {
    const chart = await mount();
    chart.root.focus();
    const live = chart.root.querySelector("[aria-live]")!;
    const start = chart.getCamera()!;
    key(chart, "ArrowLeft", true);
    expect(chart.getCamera()!.azimuth).toBe(start.azimuth - 15);
    expect(live.textContent).toBe("Seen from azimuth -75°, elevation 25°.");
    key(chart, "ArrowUp", true);
    expect(chart.getCamera()!.elevation).toBe(40);
    key(chart, "+");
    expect(chart.getCamera()!.zoom).toBe(1.25);
    key(chart, "ArrowRight");
    expect(live.textContent).toBe("Points. a: x 0, y 3, z 0");
    expect(chart.root.getAttribute("aria-describedby")).toBeTruthy();
    chart.render();
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("Shift with the arrow keys turns it");
    chart.destroy();
  });

  it("have buttons that turn, zoom, and reset the view", async () => {
    const chart = await mount();
    const buttons = [...chart.root.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")];
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Turn left",
      "Turn right",
      "Tilt up",
      "Tilt down",
      "Zoom in",
      "Zoom out",
      "Reset view",
    ]);
    const start = chart.getCamera()!;
    buttons[1]!.click();
    buttons[3]!.click();
    buttons[4]!.click();
    expect(chart.getCamera()).toEqual({
      ...start,
      azimuth: start.azimuth + 15,
      elevation: 10,
      zoom: 1.25,
    });
    buttons[6]!.click();
    expect(chart.getCamera()).toEqual(start);
    // Hidden until the pointer or focus is in the chart.
    const toolbar = chart.root.querySelector<HTMLElement>("[role=toolbar]")!;
    expect(toolbar.style.opacity).toBe("0");
    buttons[0]!.focus();
    expect(toolbar.style.opacity).toBe("1");
    chart.destroy();
  });

  it("zoom with the wheel only when asked, and keep dragging off when rotate is false", async () => {
    const wheel = (chart: Chart) =>
      chart.root.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: -100,
          clientX: 250,
          clientY: 200,
        }),
      );
    const plain = await mount();
    wheel(plain);
    expect(plain.getCamera()!.zoom).toBe(1);
    plain.destroy();
    const zooms = await mount({ interaction: { zoom: true, rotate: false } });
    wheel(zooms);
    expect(zooms.getCamera()!.zoom).toBeCloseTo(Math.exp(0.2));
    const before = zooms.getCamera();
    at(zooms, "pointerdown", 250, 200);
    at(zooms, "pointermove", 300, 200);
    at(zooms, "pointerup", 300, 200);
    expect(zooms.getCamera()).toEqual(before);
    expect(zooms.root.style.touchAction).toBe("");
    zooms.destroy();
  });

  it("turn sideways under touches and leave the page to scroll up and down", async () => {
    const chart = await mount();
    expect(chart.root.style.touchAction).toBe("pan-y");
    chart.destroy();
  });

  it("take cameras from code, and from changed options", async () => {
    const chart = await mount({ camera: { azimuth: 10 } });
    const cameras: Camera[] = [];
    chart.on("camera", ({ camera }) => cameras.push(camera));
    chart.setCamera({ elevation: 60 });
    expect(chart.getCamera()).toMatchObject({ azimuth: 10, elevation: 60 });
    // The same options keep the view; a different camera shows it.
    chart.update({ title: "Turned" });
    expect(chart.getCamera()!.elevation).toBe(60);
    chart.update({ camera: { azimuth: 45 } });
    expect(chart.getCamera()).toMatchObject({ azimuth: 45, elevation: 25 });
    await frame();
    expect(cameras).toHaveLength(1);
    // A chart that stops being 3D loses its camera and buttons.
    chart.update({ marks: [line(points, { x: "x", y: "y" })] });
    expect(chart.getCamera()).toBeUndefined();
    expect(chart.root.querySelector("[role=toolbar]")).toBeNull();
    chart.destroy();
  });

  it("draw large point clouds on the GPU, and find their points on the CPU", async () => {
    const n = 30_000;
    const big = table({
      x: Float64Array.from({ length: n }, (_, i) => Math.sin(i)),
      y: Float64Array.from({ length: n }, (_, i) => Math.cos(i * 1.3)),
      z: Float64Array.from({ length: n }, (_, i) => (i % 100) / 100),
    });
    const before = cloudPainter()!.bytes;
    const chart = createChart(host, { marks: [point3d(big, { x: "x", y: "y", z: "z" })] });
    await chart.loading;
    // The points went to the GPU: three float32 values and a color index each.
    expect(cloudPainter()!.bytes - before).toBe(n * 13);
    const faces = modelOf(chart)
      .scene((text) => text.length * 6, true)
      .panels[0]!.marks.find((m) => m.kind === "faces") as unknown as { batches?: unknown };
    expect(faces.batches).toBeDefined();
    const canvas = chart.root.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const first = modelOf(chart).inspectItem(modelOf(chart).stepItem(undefined, 1)!)!.points[0]!;
    // The frontmost point under the first one's center is drawn there.
    const pixel = canvas
      .getContext("2d")!
      .getImageData(Math.round(first.px * ratio), Math.round(first.py * ratio), 1, 1).data;
    expect(pixel[3]).toBe(255);
    at(chart, "pointermove", first.px, first.py);
    await frame();
    expect(chart.root.textContent).toMatch(/x -?\d/);
    chart.destroy();
    expect(cloudPainter()!.bytes).toBe(before);
  });

  it("wait in `loading` for the 3D painter a chart turned 3D needs, after the 2D one", async () => {
    const before = cloudPainter()!.bytes;
    const flat = table({
      x: Float64Array.from({ length: 150_000 }, (_, i) => i % 1000),
      y: Float64Array.from({ length: 150_000 }, (_, i) => i % 7),
    });
    const chart = createChart(host, { marks: [point(flat, { x: "x", y: "y" })] });
    // The chart turns 3D before the 2D painter has loaded.
    chart.update({ marks: [point3d(cloud, { x: "x", y: "y", z: "z" })] });
    await chart.loading;
    expect(chart.loading).toBeUndefined();
    expect(cloudPainter()!.bytes - before).toBe(cloud.length * 13);
    chart.destroy();
    expect(cloudPainter()!.bytes).toBe(before);
  });

  it("place GPU points precisely whatever values lie outside the box, at any magnitude", async () => {
    // Far outliers first, which an upload measured from them would lose the rest to.
    const n = 25_000;
    for (const scale of [1, 1e40, 1e-40]) {
      const x = Float64Array.from({ length: n }, (_, i) =>
        i === 0 ? 1e12 * scale : (0.25 + (i % 7) * 1e-3) * scale,
      );
      const y = Float64Array.from({ length: n }, (_, i) => (i % 2) / 2);
      const z = Float64Array.from({ length: n }, (_, i) => (i % 3) / 3);
      const chart = createChart(host, {
        x: { domain: [0, scale] },
        marks: [point3d(table({ x, y, z }), { x: "x", y: "y", z: "z", fill: "#ff0000" })],
      });
      await chart.loading;
      const canvas = chart.root.querySelector("canvas")!;
      const ratio = canvas.width / chart.root.clientWidth;
      const context = canvas.getContext("2d")!;
      for (const step of [1, 2, 3]) {
        const { px, py } = modelOf(chart).inspectItem(modelOf(chart).stepItem(undefined, step)!)!
          .points[0]!;
        const [r, , , a] = context.getImageData(
          Math.round(px * ratio),
          Math.round(py * ratio),
          1,
          1,
        ).data;
        expect([scale, r, a]).toEqual([scale, 255, 255]);
      }
      chart.destroy();
    }
  });

  it("stop listening once destroyed, and follow only the pointer that began a drag", async () => {
    const chart = await mount();
    const start = chart.getCamera()!;
    let clicks = 0;
    chart.on("click", () => clicks++);
    at(chart, "pointerdown", 250, 200, { pointerId: MOUSE });
    at(chart, "pointerdown", 100, 100, { pointerId: 2 });
    at(chart, "pointermove", 110, 100, { pointerId: 2 });
    expect(chart.getCamera()).toEqual(start);
    at(chart, "pointermove", 270, 200, { pointerId: MOUSE });
    expect(chart.getCamera()!.azimuth).toBeCloseTo(start.azimuth - 8);
    // A second pointer pressed and released during the drag clicks nothing.
    at(chart, "pointerdown", 100, 100, { pointerId: 3 });
    at(chart, "pointerup", 100, 100, { pointerId: 3 });
    at(chart, "pointerup", 270, 200, { pointerId: MOUSE });
    expect(clicks).toBe(0);
    const root = chart.root;
    chart.destroy();
    root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }),
    );
    expect(root.querySelector("[role=toolbar]")).toBeNull();
  });

  it("end a press only with its own pointer, so other pointers make no click", async () => {
    const chart = await mount();
    let clicks = 0;
    chart.on("click", () => clicks++);
    at(chart, "pointerdown", 250, 200, { pointerId: MOUSE });
    at(chart, "pointermove", 270, 200, { pointerId: MOUSE });
    at(chart, "pointerdown", 100, 100, { pointerId: 2 });
    at(chart, "pointercancel", 100, 100, { pointerId: 2 });
    at(chart, "pointerdown", 100, 100, { pointerId: 3 });
    at(chart, "pointerup", 100, 100, { pointerId: 3 });
    // Touches leave the chart as they end.
    at(chart, "pointerleave", 100, 100, { pointerId: 3 });
    at(chart, "pointerdown", 100, 100, { pointerId: 3 });
    at(chart, "pointerup", 100, 100, { pointerId: 3 });
    at(chart, "pointerup", 270, 200, { pointerId: MOUSE });
    expect(clicks).toBe(0);
    // A press whose pointer the chart loses ends, and the next one clicks.
    at(chart, "pointerdown", 250, 200, { pointerId: MOUSE });
    at(chart, "lostpointercapture", 250, 200, { pointerId: MOUSE });
    at(chart, "pointerdown", 250, 200, { pointerId: MOUSE });
    at(chart, "pointerup", 250, 200, { pointerId: MOUSE });
    expect(clicks).toBe(1);
    chart.destroy();
  });

  it("fill a ridge whose two sides face away from each other on screen", async () => {
    // Seen nearly edge on, the two cells turn opposite ways on screen and overlap.
    const ridge = table({
      x: [-1, 0, 1, -1, 0, 1],
      y: [0, 0, 0, 1, 1, 1],
      z: [0, 1, 0, 0, 1, 0],
    });
    const chart = createChart(host, {
      renderer: "canvas",
      camera: { azimuth: 0, elevation: 10 },
      marks: [
        surface(ridge, { x: "x", y: "y", z: "z", shading: false, colors: ["#00aa00", "#00aa00"] }),
      ],
    });
    const scene = modelOf(chart).scene((text) => text.length * 6);
    const mark = scene.panels[0]!.marks.find((m) => m.kind === "faces") as unknown as {
      count: number;
      starts: Uint32Array;
      corners: Uint32Array;
      vertices: Float32Array;
    };
    chart.render();
    const canvas = chart.root.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const context = canvas.getContext("2d")!;
    for (let f = 0; f < mark.count; f++) {
      let [cx, cy] = [0, 0];
      const corners = mark.starts[f + 1]! - mark.starts[f]!;
      for (let c = mark.starts[f]!; c < mark.starts[f + 1]!; c++) {
        cx += mark.vertices[mark.corners[c]! * 2]! / corners;
        cy += mark.vertices[mark.corners[c]! * 2 + 1]! / corners;
      }
      const [, g, , a] = context.getImageData(
        Math.round(cx * ratio),
        Math.round(cy * ratio),
        1,
        1,
      ).data;
      expect([g, a]).toEqual([0xaa, 255]);
    }
    chart.destroy();
  });

  it("stroke lines' segments on a canvas, joined round", async () => {
    const path = table({ x: [0, 1, 2], y: [0, 1, 0], z: [0, 1, 0] });
    const chart = createChart(host, {
      renderer: "canvas",
      marks: [line3d(path, { x: "x", y: "y", z: "z", stroke: "#00aa00", strokeWidth: 6 })],
    });
    const model = modelOf(chart);
    const at = (row: number) => model.inspectItem(JSON.stringify([0, row]))!.points[0]!;
    const canvas = chart.root.querySelector("canvas")!;
    const ratio = canvas.width / chart.root.clientWidth;
    const context = canvas.getContext("2d")!;
    // Along each segment and at the joint.
    for (const [a, b, t] of [
      [0, 1, 0.5],
      [1, 2, 0.5],
      [1, 2, 0],
    ] as const) {
      const x = at(a).px + t * (at(b).px - at(a).px);
      const y = at(a).py + t * (at(b).py - at(a).py);
      const [, g, , alpha] = context.getImageData(
        Math.round(x * ratio),
        Math.round(y * ratio),
        1,
        1,
      ).data;
      expect([g, alpha]).toEqual([0xaa, 255]);
    }
    chart.destroy();
  });

  it("paint dense surfaces on a canvas, with labels in SVG", async () => {
    const n = 80;
    const x = Float64Array.from({ length: n * n }, (_, k) => k % n);
    const y = Float64Array.from({ length: n * n }, (_, k) => Math.floor(k / n));
    const z = Float64Array.from(
      { length: n * n },
      (_, k) => Math.sin((k % n) / 10) + Math.cos(Math.floor(k / n) / 10),
    );
    const chart = createChart(host, {
      marks: [surface(table({ x, y, z }), { x: "x", y: "y", z: "z" })],
    });
    const canvas = chart.root.querySelector("canvas")!;
    expect(canvas).not.toBeNull();
    const ratio = canvas.width / chart.root.clientWidth;
    const first = modelOf(chart).inspectItem(modelOf(chart).stepItem(undefined, 40 * n + 40)!)!
      .points[0]!;
    const pixel = canvas
      .getContext("2d")!
      .getImageData(Math.round(first.px * ratio), Math.round(first.py * ratio), 1, 1).data;
    // Painted: where four faces meet, Firefox's antialiasing of their edges
    // leaves the pixel 254 of 255 covered.
    expect(pixel[3]).toBeGreaterThanOrEqual(254);
    expect(chart.root.querySelector("svg")!.textContent).toContain("z");
    expect(chart.toSVG()).toContain("<path");
    chart.destroy();
  });
});

describe("3D subplots", () => {
  it.each(["canvas", "svg"] as const)(
    "draws and picks surfaces by each panel's depth, and clips at its edges (%s)",
    async (renderer) => {
      const plane = table({ x: [-1, 1, -1, 1], y: [-1, -1, 1, 1], z: [0, 0, 0, 0] });
      const probes = table({ x: [0.2, -0.2], y: [0.2, -0.2], z: [-0.4, 0.4] });
      const chart = await mount({
        width: 800,
        height: 350,
        renderer,
        legend: false,
        x: { domain: [-1, 1] },
        y: { domain: [-1, 1] },
        z: { domain: [-1, 1] },
        panels: panels(
          [
            { id: "a", camera: { azimuth: -60, elevation: 60 } },
            { id: "b", camera: { azimuth: 120, elevation: -60, perspective: true } },
          ],
          { columns: 2 },
        ),
        marks: ["a", "b"].flatMap((panel) => [
          surface(plane, {
            x: "x",
            y: "y",
            z: "z",
            colors: ["#0000ff", "#0000ff"],
            shading: false,
            panel,
          }),
          point3d(probes, { x: "x", y: "y", z: "z", fill: "#ff0000", radius: 8, panel }),
        ]),
      });
      const pixels = async () => {
        if (renderer === "canvas") {
          chart.render();
          return chart.root.querySelector("canvas")!.getContext("2d")!;
        }
        const image = await createImageBitmap(await chart.toPNG({ scale: 1 }));
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        image.close();
        return context;
      };
      try {
        const context = await pixels();
        const ratio = context.canvas.width / 800;
        const model = modelOf(chart);
        for (const [panel, pointMark, visibleRow] of [
          ["a", 1, 1],
          ["b", 3, 0],
        ] as const) {
          for (const row of [0, 1]) {
            const { px, py } = model.inspectItem(JSON.stringify([pointMark, row]), panel)!
              .points[0]!;
            const visible = row === visibleRow;
            expect(
              Array.from(
                context.getImageData(Math.round(px * ratio), Math.round(py * ratio), 1, 1).data,
              ).slice(0, 3),
            ).toEqual(visible ? [255, 0, 0] : [0, 0, 255]);
            expect(model.inspect(px, py)!.points[0]!.mark).toBe(
              visible ? pointMark : pointMark - 1,
            );
          }
        }
        // At this zoom the surfaces extend across the panel edges and inter-panel gap.
        chart.setCamera({ zoom: 6 }, { panel: "a" });
        chart.setCamera({ zoom: 6 }, { panel: "b" });
        const clipped = await pixels();
        const { width, height } = clipped.canvas;
        const data = clipped.getImageData(0, 0, width, height).data;
        const plots = chart.getPanels().map(({ plot }) => plot);
        const blue = [0, 0];
        let leaked = 0;
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++) {
            const k = (y * width + x) * 4;
            if (data[k] !== 0 || data[k + 1] !== 0 || data[k + 2] !== 255 || data[k + 3] !== 255)
              continue;
            const panel = plots.findIndex(
              (p) =>
                (x + 0.5) / ratio >= p.x &&
                (x + 0.5) / ratio < p.x + p.width &&
                (y + 0.5) / ratio >= p.y &&
                (y + 0.5) / ratio < p.y + p.height,
            );
            if (panel < 0) leaked++;
            else blue[panel]!++;
          }
        expect(leaked).toBe(0);
        expect(blue.every((count) => count > 1000)).toBe(true);
      } finally {
        chart.destroy();
      }
    },
  );

  it("exports PNG pixels at the current camera of each panel", async () => {
    const chart = await mount({
      width: 800,
      height: 350,
      legend: false,
      panels: panels(
        [
          { id: "a", camera: { azimuth: 20 } },
          { id: "b", camera: { azimuth: 90 } },
        ],
        { columns: 2 },
      ),
      marks: ["a", "b"].map((panel) =>
        point3d(points, { x: "x", y: "y", z: "z", fill: "#ff0000", radius: 8, panel }),
      ),
    });
    try {
      const check = async () => {
        const image = await createImageBitmap(await chart.toPNG({ scale: 1 }));
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        image.close();
        const model = modelOf(chart);
        for (const [mark, panel] of [
          [0, "a"],
          [1, "b"],
        ] as const)
          for (const row of [0, 1, 2, 3]) {
            const { px, py } = model.inspectItem(JSON.stringify([mark, row]), panel)!.points[0]!;
            expect(
              Array.from(context.getImageData(Math.round(px), Math.round(py), 1, 1).data),
            ).toEqual([255, 0, 0, 255]);
          }
      };
      await check();
      chart.setCamera({ azimuth: -110, elevation: 55 }, { panel: "a" });
      await check();
      expect(chart.getCamera({ panel: "b" })!.azimuth).toBe(90);
    } finally {
      chart.destroy();
    }
  });

  it("scope gestures, keyboard turning, toolbars, and camera events to their panels", async () => {
    const chart = await mount({
      width: 900,
      height: 400,
      panels: panels(
        [
          { id: "a", title: "Cloud" },
          { id: "trend", title: "Trend" },
          { id: "b", title: "Fit", camera: { azimuth: 90 } },
        ],
        { columns: 3 },
      ),
      marks: [
        point3d(points, { x: "x", y: "y", z: "z", panel: "a" }),
        line(points, { x: "x", y: "z", panel: "trend" }),
        line3d(points, { x: "x", y: "y", z: "z", panel: "b" }),
      ],
      interaction: { zoom: true },
    });
    const events: { camera: Camera; panels?: readonly string[] }[] = [];
    chart.on("camera", (event) => events.push(event));
    expect(chart.root.querySelectorAll('[role="toolbar"]')).toHaveLength(2);
    const [a, trend] = chart.getPanels();
    const center = (plot: typeof a) =>
      [plot!.plot.x + plot!.plot.width / 2, plot!.plot.y + plot!.plot.height / 2] as const;
    // The host is narrower than the chart, so pointer coordinates follow the displayed scale.
    const atPanel = (type: string, panel: typeof a, dx = 0) => {
      const [x, y] = center(panel);
      const rect = chart.root.getBoundingClientRect();
      at(chart, type, ((x + dx) * rect.width) / 900, (y * rect.height) / 400);
    };
    const startB = chart.getCamera({ panel: "b" });
    atPanel("pointerdown", a);
    atPanel("pointermove", a, 35);
    atPanel("pointerup", a, 35);
    await frame();
    expect(events).toHaveLength(1);
    expect(events[0]!.panels).toEqual(["a"]);
    expect(chart.getCamera({ panel: "b" })).toEqual(startB);
    atPanel("pointerdown", trend);
    atPanel("pointermove", trend, 35);
    atPanel("pointerup", trend, 35);
    await frame();
    expect(events).toHaveLength(1);
    chart.root.focus();
    key(chart, "Home");
    key(chart, "ArrowRight", true);
    expect(chart.getCamera({ panel: "a" })!.azimuth).toBeGreaterThan(events[0]!.camera.azimuth);
    key(chart, "ArrowDown"); // trend
    const before = chart.getCamera({ panel: "a" });
    key(chart, "ArrowRight", true);
    expect(chart.getCamera({ panel: "a" })).toEqual(before);
    key(chart, "ArrowDown"); // fit
    key(chart, "ArrowLeft", true);
    expect(chart.getCamera({ panel: "b" })!.azimuth).toBe(75);
    await frame();
    expect(chart.toSVG()).toContain("azimuth 75°");
    expect(chart.toSVG()).toContain("Fit");
    const pdf = renderToPDF(chart);
    expect(pdf.length).toBeGreaterThan(1000);
    const png = await chart.toPNG();
    expect(png.type).toBe("image/png");
    chart.root.querySelector<HTMLButtonElement>('[aria-label="View, Fit"] button')!.click();
    expect(chart.getCamera({ panel: "b" })!.azimuth).toBe(60);
    chart.update({ panels: undefined, marks: [line(points, { x: "x", y: "z" })] });
    await chart.loading;
    expect(chart.root.querySelectorAll('[role="toolbar"]')).toHaveLength(0);
    chart.destroy();
  });

  it("reuses the unchanged panel's raster while another projects its points", async () => {
    const painted = vi.spyOn(CanvasRenderingContext2D.prototype, "arc");
    const chart = await mount({
      renderer: "canvas",
      panels: panels([{ id: "a" }, { id: "b" }], { columns: 2 }),
      marks: ["a", "b"].map((panel) => point3d(cloud, { x: "x", y: "y", z: "z", panel })),
    });
    painted.mockClear();
    chart.setCamera({ azimuth: -45 }, { panel: "a" });
    await frame();
    expect(painted.mock.calls.length).toBe(30_000);
    expect(chart.root.querySelectorAll("canvas")).toHaveLength(1);
    painted.mockRestore();
    chart.destroy();
  });
});

it("combines map and orbit touch controls while keeping gestures in their panels", async () => {
  const places = table({ lon: [0, 10], lat: [0, 10] });
  const chart = await mount({
    panels: panels([{ id: "cloud" }, { id: "map" }], { columns: 2 }),
    marks: [
      point3d(points, { x: "x", y: "y", z: "z", panel: "cloud" }),
      geopoint(places, { longitude: "lon", latitude: "lat", panel: "map" }),
    ],
    interaction: { zoom: true },
  });
  expect(chart.root.style.touchAction).toBe("none");
  chart.setCamera({ azimuth: 40 });
  const map = chart.getPanels()[1]!.plot;
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new MouseEvent("dblclick", {
      bubbles: true,
      clientX: rect.left + map.x + map.width / 2,
      clientY: rect.top + map.y + map.height / 2,
    }),
  );
  expect(chart.getCamera()!.azimuth).toBe(40);
  chart.update({ interaction: { zoom: false } });
  expect(chart.root.style.touchAction).toBe("pan-y");
  chart.destroy();
});

it("ends a drag when its subplot loses its camera and refreshes retained toolbar names", async () => {
  const chart = await mount({
    panels: panels(
      [
        { id: "a", title: "Cloud" },
        { id: "b", title: "Fit" },
      ],
      { columns: 2 },
    ),
    marks: ["a", "b"].map((panel) => point3d(points, { x: "x", y: "y", z: "z", panel })),
  });
  const a = chart.getPanels()[0]!.plot;
  const stale = chart.root.querySelector<HTMLButtonElement>('[aria-label="View, Cloud"] button')!;
  at(chart, "pointerdown", a.x + a.width / 2, a.y + a.height / 2);
  chart.update({
    panels: panels([{ id: "a" }, { id: "b", title: "New fit" }], { columns: 2 }),
    marks: [
      line(points, { x: "x", y: "z", panel: "a" }),
      point3d(points, { x: "x", y: "y", z: "z", panel: "b" }),
    ],
  });
  at(chart, "pointermove", a.x + a.width / 2 + 30, a.y + a.height / 2);
  at(chart, "pointerup", a.x + a.width / 2 + 30, a.y + a.height / 2);
  stale.click();
  await frame();
  expect(chart.getCamera()!.azimuth).toBe(-60);
  expect(chart.root.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
  expect(chart.root.querySelector('[aria-label="View, New fit"]')).not.toBeNull();
  chart.destroy();
});
