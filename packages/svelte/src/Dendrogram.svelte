<!-- A linkage tree whose leaves stand on category bands. -->
<script lang="ts" generics="S extends Schema">
  import { type DendrogramOptions, dendrogram, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<DendrogramOptions<S>, S> = $props();
  const inPanel = panelled("Dendrogram");
  const mark = $derived(
    built(() => dendrogram(data, inPanel(plain(options)) as DendrogramOptions<S>)),
  );
  const anchor = markAnchor("Dendrogram", () => mark);
</script>

<template {@attach anchor}></template>
