<script lang="ts">
  import type { Table } from "herceg";
  import { Chart, Line, Region, Rule, Text } from "../src/index.js";

  let {
    data,
    events,
  }: {
    data: Table<{ t: "number"; a: "number"; b: "number" }>;
    events: Table<{ at: "number"; name: "category" }>;
  } = $props();
</script>

<Chart>
  <Region x1={0.5} x2={1.5} />
  <Line {data} x="t" y="a" />
  <Rule data={events} x="at" text="name" />
  <Text x={3} y={4} label="peak" />
</Chart>
