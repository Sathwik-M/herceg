<!-- A Sankey diagram of flows from `source` to `target` nodes; it has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type SankeyOptions, type Schema, sankey } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<SankeyOptions<S>, S> = $props();
  const inPanel = panelled("Sankey");
  const mark = $derived(built(() => sankey(data, inPanel(plain(options)) as SankeyOptions<S>)));
  const anchor = markAnchor("Sankey", () => mark);
</script>

<template {@attach anchor}></template>
