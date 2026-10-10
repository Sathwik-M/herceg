<!-- A treemap of a tree given by `path` fields, or `node` and `parent`; it has its chart, each facet panel, or its `panel` to itself. -->
<script lang="ts" generics="S extends Schema">
  import { type Schema, type TreemapOptions, treemap } from "herceg";
  import { markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<TreemapOptions<S>, S> = $props();
  const mark = $derived(treemap(data, plain(options) as TreemapOptions<S>));
  const anchor = markAnchor("Treemap", () => mark);
</script>

<template {@attach anchor}></template>
