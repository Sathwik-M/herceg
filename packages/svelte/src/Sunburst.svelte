<!-- A sunburst of a tree given by `path` fields, or `node` and `parent`; it has its chart to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type Schema, type SunburstOptions, sunburst } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<SunburstOptions<S>, S> = $props();
  const mark = $derived(sunburst(data, plain(options) as SunburstOptions<S>));
  const anchor = markAnchor("Sunburst", () => mark);
</script>

<template {@attach anchor}></template>
