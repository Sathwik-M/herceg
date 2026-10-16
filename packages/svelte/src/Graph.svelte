<!-- A network of `source` and `target` nodes, placed by a force simulation, with `nodes` for groups and sizes; it has its chart to itself. -->
<script lang="ts" generics="S extends Schema, N extends Schema = Schema">
  import { type GraphOptions, graph, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<GraphOptions<S, N>, S> = $props();
  const inPanel = panelled("Graph");
  const mark = $derived(built(() => graph(data, inPanel(plain(options)) as GraphOptions<S, N>)));
  const anchor = markAnchor("Graph", () => mark);
</script>

<template {@attach anchor}></template>
