// Legends the chart's settings and guides ask for beyond the automatic one:
// legends of the scales they name, laid out in columns or rows under a
// title, with entries of your own, swatches drawn as the marks look, and
// one entry for the series several marks show of the same value. Each
// legend claims the scales it shows; the automatic legend shows the rest.

import type { SeriesSwatch } from "../model/features.ts";
import type { GuideKit, PlacedLegend } from "../model/guides.ts";
import type { MarkSeries } from "../model/inspect.ts";
import type {
  HiddenKeys,
  LegendContent,
  LegendEntry,
  LegendFlow,
  LegendFlowItem,
  LegendOut,
  LegendPart,
  LegendText,
  MeasuredLegend,
} from "../model/legend.ts";
import type { ChartConfig } from "../model/model.ts";
import type { CaptionGuide, Guide, GuideItem, LegendGuide, LegendItem } from "../scene/scene.ts";
import type { Place } from "../spec/place.ts";
import type {
  Dash,
  LegendEntrySpec,
  LegendOptionsSpec,
  LegendStyles,
  ScaleRef,
  SwatchSpec,
} from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { type ColorbarPlan, measureColorbar, plannedColorbars } from "./colorbars.ts";
import { type Read, restyle } from "./paints.ts";

/** The square swatch, as the automatic legend draws it, and a line sample's length. */
const SWATCH = 10;
const LINE = 16;
/** Pixels between a swatch and its label, between entries in a row, and between rows. */
const LABEL_GAP = 6;
const ENTRY_GAP = 16;
const ROW_GAP = 4;
/** Opacity of a hidden entry's swatch and label, as the automatic legend fades them. */
const HIDDEN = 0.4;

/** A legend the configuration asks for, resolved. */
interface Plan {
  key: string;
  place: Place;
  options: LegendOptionsSpec;
  /** The scales it shows; undefined for what no other legend claims (the automatic one) or for all. */
  sources: readonly ScaleRef[] | undefined;
  automatic: boolean;
  /** For the automatic legend: whether the chart sets `legend`, so that it shows even one entry. */
  explicit: boolean;
  /** Where its settings are, for messages. */
  path: string;
}

/**
 * The legends and colorbars of `config`, where it asks for more than the
 * automatic legend; undefined where it does not.
 */
export function plannedLegends(
  config: ChartConfig,
): { legends: Plan[]; colorbars: ColorbarPlan[]; layouts: ReadonlySet<string> } | undefined {
  const { legend } = config;
  const listed = (config.guides ?? []).flatMap((guide, i) =>
    guide.type === "legend" && guide.show !== false ? [{ guide, i }] : [],
  );
  const options = typeof legend === "object" ? legend : {};
  const layout = Object.keys(options).some((key) => key !== "place" && key !== "style");
  const colorbars = plannedColorbars(config.guides);
  if (listed.length === 0 && !layout && colorbars.length === 0) return undefined;
  const plans: Plan[] = listed.map(({ guide, i }) => ({
    key: guide.id !== undefined ? `legend|id|${guide.id}` : `legend|${i}`,
    place: guide.place ?? { side: "top" },
    options: guide,
    sources: guide.scales,
    automatic: false,
    explicit: true,
    path: `chart guides[${i}]`,
  }));
  if (legend !== false)
    plans.unshift({
      key: "legend",
      place: options.place ?? { side: "top" },
      options,
      sources: undefined,
      automatic: true,
      explicit: legend !== undefined,
      path: "chart legend",
    });
  // Layout marks (maps, pies), which legends and colorbars do not name yet.
  const layouts = new Set(
    config.marks.flatMap((mark) =>
      (mark as { layout?: boolean }).layout === true && mark.spec.id !== undefined
        ? [mark.spec.id]
        : [],
    ),
  );
  return { legends: plans, colorbars, layouts };
}

