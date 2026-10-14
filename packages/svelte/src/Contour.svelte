<!-- Contours of a field sampled on a grid: lines at thresholds, or bands between them. -->
<script lang="ts" generics="S extends Schema">
  import { type ContourOptions, contour, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<ContourOptions<S>, S> = $props();
  const mark = $derived(contour(data, plain(options) as ContourOptions<S>));
  const anchor = markAnchor("Contour", () => mark);
</script>

<template {@attach anchor}></template>
