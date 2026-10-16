<!-- Counts of exactly one number or time field, `x` or `y`, with shared bins. -->
<script lang="ts" generics="S extends Schema">
  import { type HistogramOptions, histogram, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<HistogramOptions<S>, S> = $props();
  const inPanel = panelled("Histogram");
  const mark = $derived(
    built(() => histogram(data, inPanel(plain(options)) as HistogramOptions<S>)),
  );
  const anchor = markAnchor("Histogram", () => mark);
</script>

<template {@attach anchor}></template>
