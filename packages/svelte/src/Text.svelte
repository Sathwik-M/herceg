<!-- Text labels, constant or one per row of `data`. -->
<script lang="ts" generics="T = undefined">
  import { type Schema, type Table, type TextDataOptions, type TextOptions, text } from "herceg";
  import { built, markAnchor, panelled, plain, type TextProps } from "./marks.js";

  let { data, ...options }: TextProps<T> = $props();
  const inPanel = panelled("Text");
  const mark = $derived(
    built(() =>
      data
        ? text(data as unknown as Table, inPanel(plain(options)) as TextDataOptions<Schema>)
        : text(inPanel(plain(options)) as TextOptions),
    ),
  );
  const anchor = markAnchor("Text", () => mark);
</script>

<template {@attach anchor}></template>
