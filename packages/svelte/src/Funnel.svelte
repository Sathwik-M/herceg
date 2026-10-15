<!-- A funnel: a centered bar per stage of `category`, as wide as its `value`. It has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type FunnelOptions, funnel, type Schema } from "herceg";
  import { built, markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<FunnelOptions<S>, S> = $props();
  const mark = $derived(built(() => funnel(data, plain(options) as FunnelOptions<S>)));
  const anchor = markAnchor("Funnel", () => mark);
</script>

<template {@attach anchor}></template>
