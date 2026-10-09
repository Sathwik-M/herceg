<!-- Points of a map at `longitude` and `latitude`, sized and colored as points are. -->
<script lang="ts" generics="S extends Schema">
  import { type GeoPointOptions, geopoint, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<GeoPointOptions<S>, S> = $props();
  const mark = $derived(geopoint(data, plain(options) as GeoPointOptions<S>));
  const anchor = markAnchor("GeoPoint", () => mark);
</script>

<template {@attach anchor}></template>
