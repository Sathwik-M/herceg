<!-- A radar: `category` and `value`, or a list of `fields`, a spoke each. It has its chart to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type RadarOptions, radar, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<RadarOptions<S>, S> = $props();
  const mark = $derived(radar(data, plain(options) as RadarOptions<S>));
  const anchor = markAnchor("Radar", () => mark);
</script>

<template {@attach anchor}></template>
