<!-- A surface in a 3D chart over a grid of rows: `x` and `y` pick a grid point, `z` is its height. -->
<script lang="ts" generics="S extends Schema">
  import { type Schema, type SurfaceOptions, surface } from "herceg";
  import { built, markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<SurfaceOptions<S>, S> = $props();
  const mark = $derived(built(() => surface(data, plain(options) as SurfaceOptions<S>)));
  const anchor = markAnchor("Surface", () => mark);
</script>

<template {@attach anchor}></template>