/** The legends of `plans`, measured as the model asks (see `CompiledGuides.legends`). */
export function compiledLegends(
  kit: GuideKit,
  {
    legends: plans,
    colorbars,
    layouts,
  }: { legends: readonly Plan[]; colorbars: readonly ColorbarPlan[]; layouts: ReadonlySet<string> },
) {
  return (
    content: LegendContent,
    text: LegendText,
    flow: (place: Place) => LegendFlow,
    marks: readonly MarkSeries[],
    theme: Theme,
    chart: { readonly width: number; readonly height: number },
  ): PlacedLegend[] => {
    const owners = ownersOf(marks, content);
    const partsOf = partOwners(kit, marks, theme, text.locale);
    const named = (ref: ScaleRef, path: string) => {
      if (layouts.has(ref.mark))
        throw new Error(
          `${path}: mark "${ref.mark}" draws its own layout, whose scales the automatic legend shows; drop the reference`,
        );
      if (!marks.some(({ mark }) => mark.spec.id === ref.mark))
        throw new Error(`${path}: no mark has id "${ref.mark}"; give the mark id: "${ref.mark}"`);
    };
    // Colorbars claim the color scales they show from every legend.
    const barred = new Set<string>();
    const bars = colorbars.map((plan): PlacedLegend => {
      if (plan.scale) named(plan.scale, `${plan.path}.scale`);
      const part = colorbarPart(plan, partsOf, content.parts);
      barred.add(part.key);
      return {
        key: plan.key,
        place: plan.place,
        measured: measureColorbar(kit, plan, part.colorbar!, text, theme, chart),
      };
    });
    // What the listed legends show, which the automatic one leaves to them.
    const claimed = new Set<string>();
    const all = plans.some((plan) => !plan.automatic && !plan.sources);
    for (const plan of plans)
      plan.sources?.forEach((ref, k) => {
        named(ref, `${plan.path}.scales[${k}]`);
        claimed.add(`${ref.mark}|${ref.channel}`);
      });
    return plans
      .map((plan): PlacedLegend => {
        // What a listed legend shows, of what marks own (an entry, a part
        // marks share): the automatic legend shows what none of them claims.
        const shows = (owned: readonly { mark: string | number; channel: string }[]) =>
          plan.automatic
            ? !all && !owned.some(({ mark, channel }) => claimed.has(`${mark}|${channel}`))
            : !plan.sources ||
              owned.some(({ mark, channel }) =>
                plan.sources!.some((ref) => ref.mark === mark && ref.channel === channel),
              );
        let entries = content.entries.filter((entry) =>
          shows((owners.get(entry.key) ?? [""]).map((mark) => ({ mark, channel: "series" }))),
        );
        // Without an explicit setting, a chart of one series needs no automatic legend.
        if (!plan.explicit && content.entries.length < 2) entries = [];
        const parts = content.parts.filter((part) => {
          const shared = partsOf.get(part.key);
          return !barred.has(part.key) && (!shared || shows(shared.owners));
        });
        const { options } = plan;
        // An automatic legend without layout settings is the default legend's.
        const plain =
          plan.automatic && !Object.keys(options).some((k) => k !== "place" && k !== "style");
        const measured = plain
          ? kit.measureLegends({ ...content, entries, parts }, text, flow(plan.place))
          : measureLegend(
              kit,
              plan,
              { entries, parts, hidden: content.hidden },
              text,
              flow(plan.place),
              marks,
              owners,
              theme,
            );
        return { key: plan.key, place: plan.place, measured, notes: notesOf(plan, measured) };
      })
      .concat(bars);
  };
}

/**
 * The legend part of the color scale a colorbar shows: of the mark its
 * `scale` names, or the chart's only one.
 */
function colorbarPart(
  plan: ColorbarPlan,
  owners: ReturnType<typeof partOwners>,
  shown: readonly LegendPart[],
): LegendPart {
  const ref = plan.scale;
  if (ref && ref.channel !== "color")
    throw new Error(
      `${plan.path}.scale.channel: a colorbar shows a color scale; give channel: "color"`,
    );
  const candidates = new Map<string, LegendPart>();
  for (const [key, shared] of owners)
    if (shared.part.colorbar && (!ref || shared.owners.some(({ mark }) => mark === ref.mark)))
      candidates.set(key, shared.part);
  // Layout marks' color scales (a choropleth's) are among the parts the chart shows.
  if (!ref) for (const part of shown) if (part.colorbar) candidates.set(part.key, part);
  const found = [...candidates.values()];
  if (found.length === 1) return found[0]!;
  if (ref)
    throw new Error(
      `${plan.path}.scale: mark "${ref.mark}" has no color scale a colorbar shows; color it by a number field, or name another mark`,
    );
  throw new Error(
    found.length === 0
      ? `${plan.path}: the chart has no color scale a colorbar shows; color a heatmap, contour, or points by a number field`
      : `${plan.path}.scale: the chart has ${found.length} color scales; name one, as scale: { mark: "id", channel: "color" }`,
  );
}

