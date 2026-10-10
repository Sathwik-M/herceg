<!-- Counts of exactly one number or time field, `x` or `y`, with shared bins. -->
<script lang="ts" generics="S extends Schema">
  import { type HistogramOptions, histogram, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<HistogramOptions<S>, S> = $props();
  const mark = $derived(histogram(data, plain(options) as HistogramOptions<S>));
  const anchor = markAnchor("Histogram", () => mark);
</script>

<template {@attach anchor}></template>
