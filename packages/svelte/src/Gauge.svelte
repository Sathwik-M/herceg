<!-- A gauge: the last finite value of `value` on a dial. It has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type GaugeOptions, gauge, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<GaugeOptions<S>, S> = $props();
  const mark = $derived(gauge(data, plain(options) as GaugeOptions<S>));
  const anchor = markAnchor("Gauge", () => mark);
</script>

<template {@attach anchor}></template>
