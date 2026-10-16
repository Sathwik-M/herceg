<!-- Points of a map at `longitude` and `latitude`, sized and colored as points are. -->
<script lang="ts" generics="S extends Schema">
  import { type GeoPointOptions, geopoint, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<GeoPointOptions<S>, S> = $props();
  const inPanel = panelled("GeoPoint");
  const mark = $derived(built(() => geopoint(data, inPanel(plain(options)) as GeoPointOptions<S>)));
  const anchor = markAnchor("GeoPoint", () => mark);
</script>

<template {@attach anchor}></template>
