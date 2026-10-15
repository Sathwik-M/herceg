<!-- Open-high-low-close candles: `x`, `open`, `high`, `low`, `close`. -->
<script lang="ts" generics="S extends Schema">
  import { type CandlestickOptions, candlestick, type Schema } from "herceg";
  import { built, markAnchor, plain, type WithData } from "./marks.js";

  let { data, ...options }: WithData<CandlestickOptions<S>, S> = $props();
  const mark = $derived(built(() => candlestick(data, plain(options) as CandlestickOptions<S>)));
  const anchor = markAnchor("Candlestick", () => mark);
</script>

<template {@attach anchor}></template>
