<!-- Lines through x and y fields of `data`. -->
<script lang="ts" generics="S extends Schema">
  import { type LineOptions, line, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<LineOptions<S>, S> = $props();
  const inPanel = panelled("Line");
  const mark = $derived(built(() => line(data, inPanel(plain(options)) as LineOptions<S>)));
  const anchor = markAnchor("Line", () => mark);
</script>

<template {@attach anchor}></template>