/** The marks (by id, or their index) each entry's series belong to. */
function ownersOf(
  marks: readonly MarkSeries[],
  content: LegendContent,
): Map<string, (string | number)[]> {
  const owners = new Map<string, (string | number)[]>();
  marks.forEach(({ mark, series }, index) => {
    const id = mark.spec.id ?? index;
    for (const s of series) {
      // Series of a legend group are listed under their group's key.
      const key = (content.hidden as Partial<HiddenKeys>).groups?.get(s.key) ?? s.key;
      const list = owners.get(key) ?? [];
      if (!list.includes(id)) list.push(id);
      owners.set(key, list);
    }
  });
  return owners;
}

/**
 * The marks and channels of each legend part (a color ramp, a key of
 * sizes, symbols, or colors): marks with the same scale share one part.
 */
function partOwners(
  kit: GuideKit,
  marks: readonly MarkSeries[],
  theme: Theme,
  locale: string | undefined,
) {
  const owners = new Map<
    string,
    { owners: { mark: string | number; channel: ScaleRef["channel"] }[]; part: LegendPart }
  >();
  const format = (value: number) => kit.formatNumber(value, locale);
  marks.forEach(({ mark, series }, index) => {
    // Marks left out of legends are left out of colorbars too.
    if (mark.spec.legend === false) return;
    for (const part of mark.legends?.(series, theme, format) ?? []) {
      // Keys of sizes and shapes say so; ramps and color keys show color.
      const channel: ScaleRef["channel"] =
        part.channel === "size" ? "size" : part.channel === "shape" ? "symbol" : "color";
      const owner = { mark: mark.spec.id ?? index, channel };
      const shared = owners.get(part.key);
      if (shared) shared.owners.push(owner);
      else owners.set(part.key, { owners: [owner], part });
    }
  });
  return owners;
}

/** A swatch's items about its left middle, and how wide and tall it is. */
type Sample = { width: number; height: number; items: GuideItem[] };

/** Marks that annotate, with no series: rules, regions, and text. */
const ANNOTATIONS: readonly string[] = ["rule", "region", "text"];

/** An entry as a legend with settings lays it out: what it says, its swatch, and what it toggles. */
interface Row {
  key: string;
  label: string;
  color: string;
  glyph?: string | undefined;
  stroke?: string | undefined;
  sample: Sample | undefined;
  /** The series keys it toggles; none for an entry that explains rather than toggles. */
  targets: readonly string[];
  hidden: boolean;
}

