<!-- Text labels, constant or one per row of `data`. -->
<script lang="ts" generics="T = undefined">
  import { type Schema, type Table, type TextDataOptions, type TextOptions, text } from "herceg";
  import { markAnchor, plain, type TextProps } from "./marks.js";

  let { data, ...options }: TextProps<T> = $props();
  const mark = $derived(
    data
      ? text(data as unknown as Table, plain(options) as TextDataOptions<Schema>)
      : text(plain(options) as TextOptions),
  );
  const anchor = markAnchor("Text", () => mark);
</script>

<template {@attach anchor}></template>
