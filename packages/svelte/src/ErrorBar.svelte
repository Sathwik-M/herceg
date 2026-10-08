<!-- Error bars: `x`, `y1`, `y2` (vertical) or `y`, `x1`, `x2` (horizontal). -->
<script lang="ts" generics="S extends Schema">
  import { type ErrorBarOptions, errorBar, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<ErrorBarOptions<S>, S> = $props();
  const mark = $derived(errorBar(data, plain(options) as ErrorBarOptions<S>));
  const anchor = markAnchor("ErrorBar", () => mark);
</script>

<template {@attach anchor}></template>
