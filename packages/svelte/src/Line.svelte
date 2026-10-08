<!-- Lines through x and y fields of `data`. -->
<script lang="ts" generics="S extends Schema">
  import { type LineOptions, line, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<LineOptions<S>, S> = $props();
  const mark = $derived(line(data, plain(options) as LineOptions<S>));
  const anchor = markAnchor("Line", () => mark);
</script>

<template {@attach anchor}></template>
