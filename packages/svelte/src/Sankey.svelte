<!-- A Sankey diagram of flows from `source` to `target` nodes; it has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type SankeyOptions, type Schema, sankey } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<SankeyOptions<S>, S> = $props();
  const mark = $derived(sankey(data, plain(options) as SankeyOptions<S>));
  const anchor = markAnchor("Sankey", () => mark);
</script>

<template {@attach anchor}></template>
