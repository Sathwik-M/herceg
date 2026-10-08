<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, Pie } from "../src/index.js";

  let { data }: { data: Table<{ k: "category"; v: "number" }> } = $props();
</script>

<Chart title="Shares">
  <Pie {data} category="k" value="v" innerRadius={0.5} />
</Chart>
