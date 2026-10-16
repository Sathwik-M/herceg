<!-- A pie, or with `innerRadius` a donut: `category`, and `value` to sum. It has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type PieOptions, pie, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<PieOptions<S>, S> = $props();
  const inPanel = panelled("Pie");
  const mark = $derived(built(() => pie(data, inPanel(plain(options)) as PieOptions<S>)));
  const anchor = markAnchor("Pie", () => mark);
</script>

<template {@attach anchor}></template>
