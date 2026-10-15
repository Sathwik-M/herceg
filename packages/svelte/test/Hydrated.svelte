<!-- A chart rendered on a server and hydrated in the browser (ssr.test.svelte.ts). -->
<script module lang="ts">
  import { line, renderToSnapshot, table } from "herceg";

  export const data = table({ month: [1, 2, 3, 4, 5], units: [12, 18, 9, 22, 15] });
  export const options = { title: "Units", locale: "en-US", timeZone: "UTC" } as const;

  /** The snapshot the server renders, from the options the component's chart has. */
  export function snapshot() {
    return renderToSnapshot(
      { ...options, marks: [line(data, { x: "month", y: "units" })] },
      { width: 600, height: 320, idPrefix: "units" },
    );
  }
</script>

<script lang="ts">
  import { type ChartSnapshot, type Chart as HercegChart, hydration } from "herceg";
  import { Chart, Line } from "../src/index.js";

  let {
    initial,
    chart = $bindable(null),
  }: { initial: ChartSnapshot; chart?: HercegChart | null } = $props();
</script>

<Chart {...options} initial={hydration(initial)} bind:chart>
  <Line {data} x="month" y="units" />
</Chart>
