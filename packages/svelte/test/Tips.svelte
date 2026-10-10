<!-- A chart whose tooltip shows a snippet of its own while `own` is set. -->
<script lang="ts">
  import type { Chart as HercegChart, Table } from "herceg";
  import { Chart, Line } from "../src/index.js";

  let {
    data,
    own = true,
    unit = "ms",
    chart = $bindable(null),
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    own?: boolean;
    unit?: string;
    chart?: HercegChart | null;
  } = $props();
</script>

{#snippet tip(inspection: import("herceg").Inspection)}
  <b>{inspection.points[0]?.text} {unit}</b>
{/snippet}

<Chart bind:chart locale="en-US" renderTooltip={own ? tip : undefined}>
  <Line {data} x="t" y="a" tooltip={{ fields: ["b"] }} />
</Chart>
