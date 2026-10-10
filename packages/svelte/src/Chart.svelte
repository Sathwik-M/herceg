<!--
  A herceg chart. Props are applied with `chart.update` when they change;
  data changes made on a table (append, replace, reset) re-render the chart
  directly, without Svelte.
-->
<script lang="ts">
  import {
    type ChartEvents,
    type ChartListener,
    type ChartMark,
    type ChartOptions,
    type ChartUpdate,
    createChart,
    type Chart as HercegChart,
  } from "herceg";
  import { untrack } from "svelte";
  import { type ChartProps, canonical, sameMark } from "./chart.js";
  import { type MarkEntry, plain, provideMarks } from "./marks.js";

  let {
    marks = [],
    children,
    class: className,
    style = "",
    chart = $bindable(null),
    onviewport,
    onselect,
    onhover,
    onclick,
    onrowselection,
    oncamera,
    onvisibility,
    onrender,
    ...options
  }: ChartProps = $props();

  type Options = Omit<ChartUpdate, "marks">;

  /** What the chart shows, to skip updates when nothing changed. */
  interface View {
    marks: readonly ChartMark[];
    options: Options;
    key: string;
  }

  let container: HTMLDivElement;
  let current = $state.raw<HercegChart | null>(null);
  let applied: View | undefined;

  /** Mounted mark components, in the order they were added. */
  let entries = $state.raw<MarkEntry[]>([]);
  provideMarks({
    add: (entry) => {
      entries = [...untrack(() => entries), entry];
    },
    remove: (entry) => {
      entries = untrack(() => entries).filter((other) => other !== entry);
    },
  });

  const byPosition = (a: MarkEntry, b: MarkEntry) =>
    a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;

  /** Holds the mark components' anchors. */
  let anchors: HTMLDivElement;
  /** Counts anchor moves: a keyed `{#each}` reorders marks without changing any. */
  let moves = $state(0);
  $effect(() => {
    const observer = new MutationObserver(() => moves++);
    observer.observe(anchors, { childList: true, subtree: true });
    return () => observer.disconnect();
  });

  /** What the props describe; reading every option and mark tracks each one. */
  const described: View = $derived.by(() => {
    void moves;
    const view = plain(options) as Options;
    const next = [...marks, ...entries.toSorted(byPosition).map((entry) => entry.mark)];
    return { marks: next, options: view, key: canonical(view) };
  });

  // The chart is created before its handlers subscribe, and updated after
  // they do (below), so events an update emits reach a handler given with it.
  $effect(() => {
    untrack(() => create(described));
  });

  /**
   * Subscribes to a chart event while a handler is given. The current
   * handler is called, so passing a new function does not resubscribe.
   */
  function listen<K extends keyof ChartEvents>(
    type: K,
    handler: () => ChartListener<K> | undefined,
  ): void {
    const given = $derived(handler() !== undefined);
    $effect(() => {
      if (given && current) return current.on(type, (event) => handler()?.(event));
    });
  }
  listen("viewport", () => onviewport);
  listen("select", () => onselect);
  listen("hover", () => onhover);
  listen("click", () => onclick);
  listen("rowSelection", () => onrowselection);
  listen("camera", () => oncamera);
  listen("visibility", () => onvisibility);
  listen("render", () => onrender);

  $effect(() => {
    const view = described;
    untrack(() => show(view));
  });

  function create(view: View) {
    // Options given as undefined take their defaults, as if left out.
    const given = Object.entries(view.options).filter(([, value]) => value !== undefined);
    current = createChart(container, {
      ...(Object.fromEntries(given) as Omit<ChartOptions, "marks">),
      marks: view.marks,
    });
    chart = current;
    applied = view;
  }

  /** Brings the chart up to date with the props. */
  function show(view: View) {
    const last = applied;
    if (!current || !last) return;
    // Unchanged marks keep their identity, so their caches survive.
    const next = view.marks.map((mark, i) => {
      const previous = last.marks[i];
      return previous && sameMark(mark, previous) ? previous : mark;
    });
    const sameMarks =
      next.length === last.marks.length && next.every((mark, i) => mark === last.marks[i]);
    if (sameMarks && view.key === last.key) return;
    // Props are the whole configuration: options no longer passed go back
    // to their defaults rather than keeping their previous values.
    const cleared = Object.keys(last.options).filter((key) => !(key in view.options));
    const reset = Object.fromEntries(cleared.map((key) => [key, undefined]));
    applied = { ...view, marks: next };
    current.update({ ...reset, ...view.options, marks: next });
  }

  // The first frame was drawn as the chart was created: `onrender` hears of
  // it once the handlers have subscribed.
  $effect(() => {
    if (current) untrack(() => onrender?.({}));
  });

  $effect(() => () => {
    current?.destroy();
    current = null;
    chart = null;
  });

  const size = (value: number | undefined, fallback: string) =>
    value === undefined ? fallback : `${value}px`;
</script>

<div
  bind:this={container}
  class={className}
  style="width: {size(options.width, '100%')}; height: {size(options.height, '320px')}; {style}"
>
  <!-- Mark components render only empty anchors, kept out of the layout. -->
  <div bind:this={anchors} hidden>{@render children?.()}</div>
</div>
