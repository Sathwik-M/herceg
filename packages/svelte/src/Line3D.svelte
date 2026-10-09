<!-- Lines in a 3D chart through the number or time fields `x`, `y`, and `z`: each series' rows, in table order, are one path. -->
<script lang="ts" generics="S extends Schema">
  import { type Line3DOptions, line3d, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<Line3DOptions<S>, S> = $props();
  const mark = $derived(line3d(data, plain(options) as Line3DOptions<S>));
  const anchor = markAnchor("Line3D", () => mark);
</script>

<template {@attach anchor}></template>
