import type { ChartSpec } from "herceg/spec";

export function threeSpec(): ChartSpec {
  return {
    width: 600,
    height: 300,
    renderer: "svg",
    panels: [
      { id: "a", title: "Cloud", camera: { azimuth: 20 } },
      { id: "b", title: "Path", camera: { azimuth: 90 } },
    ],
    layout: { type: "grid", columns: [1, 1] },
    data: { data: { columns: { x: [0, 1], y: [1, 0], z: [0, 1] } } },
    marks: [
      { type: "point3d", x: "x", y: "y", z: "z", panel: "a" },
      { type: "line3d", x: "x", y: "y", z: "z", panel: "b" },
    ],
  };
}