/** A legend with settings: its title, entries in a grid or rows, then its parts. */
function measureLegend(
  kit: GuideKit,
  plan: Plan,
  content: LegendContent,
  shared: LegendText,
  flow: LegendFlow,
  marks: readonly MarkSeries[],
  owners: Map<string, (string | number)[]>,
  theme: Theme,
): (MeasuredLegend & { explained: string[] }) | undefined {
  const { options, path } = plan;
  const text: LegendText = { ...shared, ...paints(kit, shared, options.style, `${path}.style`) };
  const { measure } = text;
  const rows = options.entries
    ? custom(kit, options.entries, marks, content, theme, path, text.read ?? ((given) => given))
    : derived(kit, options, content, marks, owners, theme);
  // Every entry's swatch takes the widest one's room, and its row the tallest's.
  const swatch = Math.max(SWATCH, ...rows.map((row) => row.sample?.width ?? 0));
  const entryHeight = Math.max(
    text.lineHeight,
    kit.textHeight(text.label),
    ...rows.map((row) => row.sample?.height ?? 0),
  );
  const widths = rows.map(
    (row) => swatch + LABEL_GAP + kit.textWidth(row.label, text.label, measure),
  );
  // Where each entry goes: in a grid of fixed columns or rows, or in rows
  // flowing as the automatic legend's do.
  // A count of rows fills down each column, unless `order` says otherwise.
  const slots =
    options.columns || options.rows
      ? gridSlots(widths, options, options.order ?? (options.columns ? "row" : "column"))
      : flowSlots(widths, flow.wrap);
  const entryRows = Math.max(0, ...slots.map(({ row }) => row + 1));
  const gridWidth = Math.max(0, ...slots.map(({ x }, k) => x + widths[k]!));
  const title = typeof options.title === "string" ? { text: options.title } : options.title;
  const titlePaint = restyle(
    kit,
    text.read ?? ((given) => given),
    text.title,
    title?.style,
    `${path}.title.style`,
  );
  const titleHeight = title ? kit.textHeight(titlePaint) : 0;
  const entriesHeight = entryRows ? entryRows * entryHeight + (entryRows - 1) * ROW_GAP : 0;
  // The parts (color ramps, keys) flow under the entries, each as its flow items say.
  const out: LegendOut = { guides: [], finish: [] };
  // Keys' entries take the legend's grid too, under their titles; ramps flow.
  const order = options.order ?? (options.columns ? "row" : "column");
  const grid = options.columns || options.rows;
  const itemsOf = content.parts.map((part) => ({ part, items: part.items(text, out) }));
  const partItems = itemsOf.flatMap(({ items }) => items);
  const partRows = grid
    ? itemsOf.flatMap(({ part, items }) =>
        part.channel !== undefined ? keyRows(items, options, order) : flowRows(items, flow.wrap),
      )
    : flowRows(partItems, flow.wrap);
  const partsHeight = partRows.reduce(
    (sum, row) => sum + row.height,
    (partRows.length - 1) * ROW_GAP,
  );
  const blocks = [titleHeight, entriesHeight, partRows.length ? partsHeight : 0].filter(
    (h) => h > 0,
  );
  const width = Math.max(
    gridWidth,
    title ? kit.textWidth(title.text, titlePaint, measure) : 0,
    ...partRows.map((row) => row.width),
  );
  const height = blocks.reduce((sum, h) => sum + h, (blocks.length - 1) * ROW_GAP);
  if (rows.length === 0 && partItems.length === 0) return undefined;
  return {
    width,
    height,
    explained: rows.filter((row) => row.targets.length === 0).map((row) => row.label),
    place(x, y, surface) {
      if (surface !== undefined) text.surface = surface;
      const guides: Guide[] = [];
      const caption: GuideItem[] = [];
      if (title)
        caption.push(
          kit.textItem(
            title.text,
            {
              x,
              y: y + kit.textHeight(titlePaint) / 2,
              anchor: "start",
              baseline: "middle",
              angle: 0,
            },
            titlePaint,
            text.surface,
            measure,
          ),
        );
      const top = y + (titleHeight && titleHeight + ROW_GAP);
      const entries: LegendItem[] = [];
      rows.forEach((row, k) => {
        const slot = slots[k]!;
        const ex = x + slot.x;
        const ey = top + slot.row * (entryHeight + ROW_GAP) + entryHeight / 2;
        const item: LegendItem = {
          key: row.key,
          label: row.label,
          color: row.color,
          hidden: row.hidden,
          x: ex,
          y: ey,
          ...(row.glyph && { glyph: row.glyph }),
          ...(row.stroke && { stroke: row.stroke }),
          ...(row.sample && { sample: { ...row.sample, width: swatch } }),
        };
        if (row.targets.length > 0) {
          if (row.targets.length !== 1 || row.targets[0] !== row.key) item.targets = row.targets;
          entries.push(item);
        } else caption.push(...entryItems(kit, item, swatch, text));
      });
      if (caption.length > 0)
        guides.push({
          kind: "caption",
          key: `${plan.key}|caption`,
          items: caption,
        } satisfies CaptionGuide);
      if (entries.length > 0) {
        let items: GuideItem[] | undefined;
        guides.push({
          kind: "legend",
          key: plan.key,
          entries,
          label: text.label,
          halo: kit.textHalo(text.label, text.surface),
          get items() {
            items ??= entries.flatMap((entry) => entryItems(kit, entry, swatch, text));
            return items;
          },
        } satisfies LegendGuide);
      }
      let py = top + entriesHeight + (entriesHeight ? ROW_GAP : 0);
      for (const row of partRows) {
        for (const { item, at } of row.cells) item.place(x + at, py + row.height / 2);
        py += row.height + ROW_GAP;
      }
      for (const finish of out.finish) finish();
      guides.push(...out.guides);
      return guides;
    },
  };
}

/**
 * Sentences for what a legend draws that is not a button, which assistive
 * technology does not see: its entries that explain rather than toggle.
 */
function notesOf(plan: Plan, measured: MeasuredLegend | undefined): string[] {
  const explained = (measured as { explained?: string[] } | undefined)?.explained ?? [];
  if (explained.length === 0) return [];
  const title = plan.options.title;
  const name = typeof title === "string" ? title : (title?.text ?? "The legend");
  return [`${name}: ${explained.join(", ")}.`];
}

