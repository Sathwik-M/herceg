// Two CPU 3D subplots: turn one while the other reuses its geometry and raster.
import { type Chart, createChart, panels, point3d, table } from "herceg";
import { grid } from "herceg/layout";
import type { PlotRect } from "../../../packages/herceg/src/scene/scene.ts";
import { View } from "../../../packages/herceg/src/three/camera.ts";
import { FaceBuffer } from "../../../packages/herceg/src/three/faces.ts";

export interface Sample {
  draws: number[];
  frames: number[];
  panels: PlotRect[];
  devicePixelRatio: number;
}

const frame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
let chart: Chart | undefined;
const COUNT = 50_000;

async function mount(): Promise<void> {
  const marks = ["a", "b"].map((panel, j) =>
    point3d(
      table({
        x: Float64Array.from({ length: COUNT }, (_, i) => Math.sin(i * 0.017 + j)),
        y: Float64Array.from({ length: COUNT }, (_, i) => Math.cos(i * 0.013 + j)),
        z: Float64Array.from({ length: COUNT }, (_, i) => (i % 500) / 500),
      }),
      { x: "x", y: "y", z: "z", panel, radius: 1.5 },
    ),
  );
  chart = createChart(document.querySelector<HTMLElement>("#chart")!, {
    marks,
    panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 2 })),
    renderer: "canvas",
    width: 1000,
    height: 500,
  });
  await chart.loading;
  for (let i = 0; i < 30; i++) {
    chart.setCamera({ azimuth: -60 + i }, { panel: "a" });
    await frame();
  }
}

async function sample(): Promise<Sample> {
  const draws: number[] = [],
    frames: number[] = [];
  let previous = await frame();
  for (let i = 0; i < 120; i++) {
    const now = await frame();
    frames.push(now - previous);
    previous = now;
    const start = performance.now();
    chart!.setCamera({ azimuth: -30 + i }, { panel: "a" });
    chart!.render();
    draws.push(performance.now() - start);
  }
  return { draws, frames, panels: chart!.getPanels().map(({ plot }) => plot), devicePixelRatio };
}

/** Run separately from timings so instrumentation does not change the measured work. */
async function counts() {
  let sorts = 0,
    projects = 0,
    arcs = 0;
  const sort = FaceBuffer.prototype.geometry;
  const project = View.prototype.project;
  const arc = CanvasRenderingContext2D.prototype.arc;
  FaceBuffer.prototype.geometry = function (...args) {
    sorts++;
    return sort.apply(this, args);
  };
  View.prototype.project = function (...args) {
    projects++;
    return project.apply(this, args);
  };
  CanvasRenderingContext2D.prototype.arc = function (...args) {
    arcs++;
    return arc.apply(this, args);
  };
  try {
    chart!.setCamera({ azimuth: 160 }, { panel: "a" });
    chart!.render();
    return { sorts, projects, arcs };
  } finally {
    FaceBuffer.prototype.geometry = sort;
    View.prototype.project = project;
    CanvasRenderingContext2D.prototype.arc = arc;
  }
}

function destroy(): void {
  chart?.destroy();
  chart = undefined;
}

const api = { mount, sample, counts, destroy };
declare global {
  interface Window {
    threePanels: typeof api;
  }
}
window.threePanels = api;
