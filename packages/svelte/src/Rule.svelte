<!-- Horizontal (`y`) or vertical (`x`) reference lines, constant or one per row of `data`. -->
<script lang="ts" generics="T = undefined">
  import { type RuleDataOptions, type RuleOptions, rule, type Schema, type Table } from "herceg";
  import { built, markAnchor, panelled, plain, type RuleProps } from "./marks.js";

  let { data, ...options }: RuleProps<T> = $props();
  const inPanel = panelled("Rule");
  const mark = $derived(
    built(() =>
      data
        ? rule(data as unknown as Table, inPanel(plain(options)) as RuleDataOptions<Schema>)
        : rule(inPanel(plain(options)) as RuleOptions),
    ),
  );
  const anchor = markAnchor("Rule", () => mark);
</script>

<template {@attach anchor}></template>
