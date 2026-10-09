<!-- OHLC bars over trading days, weekends left out. -->
<script lang="ts">
  import type { Chart as HercegChart, Table, TimeBreaks } from "herceg";
  import { Candlestick, Chart } from "../src/index.js";

  let {
    data,
    breaks,
    chart = $bindable(null),
  }: {
    data: Table<{ t: "time"; o: "number"; h: "number"; l: "number"; c: "number" }>;
    breaks: TimeBreaks;
    chart?: HercegChart | null;
  } = $props();
</script>

<Chart bind:chart timeZone="UTC" x={{ breaks }}>
  <Candlestick {data} x="t" open="o" high="h" low="l" close="c" variant="ohlc" />
</Chart>
