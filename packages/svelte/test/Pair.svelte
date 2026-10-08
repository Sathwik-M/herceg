<!-- A component of the application's own that renders marks. -->
<script lang="ts">
  import type { Table } from "herceg";
  import { Point, Rule } from "../src/index.js";

  let { data }: { data: Table<{ t: "number"; a: "number"; b: "number" }> } = $props();
</script>

<Point {data} x="t" y="b" />
<Rule x={1} />
