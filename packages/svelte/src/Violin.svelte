<!-- Violins: a category field on `x` or `y`, the values on the other, and optionally `series`. -->
<script lang="ts" generics="S extends Schema">
  import { type Schema, type ViolinOptions, violin } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<ViolinOptions<S>, S> = $props();
  const mark = $derived(violin(data, plain(options) as ViolinOptions<S>));
  const anchor = markAnchor("Violin", () => mark);
</script>

<template {@attach anchor}></template>
