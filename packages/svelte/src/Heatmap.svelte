<!-- A grid of colored cells. -->
<script lang="ts" generics="S extends Schema">
  import { type HeatmapOptions, heatmap, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<HeatmapOptions<S>, S> = $props();
  const mark = $derived(heatmap(data, plain(options) as HeatmapOptions<S>));
  const anchor = markAnchor("Heatmap", () => mark);
</script>

<template {@attach anchor}></template>
