<!--
  Rows and columns of tracks holding <Cell> components, which may span
  tracks; or holding panels and grids that fill it row by row (with as many
  rows as they need when `rows` is left out).
-->
<script lang="ts">
  import type { GridOptions, Tracks } from "herceg/layout";
  import type { Snippet } from "svelte";
  import { providePanel } from "./marks.js";
  import { layoutAnchor } from "./place.js";

  let {
    children,
    ...props
  }: GridOptions & {
    rows?: Tracks | undefined;
    columns?: Tracks | undefined;
    children?: Snippet;
  } = $props();
  providePanel({ id: undefined, where: "<Grid>" });
  const anchor = layoutAnchor("Grid", () => props);
</script>

<div {@attach anchor}>{@render children?.()}</div>
