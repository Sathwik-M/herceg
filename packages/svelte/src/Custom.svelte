<!-- A custom mark: `draw` places shapes with the chart's scales, without `data` or over the fields of `data`. -->
<script lang="ts" generics="T = undefined">
  import {
    type CustomDataOptions,
    type CustomOptions,
    custom,
    type Schema,
    type Table,
  } from "herceg";
  import { built, type CustomProps, markAnchor, plain } from "./marks.js";

  let { data, ...options }: CustomProps<T> = $props();
  const mark = $derived(
    built(() =>
      data
        ? custom(data as unknown as Table, plain(options) as CustomDataOptions<Schema>)
        : custom(plain(options) as CustomOptions),
    ),
  );
  const anchor = markAnchor("Custom", () => mark);
</script>

<template {@attach anchor}></template>
