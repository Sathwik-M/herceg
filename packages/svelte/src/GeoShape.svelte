<!-- Regions of a map from a table's geometry field, filled by `color`; maps' marks share a chart and its `projection`. -->
<script lang="ts" generics="S extends Schema">
  import { type GeoShapeOptions, geoshape, type Schema } from "herceg";
  import { built, markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<GeoShapeOptions<S>, S> = $props();
  const mark = $derived(built(() => geoshape(data, plain(options) as GeoShapeOptions<S>)));
  const anchor = markAnchor("GeoShape", () => mark);
</script>

<template {@attach anchor}></template>
