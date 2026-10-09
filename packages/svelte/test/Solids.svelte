<script lang="ts">
  import type { Chart as HercegChart, Table } from "herceg";
  import { Chart, Point3D, Surface } from "../src/index.js";

  let {
    grid,
    points,
    azimuth,
    chart = $bindable(null),
    oncamera,
  }: {
    grid: Table<{ x: "number"; y: "number"; z: "number" }>;
    points: Table<{ x: "number"; y: "number"; z: "number" }>;
    azimuth: number;
    chart?: HercegChart | null;
    oncamera: (event: { camera: { azimuth: number } }) => void;
  } = $props();
</script>

<Chart bind:chart camera={{ azimuth }} locale="en-US" {oncamera}>
  <Surface data={grid} x="x" y="y" z="z" />
  <Point3D data={points} x="x" y="y" z="z" />
</Chart>