/** The legend's text paints with its own style, set at `path`, over the chart's. */
function paints(kit: GuideKit, text: LegendText, style: LegendStyles | undefined, path: string) {
  const read = text.read ?? ((given) => given);
  return {
    label: restyle(kit, read, text.label, style?.legendLabel, `${path}.legendLabel`),
    title: restyle(kit, read, text.title, style?.legendTitle, `${path}.legendTitle`),
    value: restyle(kit, read, text.value, style?.tickLabel, `${path}.tickLabel`),
  };
}

/**
 * The legend's entries from the scales it shows: a series' each, or with
 * `merge: "semantic"` one for the series of every mark that show the same
 * value of the same field (or have the same name), toggling them together.
 */
function derived(
  kit: GuideKit,
  options: LegendOptionsSpec,
  content: LegendContent,
  marks: readonly MarkSeries[],
  owners: Map<string, (string | number)[]>,
  theme: Theme,
): Row[] {
  const markOf = (key: string) => {
    const owner = owners.get(key)?.[0];
    return marks.find(({ mark }, index) => (mark.spec.id ?? index) === owner)?.mark;
  };
  const rows: Row[] = [];
  const merged = new Map<string, Row>();
  for (const entry of content.entries) {
    const mark = markOf(entry.key);
    // A series styled by the feature compiler says how it looks.
    const own =
      options.swatches === "mark" &&
      marks
        .flatMap(({ series }) => series)
        .find((s) => s.key === entry.key)
        ?.features?.swatch?.(theme);
    const sample = own
      ? swatchItems(kit, own)
      : options.swatches === "mark"
        ? sampleOf(kit, mark?.spec, entry, theme)
        : undefined;
    const row: Row = {
      key: entry.key,
      label: entry.label,
      color: entry.color,
      glyph: entry.glyph,
      stroke: entry.stroke,
      sample,
      targets: [entry.key],
      hidden: content.hidden.has(entry.key),
    };
    if (options.merge !== "semantic") {
      rows.push(row);
      continue;
    }
    // Series name the same thing when they show one value of one field, or share a name.
    const field = (mark?.spec as { series?: string } | undefined)?.series ?? "";
    const identity = JSON.stringify([field, entry.label]);
    const same = merged.get(identity);
    if (!same) {
      const first = { ...row, key: JSON.stringify({ legend: [field, entry.label] }) };
      merged.set(identity, first);
      rows.push(first);
      continue;
    }
    same.targets = [...same.targets, entry.key];
    same.hidden = same.hidden && row.hidden;
    // Marks drawing it differently each show their look.
    if (
      same.sample &&
      sample &&
      !same.sample.items.every(
        (item, k) => JSON.stringify(item) === JSON.stringify(sample.items[k]),
      )
    )
      same.sample = {
        width: Math.max(same.sample.width, sample.width),
        height: Math.max(same.sample.height, sample.height),
        items: [...same.sample.items, ...sample.items],
      };
  }
  // Merged entries hidden only when all their series are.
  for (const row of rows) row.hidden = row.targets.every((key) => content.hidden.has(key));
  return rows;
}

/** Entries of your own: explaining a swatch, or a mark's look, and toggling the marks they target. */
function custom(
  kit: GuideKit,
  specs: readonly LegendEntrySpec[],
  marks: readonly MarkSeries[],
  content: LegendContent,
  theme: Theme,
  path: string,
  read: Read,
): Row[] {
  const find = (id: string, where: string) => {
    const found = marks.find(({ mark }) => mark.spec.id === id);
    if (!found) throw new Error(`${where}: no mark has id "${id}"; give the mark id: "${id}"`);
    return found;
  };
  return specs.map((spec, k) => {
    const at = `${path}.entries[${k}]`;
    const targets = (spec.targets ?? []).flatMap(({ mark }, t) => {
      const where = `${at}.targets[${t}].mark`;
      const found = find(mark, where);
      if (ANNOTATIONS.includes(found.mark.spec.type))
        throw new Error(
          `${where}: mark "${mark}" is an annotation, which has no series to hide and show; target marks with series, or drop the target`,
        );
      return found.series.map((s) => s.key);
    });
    let sample: Row["sample"];
    let color = theme.muted;
    if (spec.swatch) sample = swatchItems(kit, readSwatch(read, spec.swatch, `${at}.swatch`));
    else if (spec.sample) {
      const { mark, series } = find(spec.sample.mark, `${at}.sample.mark`);
      // As the mark's own entries look: its first series' color, and a point's symbol.
      const s = series[0];
      const look = (s && mark.legendEntry?.(s, theme)) || (s && { color: s.color }) || undefined;
      color = look?.color ?? color;
      sample = sampleOf(
        kit,
        mark.spec,
        {
          key: spec.key,
          label: spec.label,
          color,
          ...(look?.glyph && { glyph: look.glyph }),
          ...(look?.stroke && { stroke: look.stroke }),
        },
        theme,
      );
    }
    return {
      key: spec.key,
      label: spec.label,
      color,
      sample: sample ?? swatchItems(kit, { type: "rect", fill: color }),
      targets,
      hidden: targets.length > 0 && targets.every((key) => content.hidden.has(key)),
    };
  });
}

