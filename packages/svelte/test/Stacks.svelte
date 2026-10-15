<script lang="ts">
  import type { Chart as HercegChart, Table } from "herceg";
  import { Area, Chart } from "../src/index.js";

  let {
    data,
    stack,
    chart = $bindable(null),
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    stack: "fill" | "center" | "wiggle";
    chart?: HercegChart | null;
  } = $props();
</script>

<Chart bind:chart renderer="svg">
  <Area {data} x="t" y={["a", "b"]} stack={{ offset: stack, order: "inside-out" }} />
</Chart>
