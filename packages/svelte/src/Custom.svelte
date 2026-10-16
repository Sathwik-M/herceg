<!-- A custom mark: `draw` places shapes with the chart's scales, without `data` or over the fields of `data`. -->
<script lang="ts" generics="T = undefined">
  import {
    type CustomDataOptions,
    type CustomOptions,
    custom,
    type Schema,
    type Table,
  } from "herceg";
  import { built, type CustomProps, markAnchor, panelled, plain } from "./marks.js";

  let { data, ...options }: CustomProps<T> = $props();
  const inPanel = panelled("Custom");
  const mark = $derived(
    built(() =>
      data
        ? custom(data as unknown as Table, inPanel(plain(options)) as CustomDataOptions<Schema>)
        : custom(inPanel(plain(options)) as CustomOptions),
    ),
  );
  const anchor = markAnchor("Custom", () => mark);
</script>

<template {@attach anchor}></template>