/**
 * A series' swatch drawn as its mark draws it: a line of its width and
 * dash, a box of an area's or bar's fill, a point's symbol.
 */
function sampleOf(
  kit: GuideKit,
  spec: object | undefined,
  entry: LegendEntry,
  theme: Theme,
): Row["sample"] {
  const mark = (spec ?? {}) as {
    type?: string;
    fill?: string;
    stroke?: string;
    strokeWidth?: number;
    dash?: Dash;
    fillOpacity?: number;
    opacity?: number;
    stack?: unknown;
    y1?: unknown;
    y2?: unknown;
  };
  if (entry.glyph)
    return {
      width: SWATCH,
      height: SWATCH,
      items: [
        {
          type: "shape",
          d: entry.glyph,
          at: [SWATCH / 2, 0],
          fill: entry.color,
          ...(entry.stroke && { stroke: entry.stroke }),
        },
      ],
    };
  switch (mark.type) {
    case "line":
      return swatchItems(kit, {
        type: "line",
        stroke: entry.color,
        strokeWidth: mark.strokeWidth ?? theme.style.line.strokeWidth,
        ...(mark.dash !== undefined && { dash: mark.dash }),
      });
    // Annotations as they draw by default: a dashed muted rule, a faint region.
    case "rule":
      return swatchItems(kit, {
        type: "line",
        stroke: mark.stroke ?? theme.muted,
        strokeWidth: mark.strokeWidth ?? 1,
        dash: mark.dash ?? [4, 4],
      });
    case "region":
      return swatchItems(kit, {
        type: "rect",
        fill: mark.fill ?? theme.muted,
        opacity: mark.fillOpacity ?? 0.15,
      });
    case "area": {
      // As areas fill: stacks nearly opaque, bands and areas lighter.
      const banded = mark.y1 !== undefined || mark.y2 !== undefined;
      const opacity = mark.fillOpacity ?? (mark.stack ? 0.85 : banded ? 0.2 : 0.25);
      return swatchItems(kit, { type: "rect", fill: entry.color, opacity });
    }
    default:
      // Bars as they paint: outlined in their stroke, at their opacities.
      return swatchItems(kit, {
        type: "rect",
        fill: entry.color,
        ...(mark.type === "bar" && mark.stroke !== undefined && { stroke: mark.stroke }),
        ...(mark.fillOpacity !== undefined && { fillOpacity: mark.fillOpacity }),
        ...(mark.opacity !== undefined && { opacity: mark.opacity }),
      });
  }
}

/** A swatch with its colors read as the chart reads styles' (CSS variables from the page), `path` naming it. */
function readSwatch(read: Read, swatch: SwatchSpec, path: string): SwatchSpec {
  return swatch.type === "composite"
    ? {
        ...swatch,
        parts: swatch.parts.map((part, j) => readSwatch(read, part, `${path}.parts[${j}]`)),
      }
    : read(swatch, path);
}

