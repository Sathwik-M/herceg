<!-- A custom mark showing two series, drawn as dots in their colors. -->
<script lang="ts">
  import type { Chart as HercegChart, Table } from "herceg";
  import { Chart, Custom } from "../src/index.js";

  let {
    data,
    drawn,
    chart = $bindable(null),
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    /** Receives the labels of the series each draw is given. */
    drawn: (labels: string[]) => void;
    chart?: HercegChart | null;
  } = $props();
</script>

<Chart bind:chart>
  <Custom
    {data}
    x="t"
    y={["a", "b"]}
    pointText={(row, format, s) => `${format.y(s.y[row]!)} req`}
    draw={({ series, circle, x, y }) => {
      drawn(series.map((s) => s.label));
      for (const s of series) circle(x(s.x[0]!), y(s.y[0]!), 3, { fill: s.color });
    }}
  />
</Chart>
