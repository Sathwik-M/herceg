<!-- Violins: a category field on `x` or `y`, the values on the other, and optionally `series`. -->
<script lang="ts" generics="S extends Schema">
  import { type Schema, type ViolinOptions, violin } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<ViolinOptions<S>, S> = $props();
  const inPanel = panelled("Violin");
  const mark = $derived(built(() => violin(data, inPanel(plain(options)) as ViolinOptions<S>)));
  const anchor = markAnchor("Violin", () => mark);
</script>

<template {@attach anchor}></template>
