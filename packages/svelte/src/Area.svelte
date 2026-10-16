<!-- Filled areas: to zero, stacked, or a band between two fields. -->
<script lang="ts" generics="S extends Schema">
  import { type AreaOptions, area, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<AreaOptions<S>, S> = $props();
  const inPanel = panelled("Area");
  const mark = $derived(built(() => area(data, inPanel(plain(options)) as AreaOptions<S>)));
  const anchor = markAnchor("Area", () => mark);
</script>

<template {@attach anchor}></template>
