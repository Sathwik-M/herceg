<!-- A linkage tree whose leaves stand on category bands. -->
<script lang="ts" generics="S extends Schema">
  import { type DendrogramOptions, dendrogram, type Schema } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<DendrogramOptions<S>, S> = $props();
  const mark = $derived(dendrogram(data, plain(options) as DendrogramOptions<S>));
  const anchor = markAnchor("Dendrogram", () => mark);
</script>

<template {@attach anchor}></template>
