// Funnels: the stages of a process, top to bottom, each a centered bar as
// wide as its value is relative to the largest stage's. Widths carry the
// values; the faint connectors between bars only lead the eye from one stage
// to the next, so their areas mean nothing.

import type { CategoryField, NumberField, Schema, Table } from "../data/table.ts";
import { n } from "../draw/markup.ts";
import { rectDrawing } from "../draw/rect.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { textDrawing } from "../draw/text.ts";
import { formatNumber, numberFormatter } from "../format/format.ts";
import { fitText } from "../layout/text.ts";
import { ItemViews } from "../model/item-views.ts";
import type { LegendEntry } from "../model/legend.ts";
import { contrastingText } from "../scale/color.ts";
import type { Geometry, RectGeometry, ShapesGeometry, TextGeometry } from "../scene/scene.ts";
import type { Frozen, FunnelSpec } from "../spec/spec.ts";
import {
  heldText,
  type LayoutFrame,
  type LayoutItem,
  type LayoutMark,
  type LayoutResult,
  RowsCache,
  SelectionCache,
} from "./layout-mark.ts";
import { CATEGORY, type ChartMark, DIM, frozen, type MARK, requireField } from "./mark.ts";

export interface FunnelOptions<S extends Schema> {
  /** Category field: a stage per value, in the field's order unless `sort` says otherwise. */
  category: CategoryField<S>;
  /** Number field summed per stage; without it, stages count rows. */
  value?: NumberField<S>;
  /** "input" (the default) keeps the categories' order; "value" puts the largest stage first. */
  sort?: "input" | "value";
  /** Stage names beside the bars and values on them; true by default. */
  labels?: boolean;
  id?: string;
  /** With the chart's `panels`, the id of the panel the funnel has to itself. */
  panel?: string;
}

/** Space between stages, where the connectors go, in bar heights. */
const GAP = 0.3;
/** The widest the names beside the bars may take, as a fraction of the chart's width. */
const NAME_ROOM = 0.35;
/** Space between the names and the bars, in pixels. */
const NAME_GAP = 10;
/** Space around a value inside or beside its bar, in pixels. */
const PAD = 6;
const CONNECTOR_OPACITY = 0.15;

interface Stage {
  key: string;
  label: string;
  value: number;
  code: number;
}

/** What a selection holds of each stage, by code: its rows' count and sum, and the stage's rows. */
interface Held {
  rows: Float64Array;
  sums: Float64Array;
  of: Float64Array;
}

