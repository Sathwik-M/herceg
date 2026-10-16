<!--
  A herceg chart. Props are applied with `chart.update` when they change;
  data changes made on a table (append, replace, reset) re-render the chart
  directly, without Svelte.
-->
<script lang="ts">
  import {
    type ChartError,
    type ChartEvents,
    type ChartListener,
    type ChartMark,
    type ChartOptions,
    type ChartUpdate,
    chartError,
    createChart,
    type GuideOptions,
    type Chart as HercegChart,
    type Inspection,
    type RenderTooltip,
    showFailure,
  } from "herceg";
  import { untrack } from "svelte";
  import { type ChartProps, canonical, sameMark } from "./chart.js";
  import { type Entry, type LayoutEntry, plain, provideMarks } from "./marks.js";

  let {
    marks = [],
    children,
    class: className,
    style = "",
    chart = $bindable(null),
    initial,
    onviewport,
    onedge,
    onselect,
    onhover,
    onclick,
    onrowselection,
    oncamera,
    ondrill,
    onitemmove,
    onvisibility,
    onrender,
    onerror,
    renderTooltip,
    ...options
  }: ChartProps = $props();

  type Options = Omit<ChartUpdate, "marks">;

  // The server's markup, as the chart found it: shown in a host of its own
  // until the chart takes it over.
  const snapshot = untrack(() => initial);
  if (snapshot && typeof snapshot.hydrate !== "function")
    throw new TypeError(
      "Chart initial: expected hydration(snapshot), from herceg, of what renderToSnapshot wrote; pass the snapshot through it",
    );
  let snapshotHost = $state<HTMLDivElement>();

  /** What the tooltip is at, which the `renderTooltip` snippet renders into `tooltipHost`. */
  let shown = $state.raw<Inspection | null>(null);
  let tooltipHost = $state<HTMLDivElement>();
  /** The chart's `renderTooltip` with the snippet: it shows the snippet's element. */
  const showTooltip: RenderTooltip = (inspection) => {
    shown = inspection;
    return tooltipHost;
  };
  // A snippet given again starts empty, until the chart shows what it is at.
  $effect.pre(() => {
    if (!renderTooltip) shown = null;
  });

  /** What the chart shows, to skip updates when nothing changed; with what refused its marks. */
  interface View {
    marks: readonly ChartMark[];
    options: Options;
    key: string;
    refused?: ChartError | undefined;
  }

  /** With errorMode "throw", what kept the chart from drawing, thrown in the template. */
  let thrown = $state.raw<ChartError | null>(null);
  const raise = (error: ChartError): never => {
    throw error;
  };
  /** The chart's `onError`: stable, so options compare equal across updates. */
  const report = (error: ChartError) => {
    onerror?.(error);
    if (untrack(() => options.errorMode) === "throw") thrown = error;
  };
  /** What says why the last marks were refused, and of which error. */
  let refusal: { element: HTMLElement; message: string } | undefined;

  let container: HTMLDivElement;
  let current = $state.raw<HercegChart | null>(null);
  let applied: View | undefined;

  /** Mounted mark, guide, and layout components, in the order they were added. */
  let entries = $state.raw<Entry[]>([]);
  /** Panel and inset components made so far, which name those without ids by their place. */
  let declared = 0;
  provideMarks({
    add: (entry) => {
      entries = [...untrack(() => entries), entry];
    },
    remove: (entry) => {
      entries = untrack(() => entries).filter((other) => other !== entry);
    },
    nextPanel: () => ++declared,
  });

  const byPosition = (a: Entry, b: Entry) =>
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
    const view = { ...(plain(options) as Options), onError: report };
    // Components refused (an unknown field) leave the chart as it was, saying why.
    const next: ChartMark[] = [...marks];
    const guides: GuideOptions[] = [];
    const layouts: LayoutEntry[] = [];
    let refused: ChartError | undefined;
    const refuse = (error: unknown) => {
      if (view.errorMode === "throw") throw error;
      refused ??= chartError(error, "validate");
    };
    for (const entry of entries.toSorted(byPosition)) {
      if ("kind" in entry) layouts.push(entry);
      else if ("mark" in entry) {
        if ("refused" in entry.mark) refuse(entry.mark.refused);
        else next.push(entry.mark);
      } else if ("refused" in entry.guide) refuse(entry.guide.refused);
      else guides.push(entry.guide);
    }
    // Layout components make the chart's panels.
    try {
      if (layouts[0]) view.panels = layouts[0].place(layouts, view.panels);
    } catch (error) {
      refuse(error);
    }
    if (guides.length > 0) view.guides = [...(view.guides ?? []), ...guides];
    // The tooltip's renderer is the chart's own, calling the prop: the key
    // says whether there is one.
    const rendered = renderTooltip !== undefined;
    return {
      marks: next,
      options: rendered ? { ...view, renderTooltip: showTooltip } : view,
      key: `${canonical(view)}${rendered ? " rendered tooltip" : ""}`,
      refused,
    };
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
  listen("edge", () => onedge);
  listen("select", () => onselect);
  listen("hover", () => onhover);
  listen("click", () => onclick);
  listen("rowSelection", () => onrowselection);
  listen("camera", () => oncamera);
  listen("drill", () => ondrill);
  listen("itemMove", () => onitemmove);
  listen("visibility", () => onvisibility);
  listen("render", () => onrender);

  $effect(() => {
    const view = described;
    untrack(() => show(view));
  });

  /**
   * Says why mark components were refused: over the chart, or in its place
   * before there is one; nothing once they are built again.
   */
  function refuse(error: ChartError | undefined) {
    if (refusal && refusal.message === error?.message) return;
    refusal?.element.remove();
    refusal = undefined;
    if (!error) return;
    const box = container.getBoundingClientRect();
    const element = current
      ? showFailure(current.root, error, true)
      : showFailure(container, error, false, {
          width: options.width ?? (box.width || 640),
          height: options.height ?? (box.height || 320),
        });
    refusal = { element, message: error.message };
    onerror?.(error);
  }

  function create(view: View) {
    refuse(view.refused);
    if (view.refused) return;
    // Options given as undefined take their defaults, as if left out.
    const given = Object.entries(view.options).filter(([, value]) => value !== undefined);
    const config = {
      ...(Object.fromEntries(given) as Omit<ChartOptions, "marks">),
      marks: view.marks,
    };
    current = snapshot ? snapshot.hydrate(snapshotHost!, config) : createChart(container, config);
    chart = current;
    applied = view;
  }

  /** Brings the chart up to date with the props. */
  function show(view: View) {
    refuse(view.refused);
    if (view.refused) return;
    const last = applied;
    if (!current || !last) {
      if (!current) create(view);
      return;
    }
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
  {#if snapshot}
    <!-- The server's markup, which the chart takes over. -->
    <div bind:this={snapshotHost} style="width: 100%; height: 100%">{@html snapshot.snapshot.html}</div>
  {/if}
  <!-- Mark components render only empty anchors, kept out of the layout. -->
  <div bind:this={anchors} hidden>{@render children?.()}</div>
  {#if thrown}{raise(thrown)}{/if}
  <!-- The chart shows this in its tooltip's box. -->
  {#if renderTooltip}
    <div bind:this={tooltipHost}>{#if shown}{@render renderTooltip(shown)}{/if}</div>
  {/if}
</div>
