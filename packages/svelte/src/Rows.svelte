<!-- Cells from the top down, as tall as `weights` say (equal by default): a <Panel>, <Columns>, <Rows>, or <Grid> each. -->
<script lang="ts">
  import type { GridOptions, Tracks } from "herceg/layout";
  import type { Snippet } from "svelte";
  import { providePanel } from "./marks.js";
  import { layoutAnchor } from "./place.js";

  let { children, ...props }: GridOptions & { weights?: Tracks | undefined; children?: Snippet } =
    $props();
  providePanel({ id: undefined, where: "<Rows>" });
  const anchor = layoutAnchor("Rows", () => props);
</script>

<div {@attach anchor}>{@render children?.()}</div>
