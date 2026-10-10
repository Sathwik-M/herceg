<script lang="ts">
  import { table } from "herceg";
  import { Chart, Dendrogram } from "../src/index.js";

  let { leaves }: { leaves: string[] } = $props();
  const linkage = table({ first: [0], second: [1], height: [2] });
</script>

<Chart renderer="svg">
  <Dendrogram data={linkage} first="first" second="second" height="height" {leaves} stroke="#ff0000" label="Clustering" />
</Chart>
