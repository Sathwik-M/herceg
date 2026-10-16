<!-- Scatter points. -->
<script lang="ts" generics="S extends Schema">
  import { type PointOptions, point, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithRows } from "./marks.js";

  let { data, ...options }: WithRows<PointOptions<S>, S> = $props();
  const inPanel = panelled("Point");
  const mark = $derived(built(() => point(data, inPanel(plain(options)) as PointOptions<S>)));
  const anchor = markAnchor("Point", () => mark);
</script>

<template {@attach anchor}></template>
