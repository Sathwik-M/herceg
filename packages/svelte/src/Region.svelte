<!-- Shaded x or y ranges, constant or one per row of `data`. -->
<script lang="ts" generics="T = undefined">
  import {
    type RegionDataOptions,
    type RegionOptions,
    region,
    type Schema,
    type Table,
  } from "herceg";
  import { built, markAnchor, panelled, plain, type RegionProps } from "./marks.js";

  let { data, ...options }: RegionProps<T> = $props();
  const inPanel = panelled("Region");
  const mark = $derived(
    built(() =>
      data
        ? region(data as unknown as Table, inPanel(plain(options)) as RegionDataOptions<Schema>)
        : region(inPanel(plain(options)) as RegionOptions),
    ),
  );
  const anchor = markAnchor("Region", () => mark);
</script>

<template {@attach anchor}></template>
