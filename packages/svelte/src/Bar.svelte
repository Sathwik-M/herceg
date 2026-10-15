<!-- Bars: vertical, or horizontal when `y` is a category. -->
<script lang="ts" generics="S extends Schema">
  import { type BarOptions, bar, type Schema } from "herceg";
  import { built, markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<BarOptions<S>, S> = $props();
  const mark = $derived(built(() => bar(data, plain(options) as BarOptions<S>)));
  const anchor = markAnchor("Bar", () => mark);
</script>

<template {@attach anchor}></template>
