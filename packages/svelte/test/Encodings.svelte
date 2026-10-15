<script lang="ts">
  import { col, type Chart as HercegChart, table } from "herceg";
  import { Chart, Line, Rule } from "../src/index.js";

  let { chart = $bindable(null) }: { chart?: HercegChart | null } = $props();
  const sites = table({ t: [0, 1, 0, 1], v: [1, 2, -1, 3], site: ["a", "a", "b", "b"] });
</script>

<Chart bind:chart renderer="svg" scales={{ color: { type: "ordinal", map: { b: "#00ab41" } } }}>
  <Line data={sites} x="t" y="v" series="site" color="site" markers where={col("v").gt(0)} />
  <Rule y={2} label={{ text: "Goal", place: { attachment: "start", outside: true } }} />
</Chart>
