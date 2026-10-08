<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, Funnel, Gauge } from "../src/index.js";

  let {
    readings,
    stages,
  }: {
    readings: Table<{ cpu: "number" }>;
    stages: Table<{ stage: "category"; users: "number" }>;
  } = $props();
</script>

<Chart locale="en-US">
  <Gauge data={readings} value="cpu" max={80} />
</Chart>
<Chart locale="en-US">
  <Funnel data={stages} category="stage" value="users" />
</Chart>
