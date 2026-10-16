<!-- A gauge: the last finite value of `value` on a dial. It has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type GaugeOptions, gauge, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<GaugeOptions<S>, S> = $props();
  const inPanel = panelled("Gauge");
  const mark = $derived(built(() => gauge(data, inPanel(plain(options)) as GaugeOptions<S>)));
  const anchor = markAnchor("Gauge", () => mark);
</script>

<template {@attach anchor}></template>
