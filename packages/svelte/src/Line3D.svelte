<!-- Lines in a 3D chart through the number or time fields `x`, `y`, and `z`: each series' rows, in table order, are one path. -->
<script lang="ts" generics="S extends Schema">
  import { type Line3DOptions, line3d, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<Line3DOptions<S>, S> = $props();
  const inPanel = panelled("Line3D");
  const mark = $derived(built(() => line3d(data, inPanel(plain(options)) as Line3DOptions<S>)));
  const anchor = markAnchor("Line3D", () => mark);
</script>

<template {@attach anchor}></template>
