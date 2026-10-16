<!-- A sunburst of a tree given by `path` fields, or `node` and `parent`; it has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type Schema, type SunburstOptions, sunburst } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<SunburstOptions<S>, S> = $props();
  const inPanel = panelled("Sunburst");
  const mark = $derived(built(() => sunburst(data, inPanel(plain(options)) as SunburstOptions<S>)));
  const anchor = markAnchor("Sunburst", () => mark);
</script>

<template {@attach anchor}></template>
