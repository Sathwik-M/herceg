<!-- Cells side by side, as wide as `weights` say (equal by default): a <Panel>, <Columns>, <Rows>, or <Grid> each. -->
<script lang="ts">
  import type { GridOptions, Tracks } from "herceg/layout";
  import type { Snippet } from "svelte";
  import { providePanel } from "./marks.js";
  import { layoutAnchor } from "./place.js";

  let { children, ...props }: GridOptions & { weights?: Tracks | undefined; children?: Snippet } =
    $props();
  providePanel({ id: undefined, where: "<Columns>" });
  const anchor = layoutAnchor("Columns", () => props);
</script>

<div {@attach anchor}>{@render children?.()}</div>
