<!-- Points in a 3D chart at the number or time fields `x`, `y`, and `z`; 3D marks share a chart, its box, and its `camera`. -->
<script lang="ts" generics="S extends Schema">
  import { type Point3DOptions, point3d, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<Point3DOptions<S>, S> = $props();
  const mark = $derived(point3d(data, plain(options) as Point3DOptions<S>));
  const anchor = markAnchor("Point3D", () => mark);
</script>

<template {@attach anchor}></template>
