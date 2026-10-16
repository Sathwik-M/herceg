<!--
  A panel: its settings (`id`, `title`, `x`, `y`, ...; the id may be left
  out), with the marks, legends, and insets drawn in it as children. Marks
  take its id as their `panel`.
-->
<script lang="ts">
  import type { PanelDefinition } from "herceg/layout";
  import type { Snippet } from "svelte";
  import { chartOf, providePanel } from "./marks.js";
  import { layoutAnchor } from "./place.js";

  let { children, ...props }: PanelDefinition & { children?: Snippet } = $props();
  // Without an id, named by its place among the panels declared.
  const generated = `panel-${chartOf("Panel").nextPanel()}`;
  const id = $derived(props.id ?? generated);
  providePanel({
    get id() {
      return id;
    },
    where: "<Panel>",
  });
  const anchor = layoutAnchor("Panel", () => ({ ...props, id }));
</script>

<div {@attach anchor}>{@render children?.()}</div>
