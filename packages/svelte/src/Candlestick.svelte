<!-- Open-high-low-close candles: `x`, `open`, `high`, `low`, `close`. -->
<script lang="ts" generics="S extends Schema">
  import { type CandlestickOptions, candlestick, type Schema } from "herceg";
  import { built, markAnchor, panelled, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<CandlestickOptions<S>, S> = $props();
  const inPanel = panelled("Candlestick");
  const mark = $derived(
    built(() => candlestick(data, inPanel(plain(options)) as CandlestickOptions<S>)),
  );
  const anchor = markAnchor("Candlestick", () => mark);
</script>

<template {@attach anchor}></template>