/** A swatch's items about its left middle, and its size. */
function swatchItems(kit: GuideKit, swatch: SeriesSwatch): Sample {
  switch (swatch.type) {
    case "line": {
      const strokeWidth = swatch.strokeWidth ?? 2;
      return {
        width: LINE,
        height: Math.max(SWATCH, strokeWidth),
        items: [
          {
            type: "segments",
            coords: [0, 0, LINE, 0],
            paint: {
              stroke: swatch.stroke,
              strokeWidth,
              dash: kit.dashPattern(swatch.dash as Dash | undefined, strokeWidth) ?? [],
              opacity: swatch.opacity ?? 1,
            },
          },
        ],
      };
    }
    case "rect": {
      // The fill's opacity under the outline's; a box without one, both as one.
      const { fillOpacity, opacity } = swatch;
      const alpha =
        fillOpacity === undefined && opacity === undefined
          ? undefined
          : (fillOpacity ?? 1) * (opacity ?? 1);
      const h = SWATCH / 2;
      return {
        width: SWATCH,
        height: SWATCH,
        items: [
          // An outlined box is a shape, whose outline renderers draw.
          swatch.stroke
            ? {
                type: "shape",
                d: `M${-h},${-h}h${SWATCH}v${SWATCH}h${-SWATCH}z`,
                at: [h, 0],
                fill: swatch.fill,
                stroke: swatch.stroke,
                ...(fillOpacity !== undefined && { fillOpacity }),
                ...(opacity !== undefined && { opacity }),
              }
            : {
                type: "rect",
                x: 0,
                y: -h,
                width: SWATCH,
                height: SWATCH,
                radius: 2,
                fill: swatch.fill,
                ...(alpha !== undefined && { opacity: alpha }),
              },
        ],
      };
    }
    case "circle": {
      const size = swatch.size ?? SWATCH;
      const r = size / 2;
      return {
        width: Math.max(SWATCH, size),
        height: Math.max(SWATCH, size),
        items: [
          {
            type: "shape",
            d: `M${-r},0a${r},${r} 0 1,0 ${size},0a${r},${r} 0 1,0 ${-size},0`,
            at: [Math.max(SWATCH, size) / 2, 0],
            fill: swatch.fill,
            ...(swatch.stroke && { stroke: swatch.stroke }),
            ...(swatch.opacity !== undefined && { opacity: swatch.opacity }),
          },
        ],
      };
    }
    case "glyph": {
      const size = Math.max(SWATCH, swatch.size);
      return {
        width: size,
        height: size,
        items: [
          {
            type: "shape",
            d: swatch.d,
            at: [size / 2, 0],
            fill: swatch.fill,
            ...(swatch.stroke && { stroke: swatch.stroke }),
            ...(swatch.opacity !== undefined && { opacity: swatch.opacity }),
          },
        ],
      };
    }
    case "composite": {
      // Parts over one another, centered on the widest: a line with its marker on it.
      const parts = swatch.parts.map((part) => swatchItems(kit, part));
      const width = Math.max(...parts.map((part) => part.width));
      return {
        width,
        height: Math.max(...parts.map((part) => part.height)),
        items: parts.flatMap((part) =>
          part.items.map((item) => moved(item, (width - part.width) / 2, 0, undefined)),
        ),
      };
    }
  }
}

/** What static output draws of an entry: its swatch, sample, or glyph, then its label. */
function entryItems(
  kit: GuideKit,
  entry: LegendItem,
  swatch: number,
  text: LegendText,
): GuideItem[] {
  const opacity = entry.hidden ? HIDDEN : undefined;
  const items: GuideItem[] = [];
  const { sample, glyph } = entry;
  if (sample) for (const item of sample.items) items.push(moved(item, entry.x, entry.y, opacity));
  else if (glyph)
    items.push({
      type: "shape",
      d: glyph,
      at: [entry.x + SWATCH / 2, entry.y],
      fill: entry.color,
      stroke: entry.stroke,
      opacity,
    });
  else
    items.push({
      type: "rect",
      x: entry.x,
      y: entry.y - SWATCH / 2,
      width: SWATCH,
      height: SWATCH,
      radius: 2,
      fill: entry.color,
      opacity,
    });
  const label = kit.textItem(
    entry.label,
    { x: entry.x + swatch + LABEL_GAP, y: entry.y, anchor: "start", baseline: "middle", angle: 0 },
    text.label,
    text.surface,
    text.measure,
  );
  items.push(opacity === undefined ? label : { ...label, opacity });
  return items;
}

/** A swatch item moved to (x, y), faded by `opacity`. */
function moved(item: GuideItem, x: number, y: number, opacity: number | undefined): GuideItem {
  switch (item.type) {
    case "segments":
      return {
        ...item,
        coords: item.coords.map((c, k) => c + (k % 2 === 0 ? x : y)),
        ...(opacity !== undefined && {
          paint: { ...item.paint, opacity: item.paint.opacity * opacity },
        }),
      };
    case "shape":
      return {
        ...item,
        at: [item.at[0] + x, item.at[1] + y],
        ...(opacity !== undefined && { opacity: (item.opacity ?? 1) * opacity }),
      };
    case "rect":
      return {
        ...item,
        x: item.x + x,
        y: item.y + y,
        ...(opacity !== undefined && { opacity: (item.opacity ?? 1) * opacity }),
      };
    default:
      return item;
  }
}

