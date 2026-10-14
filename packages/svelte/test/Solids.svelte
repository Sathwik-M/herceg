<script lang="ts">
  import type { Chart as HercegChart, Panels, Table } from "herceg";
  import { Chart, Line3D, Point3D, Surface } from "../src/index.js";

  let {
    grid,
    points,
    azimuth,
    chart = $bindable(null),
    oncamera,
    layout,
  }: {
    grid: Table<{ x: "number"; y: "number"; z: "number" }>;
    points: Table<{ x: "number"; y: "number"; z: "number" }>;
    azimuth: number;
    chart?: HercegChart | null;
    layout?: Panels;
    oncamera: (event: { camera: { azimuth: number }; panels?: readonly string[] }) => void;
  } = $props();
</script>

<Chart bind:chart camera={{ azimuth }} locale="en-US" {oncamera} panels={layout}>
  <Surface {...(layout ? { panel: "a" } : {})} data={grid} x="x" y="y" z="z" />
  <Point3D {...(layout ? { panel: "a" } : {})} data={points} x="x" y="y" z="z" />
  <Line3D {...(layout ? { panel: "b" } : {})} data={grid} x="x" y="y" z="z" />
</Chart>
