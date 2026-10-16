<!-- A cell of a <Grid>: at `row` and `column` (from 0), spanning `rowSpan` and `columnSpan` tracks; it holds one <Panel>, <Columns>, <Rows>, or <Grid>. -->
<script lang="ts">
  import type { Snippet } from "svelte";
  import { providePanel } from "./marks.js";
  import { layoutAnchor } from "./place.js";

  let {
    children,
    ...props
  }: {
    row: number;
    column: number;
    rowSpan?: number | undefined;
    columnSpan?: number | undefined;
    children?: Snippet;
  } = $props();
  providePanel({ id: undefined, where: "<Cell>" });
  const anchor = layoutAnchor("Cell", () => props);
</script>

<div {@attach anchor}>{@render children?.()}</div>
