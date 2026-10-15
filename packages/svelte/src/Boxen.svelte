<!-- Letter-value plots: a category field on `x` or `y`, the values on the other, and optionally `series`. -->
<script lang="ts" generics="S extends Schema">
  import { type BoxenOptions, boxen, type Schema } from "herceg";
  import { built, markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<BoxenOptions<S>, S> = $props();
  const mark = $derived(built(() => boxen(data, plain(options) as BoxenOptions<S>)));
  const anchor = markAnchor("Boxen", () => mark);
</script>

<template {@attach anchor}></template>