export class FunnelMark implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly views = ItemViews;
  readonly spec: Frozen<FunnelSpec>;
  readonly table: Table;
  readonly measure: string;
  /** Clicks select a stage's rows, and a selection of them is drawn as a share of each bar. */
  readonly selects = true;
  /** Totals and row counts per category code, of all rows and of each facet panel's. */
  readonly #totals = new RowsCache<{ sums: Float64Array; rows: Uint32Array }>();
  /** What highlighted selections hold of each stage. */
  readonly #held = new SelectionCache<Held>();

  constructor(input: FunnelSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.category, CATEGORY, "funnel category");
    if (spec.value !== undefined) requireField(table, spec.value, ["number"], "funnel value");
    this.table = table;
    this.measure = spec.value ?? "Count";
  }

  /**
   * The sum of the value (or the row count) per category code over `of`
   * (all rows by default), and its row count; missing, negative, and
   * infinite values count as nothing.
   */
  #sums(of: Uint32Array | undefined): { sums: Float64Array; rows: Uint32Array } {
    const table = this.table;
    return this.#totals.get(table, of, () => {
      const { codes, dictionary } = table.categories(this.spec.category);
      const values = this.spec.value === undefined ? undefined : table.numbers(this.spec.value);
      const sums = new Float64Array(dictionary.length);
      const rows = new Uint32Array(dictionary.length);
      const count = of ? of.length : table.length;
      for (let k = 0; k < count; k++) {
        const row = of ? of[k]! : k;
        const code = codes[row]!;
        if (code < 0) continue;
        rows[code]!++;
        const value = values ? values[row]! : 1;
        if (value > 0 && value < Number.POSITIVE_INFINITY) sums[code]! += value;
      }
      return { sums, rows };
    });
  }

  /** Calls `each` with every row among `of` (all rows by default) of a stage, its code, and what it adds to its sum. */
  #eachRow(
    of: Uint32Array | undefined,
    each: (row: number, code: number, value: number) => void,
  ): void {
    const { codes } = this.table.categories(this.spec.category);
    const values = this.spec.value === undefined ? undefined : this.table.numbers(this.spec.value);
    const count = of ? of.length : this.table.length;
    for (let k = 0; k < count; k++) {
      const row = of ? of[k]! : k;
      const code = codes[row]!;
      if (code < 0) continue;
      const value = values ? values[row]! : 1;
      each(row, code, value > 0 && value < Number.POSITIVE_INFINITY ? value : 0);
    }
  }

  /** What `selected` holds of each stage's rows among `of` (all rows by default). */
  #heldOf(selected: Uint8Array, of: Uint32Array | undefined): Held {
    return this.#held.get(selected, of, () => {
      const size = this.table.categories(this.spec.category).dictionary.length;
      const held = {
        rows: new Float64Array(size),
        sums: new Float64Array(size),
        of: new Float64Array(size),
      };
      this.#eachRow(of, (row, code, value) => {
        held.of[code]!++;
        if (selected[row] !== 1) return;
        held.rows[code]!++;
        held.sums[code]! += value;
      });
      return held;
    });
  }

  /** Every category with rows among `of` (all rows by default), in stage order. */
  #stages(id: string | number, of: Uint32Array | undefined): Stage[] {
    const { sums, rows } = this.#sums(of);
    const { dictionary } = this.table.categories(this.spec.category);
    const stages: Stage[] = [];
    for (let code = 0; code < dictionary.length; code++) {
      // A category whose sum overflows a double has no width to draw.
      if (rows[code] === 0 || !(sums[code]! < Number.POSITIVE_INFINITY)) continue;
      const label = dictionary[code]!;
      stages.push({ key: JSON.stringify([id, label]), label, value: sums[code]!, code });
    }
    if (this.spec.sort === "value") stages.sort((a, b) => b.value - a.value);
    return stages;
  }

  legend(): LegendEntry[] {
    return [];
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, measure, locale } = frame;
    const stages = this.#stages(frame.id, frame.rows);
    const count = stages.length;
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    let largest = 0;
    for (const { value } of stages) largest = Math.max(largest, value);

    // Bars of one height fill the room, with the connectors between them.
    const height = count > 0 ? bounds.height / (count + GAP * (count - 1)) : 0;
    const step = height * (1 + GAP);
    // Labels need a line of text per bar.
    const labeled = (this.spec.labels ?? true) && count > 0 && height >= lineHeight;
    let nameRoom = 0;
    if (labeled) {
      for (const { label } of stages) nameRoom = Math.max(nameRoom, measure(label, font));
      nameRoom = Math.min(nameRoom, bounds.width * NAME_ROOM);
    }
    const left = bounds.x + (nameRoom > 0 ? nameRoom + NAME_GAP : 0);
    const width = Math.max(0, bounds.x + bounds.width - left);
    const center = left + width / 2;
    const fill = theme.palette[0] ?? theme.text;
    const rects = new Float32Array(count * 4);
    stages.forEach(({ value }, i) => {
      // The share first, so that values near the largest doubles do not overflow.
      const w = largest > 0 ? width * (value / largest) : 0;
      rects.set([center - w / 2, bounds.y + i * step, w, height], i * 4);
    });
    const box = (i: number) => rects.subarray(i * 4, i * 4 + 4) as unknown as number[];

    // Each connector joins a bar's bottom edge to the next one's top edge.
    let connectors = "";
    for (let i = 0; i + 1 < count; i++) {
      const [x0, y0, w0, h0] = box(i);
      const [x1, y1, w1] = box(i + 1);
      connectors += `M${n(x0!)} ${n(y0! + h0!)}H${n(x0! + w0!)}L${n(x1! + w1!)} ${n(y1!)}H${n(x1!)}Z`;
    }
    const geometry: Geometry[] = [];
    if (connectors) {
      geometry.push({
        kind: "shapes",
        draw: shapesDrawing,
        key: "funnel-connectors",
        shapes: [
          {
            d: connectors,
            fill,
            stroke: undefined,
            strokeWidth: 0,
            opacity: CONNECTOR_OPACITY,
            dash: undefined,
          },
        ],
        font,
        fontSize: theme.fontSize,
      } as ShapesGeometry);
    }
    // With a selection highlighted, each bar's selected share is a bar of
    // that width in its middle, the rest of it dimmed either side.
    const selected = frame.selected?.(this.table);
    const held = selected && this.#heldOf(selected, frame.rows);
    let lit = rects;
    if (held) {
      lit = rects.slice();
      const sides = new Float32Array(count * 8);
      stages.forEach(({ value, code }, i) => {
        const [x, y, w, h] = box(i);
        const part = w! * Math.min(1, value > 0 ? held.sums[code]! / value : 0);
        const side = (w! - part) / 2;
        lit.set([x! + side, y!, part, h!], i * 4);
        sides.set([x!, y!, side, h!, x! + side + part, y!, side, h!], i * 8);
      });
      geometry.push({
        kind: "rect",
        draw: rectDrawing,
        key: "funnel-bars-dimmed",
        fill,
        fillOpacity: DIM,
        rects: sides,
        count: count * 2,
      } as RectGeometry);
    }
    geometry.push({
      kind: "rect",
      draw: rectDrawing,
      key: "funnel-bars",
      fill,
      fillOpacity: 1,
      rects: lit,
      count,
    } as RectGeometry);

    const percent = numberFormatter({ style: "percent", maximumFractionDigits: 1 }, locale);
    const first = stages[0]?.value ?? 0;
    if (labeled) geometry.push(...this.#labels(stages, box, nameRoom, fill, frame, percent));

    const itemOf = (i: number): LayoutItem => {
      const { key, label, value, code } = stages[i]!;
      const [x, y, w, h] = box(i);
      const previous = stages[i - 1]?.value ?? 0;
      const f = (value: number) => formatNumber(value, locale);
      let text = f(value);
      if (i > 0 && first > 0) text += `, ${percent(value / first)} of the first stage`;
      if (i > 1 && previous > 0) text += `, ${percent(value / previous)} of the previous`;
      const field = this.spec.value;
      if (held)
        text += heldText(
          held.rows[code]!,
          held.of[code]!,
          field === undefined ? undefined : { field, held: held.sums[code]!, of: value },
          f,
        );
      return {
        key,
        label,
        color: fill,
        value,
        text,
        px: center,
        py: y! + h! / 2,
        outline: `M${n(x!)} ${n(y!)}h${n(w!)}v${n(h!)}h${n(-w!)}Z`,
      };
    };
    return {
      geometry,
      // A stage's whole row answers, so that narrow bars are easy to point at.
      itemAt(px, py) {
        if (!(px >= bounds.x && px <= bounds.x + bounds.width)) return undefined;
        const i = Math.floor((py - bounds.y) / step);
        if (!(i >= 0 && i < count && py - bounds.y - i * step <= height)) return undefined;
        return itemOf(i);
      },
      count,
      item: itemOf,
      indexOf: (key) => stages.findIndex((stage) => stage.key === key),
      rowsOf: (key, table) => {
        const stage = table === this.table ? stages.find((s) => s.key === key) : undefined;
        if (!stage) return undefined;
        const rows: number[] = [];
        this.#eachRow(frame.rows, (row, code) => {
          if (code === stage.code) rows.push(row);
        });
        return rows;
      },
      summary: () => this.#summary(stages, locale, percent),
    };
  }

  /**
   * Names right-aligned left of the bars, shortened to fit, and each stage's
   * value and share of the first stage on its bar, or beside it when the
   * bar is too narrow; with room for neither, the share alone, or nothing.
   */
  #labels(
    stages: readonly Stage[],
    box: (i: number) => number[],
    nameRoom: number,
    fill: string,
    frame: LayoutFrame,
    percent: (value: number) => string,
  ): Geometry[] {
    const { bounds, theme, measure, locale } = frame;
    const font = `${theme.fontSize}px ${theme.font}`;
    const backdrop = theme.background === "transparent" ? "#ffffff" : theme.background;
    const ink = contrastingText(fill, 1, backdrop);
    const first = stages[0]!.value;
    const group = (anchor: TextGeometry["anchor"], fill: string, halo: boolean) => ({
      anchor,
      fill,
      halo,
      coords: [] as number[],
      labels: [] as string[],
    });
    const groups = {
      names: group("end", theme.text, false),
      // Text the bar's color cannot be read against gets the theme's, with a halo.
      inside: group("middle", ink ?? theme.text, ink === undefined),
      beside: group("start", theme.text, false),
    };
    const right = bounds.x + bounds.width;
    stages.forEach(({ label, value }, i) => {
      const [x, y, w, h] = box(i);
      const middle = y! + h! / 2;
      const name = nameRoom > 0 ? fitText(label, nameRoom, measure, font) : "";
      if (name && name !== "…") {
        groups.names.coords.push(bounds.x + nameRoom, middle);
        groups.names.labels.push(name);
      }
      // The value and the share, or the share alone when that does not fit.
      const share = first > 0 ? percent(value / first) : "";
      const texts = share
        ? [`${formatNumber(value, locale)} · ${share}`, share]
        : [formatNumber(value, locale)];
      for (const text of texts) {
        const textWidth = measure(text, font);
        if (textWidth + 2 * PAD <= w!) {
          groups.inside.coords.push(x! + w! / 2, middle);
          groups.inside.labels.push(text);
          break;
        }
        if (x! + w! + PAD + textWidth <= right) {
          groups.beside.coords.push(x! + w! + PAD, middle);
          groups.beside.labels.push(text);
          break;
        }
      }
    });
    return Object.entries(groups).flatMap(
      ([part, { anchor, fill: color, halo, coords, labels }]) =>
        labels.length === 0
          ? []
          : [
              {
                kind: "text",
                draw: textDrawing,
                key: `funnel-${part}`,
                fill: color,
                anchor,
                halo,
                coords: Float32Array.from(coords),
                labels,
                count: labels.length,
              } as TextGeometry,
            ],
    );
  }

  #summary(
    stages: readonly Stage[],
    locale: string | undefined,
    percent: (value: number) => string,
  ): string {
    const what = this.spec.value
      ? `${this.spec.value} by ${this.spec.category}`
      : this.spec.category;
    const first = stages[0];
    const last = stages.at(-1);
    if (!first || !last) return `Funnel of ${what}, with nothing to show.`;
    const f = (value: number) => formatNumber(value, locale);
    if (stages.length === 1)
      return `Funnel of ${what}: 1 stage, ${first.label} at ${f(first.value)}.`;
    const share = first.value > 0 ? `, ${percent(last.value / first.value)} of the first` : "";
    return `Funnel of ${what}: ${stages.length} stages from ${f(first.value)} (${first.label}) to ${f(last.value)} (${last.label})${share}.`;
  }
}

/**
 * A funnel: a centered bar per category of `category`, top to bottom, as
 * wide as the sum of `value` over its rows (or their count) relative to the
 * largest stage.
 *
 * ```ts
 * funnel(signups, { category: "stage", value: "users" })
 * ```
 */
export function funnel<S extends Schema>(
  table: Table<S>,
  options: FunnelOptions<S>,
): ChartMark<Frozen<FunnelSpec>> {
  const spec: FunnelSpec = { type: "funnel", category: options.category };
  if (options.value !== undefined) spec.value = options.value;
  if (options.sort !== undefined) spec.sort = options.sort;
  if (options.labels !== undefined) spec.labels = options.labels;
  if (options.id !== undefined) spec.id = options.id;
  if (options.panel !== undefined) spec.panel = options.panel;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new FunnelMark(spec, table as unknown as Table);
}