/** Where an entry goes: pixels from the legend's left, and its row. */
interface Slot {
  x: number;
  row: number;
}

/**
 * Entries `widths` wide in a grid of `columns`, or of `rows`, each column as
 * wide as its widest entry, filled row by row or down each column. A grid
 * filled across the lines it was asked for (down each of three columns,
 * along each of three rows) spreads its entries evenly over them.
 */
function gridSlots(
  widths: readonly number[],
  { columns, rows }: { columns?: number | undefined; rows?: number | undefined },
  order: "row" | "column",
): Slot[] {
  const count = widths.length;
  const lines = Math.max(1, Math.min(columns ?? rows ?? 1, count));
  const along = columns !== undefined ? order === "row" : order === "column";
  const cells: [column: number, row: number][] = [];
  if (along) {
    // Columns filled row by row, or rows down each column: the other side follows.
    for (let k = 0; k < count; k++)
      cells.push(
        columns !== undefined
          ? [k % lines, Math.floor(k / lines)]
          : [Math.floor(k / lines), k % lines],
      );
  } else {
    const base = Math.floor(count / lines);
    const extra = count % lines;
    for (let line = 0; line < lines; line++)
      for (let at = 0; at < base + (line < extra ? 1 : 0); at++)
        cells.push(columns !== undefined ? [line, at] : [at, line]);
  }
  const across = Math.max(0, ...cells.map(([column]) => column + 1));
  const columnWidths = Array.from({ length: across }, (_, c) =>
    Math.max(0, ...widths.filter((_, k) => cells[k]![0] === c)),
  );
  const starts = columnWidths.map((_, c) =>
    columnWidths.slice(0, c).reduce((sum, w) => sum + w + ENTRY_GAP, 0),
  );
  return cells.map(([column, row]) => ({ x: starts[column]!, row }));
}

/** Entries `widths` wide in rows wrapping at `wrap`, or one per row, as the automatic legend flows them. */
function flowSlots(widths: readonly number[], wrap: number | undefined): Slot[] {
  const slots: Slot[] = [];
  let row = 0;
  let x = 0;
  widths.forEach((width, k) => {
    if (k > 0 && (wrap === undefined || x + width > wrap)) {
      row++;
      x = 0;
    }
    slots.push({ x, row });
    x += width + ENTRY_GAP;
  });
  return slots;
}

/** Flow items in rows that wrap at `wrap` (or one per row); items that break start their own. */
function flowRows(items: readonly LegendFlowItem[], wrap: number | undefined): PartRow[] {
  const rows: PartRow[] = [];
  let row: PartRow | undefined;
  for (const item of items) {
    const last = row?.cells.at(-1);
    const at = last ? last.at + last.item.width + last.item.gap : 0;
    if (!row || item.breaks || wrap === undefined || at + item.width > wrap) {
      row = { cells: [], width: 0, height: 0 };
      rows.push(row);
    }
    const start = row.cells.length > 0 ? at : 0;
    row.cells.push({ item, at: start });
    row.width = start + item.width;
    row.height = Math.max(row.height, item.height);
  }
  return rows;
}

/** A row of legend parts' items, each at its distance from the legend's left. */
interface PartRow {
  cells: { item: LegendFlowItem; at: number }[];
  width: number;
  height: number;
}

/** A key's items with a legend's grid: its title in a row of its own, then its entries in the grid's cells. */
function keyRows(
  [title, ...entries]: readonly LegendFlowItem[],
  grid: { columns?: number | undefined; rows?: number | undefined },
  order: "row" | "column",
): PartRow[] {
  if (!title) return [];
  const slots = gridSlots(
    entries.map((item) => item.width),
    grid,
    order,
  );
  const lines: PartRow[] = [];
  entries.forEach((item, k) => {
    const { x, row } = slots[k]!;
    lines[row] ??= { cells: [], width: 0, height: 0 };
    const line = lines[row];
    line.cells.push({ item, at: x });
    line.width = Math.max(line.width, x + item.width);
    line.height = Math.max(line.height, item.height);
  });
  return [{ cells: [{ item: title, at: 0 }], width: title.width, height: title.height }, ...lines];
}
