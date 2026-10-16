<!--
  A legend. Inside a <Panel> or an <Inset>, the panel's own: its entries are
  what the panel draws, and they hide and show its series there only. Among
  the chart's children, the chart's, or with `panel`, that panel's.
-->
<script lang="ts">
  import { type LegendGuideOptions, legend } from "herceg";
  import { built, panelled, partAnchor, plain } from "./marks.js";

  let options: Omit<LegendGuideOptions, "type"> = $props();
  const inPanel = panelled("Legend");
  const guide = $derived(built(() => legend(inPanel(plain(options) as typeof options))));
  const anchor = partAnchor("Legend", (node) => ({
    node,
    get guide() {
      return guide;
    },
  }));
</script>

<template {@attach anchor}></template>
