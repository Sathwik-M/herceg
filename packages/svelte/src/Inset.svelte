<!--
  A panel drawn over its parent <Panel>'s plot (or another inset's), at
  `place` and `width` by `height` (the top right, 35%, by default), with
  scales of its own: its settings, and the marks, legends, and insets drawn
  in it as children.
-->
<script lang="ts">
  import type { InsetOptions, PanelDefinition } from "herceg/layout";
  import type { Snippet } from "svelte";
  import { chartOf, providePanel } from "./marks.js";
  import { layoutAnchor } from "./place.js";

  let {
    children,
    ...props
  }: PanelDefinition & Omit<InsetOptions, "panel" | "insets"> & { children?: Snippet } = $props();
  // Without an id, named by its place among the panels declared.
  const generated = `panel-${chartOf("Inset").nextPanel()}`;
  const id = $derived(props.id ?? generated);
  providePanel({
    get id() {
      return id;
    },
    where: "<Inset>",
  });
  const anchor = layoutAnchor("Inset", () => ({ ...props, id }));
</script>

<div {@attach anchor}>{@render children?.()}</div>
