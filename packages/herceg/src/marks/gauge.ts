// Gauges: one value on a dial. The value is the last finite one of a number
// field, so a table that streams readings moves the gauge as rows arrive.

import type { NumberField, Schema, Table } from "../data/table.ts";
import { ArcPath, arcDrawing, traceSector } from "../draw/arc.ts";
import { shapesDrawing } from "../draw/shapes.ts";
import { textDrawing } from "../draw/text.ts";
import { type Formatter, formatNumber, numberFormatter } from "../format/format.ts";
import { fitText } from "../layout/text.ts";
import type { LegendEntry } from "../model/legend.ts";
import type { ArcGeometry, Geometry, ShapesGeometry, TextGeometry } from "../scene/scene.ts";
import type { Frozen, GaugeBand, GaugeSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "./layout-mark.ts";
import { type ChartMark, frozen, type MARK, requireField } from "./mark.ts";

export interface GaugeOptions<S extends Schema> {
  /** Number field whose last finite value the gauge shows. */
  value: NumberField<S>;
  /** The ends of the dial; 0 and 100 by default. */
  min?: number;
  max?: number;
  /**
   * Colored ranges of the dial, by ascending ends: each from the previous
   * band's end (the first from `min`) up to its `to`, at most `max`.
   */
  bands?: readonly GaugeBand[];
  /** Text under the value; the field's name by default. */
  label?: string;
  /** Intl.NumberFormat options for the value and the dial's ends. */
  format?: Intl.NumberFormatOptions;
  id?: string;
}

/** The dial turns 240 degrees clockwise from its lower left, over the top: it is open at the bottom. */
const START = (5 / 6) * Math.PI;
const SWEEP = (4 / 3) * Math.PI;
/** The track's thickness, and the band ring's distance from it and thickness, in track radii. */
const TRACK = 0.18;
const BAND_GAP = 0.035;
const BAND = 0.06;
/** Space between neighboring bands, in pixels. */
const GAP = 2;
/** Space between the dial's ends and the labels under them, in pixels. */
const END_GAP = 6;
/** The value's font size, in track radii (at least the theme's), and its largest in pixels. */
const VALUE_SIZE = 0.34;
const MAX_VALUE_SIZE = 72;

interface Band {
  from: number;
  to: number;
  color: string;
}

export class GaugeMark implements LayoutMark {
  declare readonly [MARK]: true;
  readonly layout = true;
  readonly spec: Frozen<GaugeSpec>;
  readonly table: Table;
  readonly measure: string;
  readonly #min: number;
  readonly #max: number;

  constructor(input: GaugeSpec, table: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    requireField(table, spec.value, ["number"], "gauge value");
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    if (!(Number.isFinite(min) && Number.isFinite(max) && min < max))
      throw new RangeError(`gauge min must be below max, and both finite, not ${min} and ${max}`);
    let previous = min;
    for (const { to } of spec.bands ?? []) {
      if (!(to > min && to <= max))
        throw new RangeError(
          `gauge bands must end above min (${min}) and at most at max (${max}), not at ${to}`,
        );
      if (!(to > previous))
        throw new RangeError(
          `gauge bands must end in ascending order, not ${to} after ${previous}`,
        );
      previous = to;
    }
    this.table = table;
    this.measure = spec.value;
    this.#min = min;
    this.#max = max;
  }

  legend(): LegendEntry[] {
    return [];
  }

  /** The row holding the field's last finite value, or -1 when none does. */
  #row(): number {
    const values = this.table.numbers(this.spec.value);
    let row = values.length - 1;
    while (row >= 0 && !Number.isFinite(values[row]!)) row--;
    return row;
  }

  #bands(theme: Theme): Band[] {
    let from = this.#min;
    return (this.spec.bands ?? []).map(({ to, color }, i) => {
      const band = {
        from,
        to,
        color: color ?? theme.palette[i % theme.palette.length] ?? theme.text,
      };
      from = to;
      return band;
    });
  }

  draw(frame: LayoutFrame): LayoutResult {
    const { bounds, theme, measure, locale } = frame;
    const min = this.#min;
    const max = this.#max;
    const row = this.#row();
    const value = row < 0 ? Number.NaN : this.table.numbers(this.spec.value)[row]!;
    const format: Formatter = this.spec.format
      ? numberFormatter(this.spec.format, locale)
      : (v) => formatNumber(v, locale);
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const bands = this.#bands(theme);

    // The dial reaches its outer radius above its center, and half that below
    // it at its ends (30 degrees below level), with the end labels under them.
    const ring = bands.length > 0 ? 1 + BAND_GAP + BAND : 1;
    const room = Math.min(bounds.width / 2 - 2, (bounds.height - END_GAP - lineHeight) / 1.5);
    const r = Math.max(0, room / ring);
    const r0 = r * (1 - TRACK);
    const outer = r * ring;
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + (bounds.height - 1.5 * outer - END_GAP - lineHeight) / 2 + outer;
    // Values past the dial's ends are drawn at them. Halving keeps the
    // differences of values near the largest doubles finite.
    const angle = (v: number) => {
      const clamped = Math.min(max, Math.max(min, v));
      return START + SWEEP * ((clamped / 2 - min / 2) / (max / 2 - min / 2));
    };

    // The band of the value as drawn: values past an end are drawn at it.
    const shown = Math.min(max, Math.max(min, value));
    const band = bands.find(({ to }) => shown <= to);
    const color = band?.color ?? theme.palette[0] ?? theme.text;
    const end = Number.isNaN(value) ? START : angle(value);
    const geometry: Geometry[] = [
      {
        kind: "arc",
        draw: arcDrawing,
        key: "gauge-dial",
        // The track beyond the value, and the value's arc. The track is not
        // drawn under the value, where its antialiased edges would show.
        arcs: Float32Array.of(cx, cy, r0, r, end, START + SWEEP, cx, cy, r0, r, START, end),
        count: 2,
        colors: [theme.grid, color],
        colorIndex: Uint32Array.of(0, 1),
        fillOpacity: 1,
        gap: 0,
      } as ArcGeometry,
    ];
    if (bands.length > 0) {
      const colors = [...new Set(bands.map((b) => b.color))];
      const [b0, b1] = [r * (1 + BAND_GAP), outer];
      geometry.push({
        kind: "arc",
        draw: arcDrawing,
        key: "gauge-bands",
        arcs: Float32Array.from(
          bands.flatMap(({ from, to }) => [cx, cy, b0, b1, angle(from), angle(to)]),
        ),
        count: bands.length,
        colors,
        colorIndex: Uint32Array.from(bands, (b) => colors.indexOf(b.color)),
        fillOpacity: 1,
        gap: GAP,
      } as ArcGeometry);
    }

    // The value as large as the dial allows, within the track's inside, and
    // the label under it.
    const text = Number.isNaN(value) ? "–" : format(value);
    const perPixel = measure(text, `600 100px ${theme.font}`) / 100;
    const size = Math.round(
      Math.min(
        MAX_VALUE_SIZE,
        Math.max(theme.fontSize, r * VALUE_SIZE),
        perPixel > 0 ? (1.5 * r0) / perPixel : Infinity,
      ),
    );
    const valueY = cy - lineHeight * 0.3;
    const label = fitText(this.spec.label ?? this.spec.value, 1.7 * r0, measure, font);
    const labels: { text: string; x: number; y: number }[] = [];
    if (label !== "…") labels.push({ text: label, x: cx, y: valueY + size / 2 + lineHeight / 2 });
    geometry.push({
      kind: "shapes",
      draw: shapesDrawing,
      key: "gauge-value",
      shapes: [
        {
          text,
          x: cx,
          y: valueY,
          fill: Number.isNaN(value) ? theme.muted : theme.text,
          anchor: "middle",
        },
      ],
      font: `600 ${size}px ${theme.font}`,
      fontSize: size,
      bold: true,
    } as ShapesGeometry);

    // `min` and `max` under the track's ends, unless they would overlap.
    const extremes = [format(min), format(max)];
    const widths = extremes.map((extreme) => measure(extreme, font));
    const reach = ((r0 + r) / 2) * Math.cos(START);
    if (widths[0]! / 2 + widths[1]! / 2 + 8 < -2 * reach) {
      const y = cy + outer * Math.sin(START) + END_GAP + lineHeight / 2;
      extremes.forEach((extreme, i) => {
        const half = widths[i]! / 2;
        const x = cx + (i === 0 ? reach : -reach);
        const inside = Math.min(bounds.x + bounds.width - half, Math.max(bounds.x + half, x));
        labels.push({ text: extreme, x: inside, y });
      });
    }
    geometry.push({
      kind: "text",
      draw: textDrawing,
      key: "gauge-labels",
      fill: theme.muted,
      anchor: "middle",
      halo: false,
      coords: Float32Array.from(labels.flatMap(({ x, y }) => [x, y])),
      labels: labels.map((l) => l.text),
      count: labels.length,
    } as TextGeometry);

    const key = JSON.stringify([frame.id, this.spec.value]);
    const outline = new ArcPath();
    traceSector(outline, cx, cy, r0, r, START, end > START ? end : START + SWEEP, 0);
    const middle = (r0 + r) / 2;
    const item: LayoutItem = {
      key,
      label: this.spec.label ?? this.spec.value,
      color,
      value,
      text: Number.isNaN(value)
        ? `no value, from ${format(min)} to ${format(max)}`
        : `${format(value)} of ${format(min)} to ${format(max)}${outside(value, min, max)}`,
      px: cx + middle * Math.cos(end),
      py: cy + middle * Math.sin(end),
      outline: outline.d,
      ...(row >= 0 && { row }),
    };
    return {
      geometry,
      itemAt: (px, py) => (Math.hypot(px - cx, py - cy) <= outer ? item : undefined),
      count: 1,
      item: () => item,
      indexOf: (k) => (k === key ? 0 : -1),
      summary: () => {
        const name = `Gauge of ${item.label}`;
        const range = `from ${format(min)} to ${format(max)}`;
        if (Number.isNaN(value)) return `${name}: no value, ${range}.`;
        const within = band ? `, in the band up to ${format(band.to)}` : "";
        return `${name}: ${format(value)}, ${range}${outside(value, min, max)}${within}.`;
      },
    };
  }
}

function outside(value: number, min: number, max: number): string {
  return value > max ? ", above the maximum" : value < min ? ", below the minimum" : "";
}

/**
 * A gauge showing the last finite value of `value` on a dial from `min` to
 * `max` (0 to 100 by default), with optional colored bands.
 *
 * ```ts
 * gauge(metrics, { value: "cpu", bands: [{ to: 70 }, { to: 90 }, { to: 100 }] })
 * ```
 */
export function gauge<S extends Schema>(
  table: Table<S>,
  options: GaugeOptions<S>,
): ChartMark<Frozen<GaugeSpec>> {
  const spec: GaugeSpec = { type: "gauge", value: options.value };
  if (options.min !== undefined) spec.min = options.min;
  if (options.max !== undefined) spec.max = options.max;
  if (options.bands !== undefined) spec.bands = options.bands.map((band) => ({ ...band }));
  if (options.label !== undefined) spec.label = options.label;
  if (options.format !== undefined) spec.format = { ...options.format };
  if (options.id !== undefined) spec.id = options.id;
  if (table.name !== undefined) spec.data = table.name;
  // Field names were checked against S above; marks work on the erased schema.
  return new GaugeMark(spec, table as unknown as Table);
}
