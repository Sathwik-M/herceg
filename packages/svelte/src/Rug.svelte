<!-- Individual observations as short ticks at a plot edge. -->
<script lang="ts" generics="S extends Schema">
  import { type RugOptions, rug, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<RugOptions<S>, S> = $props();
  const mark = $derived(rug(data, plain(options) as RugOptions<S>));
  const anchor = markAnchor("Rug", () => mark);
</script>

<template {@attach anchor}></template>
