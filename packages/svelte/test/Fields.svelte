<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, Contour, Histogram } from "../src/index.js";

  let {
    field,
    pairs,
  }: {
    field: Table<{ x: "number"; y: "number"; z: "number" }>;
    pairs: Table<{ a: "number"; b: "number" }>;
  } = $props();
</script>

<Chart locale="en-US">
  <Contour data={field} x="x" y="y" color="z" thresholds={[0.5, 2]} variant="bands" />
  <Histogram data={pairs} x="a" y="b" bins={2} />
</Chart>
