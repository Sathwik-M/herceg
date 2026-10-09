<!-- Scatter points. -->
<script lang="ts" generics="S extends Schema">
  import { type PointOptions, point, type Schema } from "herceg";
  import { markAnchor, plain, type WithRows } from "./marks.js";

  let { data, ...options }: WithRows<PointOptions<S>, S> = $props();
  const mark = $derived(point(data, plain(options) as PointOptions<S>));
  const anchor = markAnchor("Point", () => mark);
</script>

<template {@attach anchor}></template>
