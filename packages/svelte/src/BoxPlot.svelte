<!-- Box plots: a category field on `x` or `y`, the values on the other, and optionally `series`. -->
<script lang="ts" generics="S extends Schema">
  import { type BoxPlotOptions, boxplot, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<BoxPlotOptions<S>, S> = $props();
  const mark = $derived(boxplot(data, plain(options) as BoxPlotOptions<S>));
  const anchor = markAnchor("BoxPlot", () => mark);
</script>

<template {@attach anchor}></template>
