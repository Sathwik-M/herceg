import type { NumericField, Schema, Table } from "../data/table.ts";
import { rectDrawing } from "../draw/rect.ts";
import type { Formatter } from "../format/format.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { Geometry, RectGeometry } from "../scene/scene.ts";
import type { LabelPlaceSpec } from "../spec/encoding.ts";
import type { AnnotationPosition, Clip, Frozen, RegionRange, RegionSpec } from "../spec/spec.ts";
import type { Halo } from "../spec/style.ts";
import {
  AnnotationData,
  labelOf,
  type Place,
  type PlaceOption,
  position,
  readsTable,
  type TextField,
} from "./annotation.ts";
import { labelPaint, labelsGeometry, type PlacedLabel, plainText, textGeometry } from "./labels.ts";
import { definedFields } from "./line.ts";
import {
  type AxisFormat,
  type ChartMark,
  type Frame,
  frozen,
  type MARK,
  type Mark,
  type MarkKey,
  type RowParts,
  seriesKey,
} from "./mark.ts";
import type { RuleLabel } from "./rule.ts";

interface RegionStyle {
  /** The outline that keeps text readable: "auto" (the default), false for none, or a color of its own. */
  halo?: Halo;
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /**
   * What the mark's drawing is cut to: "plot", "chart", or false for
   * nothing, so markers at the plot's edge show whole. Without it, data is
   * cut to the plot and labels are drawn whole.
   */
  clip?: Clip;
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  fill?: string;
  fillOpacity?: number;
  /** Whether the regions' values count toward the axes' domains; false by default. */
  contributeDomain?: boolean;
  id?: string;
}

/** A region between constant places: an x range, a y range, or both (a rectangle). */
export type RegionOptions = RegionStyle &
  RegionRange<PlaceOption<never>> & {
    /** Text drawn in the region (its top left corner by default): its text, or a label object. */
    label?: RuleLabel<never>;
  };

/** Regions from a table, one per row; places may also be constants. */
export type RegionDataOptions<S extends Schema> = RegionStyle &
  RegionRange<PlaceOption<NumericField<S>>> & {
    /** Text drawn in every region: constant, or each row's `field`. */
    label?: RuleLabel<TextField<S>>;
  };

/** Pixels between a region's edge and its label. */
const PADDING = 4;

/** Why a region spec has no range, or half of one, if it does. */
export function regionFormError(spec: {
  x1?: unknown;
  x2?: unknown;
  y1?: unknown;
  y2?: unknown;
}): string | undefined {
  if ((spec.x1 === undefined) !== (spec.x2 === undefined))
    return "region: needs both x1 and x2, or neither";
  if ((spec.y1 === undefined) !== (spec.y2 === undefined))
    return "region: needs both y1 and y2, or neither";
  if (spec.x1 === undefined && spec.y1 === undefined)
    return "region: needs x1 and x2, y1 and y2, or both";
  return undefined;
}

/**
 * Shaded regions: between x1 and x2 across the plot's height, between y1
 * and y2 across its width, or rectangles with both. Their values count
 * toward the axes' domains when they say so (`contributeDomain`).
 */
export class RegionMark implements Mark<Frozen<RegionSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<RegionSpec>;
  readonly tooltip = "x";
  readonly featured: boolean;
  readonly domainFallback: boolean;
  readonly #data: AnnotationData;
  /** The label drawn as regions always draw theirs: plain text, in the top left corner. */
  readonly #plain: boolean;

  constructor(input: RegionSpec, table?: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.domainFallback = spec.contributeDomain !== true;
    const problem = regionFormError(spec);
    if (problem) throw new Error(problem);
    const label = labelOf(spec.label);
    this.#data = new AnnotationData(
      table,
      { x1: spec.x1, x2: spec.x2, y1: spec.y1, y2: spec.y2 },
      label,
      "region",
      { x: "x", y: spec.axis === "right" ? "yRight" : "y" },
    );
    this.#plain = label !== undefined && !label.style && !label.place && !label.format;
    const format = label?.format as { number?: unknown; time?: unknown } | undefined;
    this.featured = format?.number !== undefined || format?.time !== undefined;
  }

  get table(): Table | undefined {
    return this.#data.table;
  }

  channelKind(axis: "x" | "y") {
    const [a, b] = this.#pair(axis);
    return this.#data.kind(a) ?? this.#data.kind(b);
  }

  describe(format: AxisFormat, locale: string | undefined, rows?: RowParts): string | undefined {
    const data = this.#data;
    const x = this.#places("x");
    const y = this.#places("y");
    // Places that are not values (fractions, pixels) say nothing of where the region is.
    const range = (places: [Place, Place] | undefined, f: Formatter, i: number) => {
      if (!places || places.some((p) => p.kind !== "value")) return "";
      const a = data.value(places[0], i);
      const b = data.value(places[1], i);
      return Number.isFinite(a) && Number.isFinite(b) ? `${f(a)} to ${f(b)}` : undefined;
    };
    return data.summary(
      ["Region", "Regions"],
      locale,
      (i) => {
        const across = range(x, format.x, i);
        const down = range(y, format.y, i);
        if (across === undefined || down === undefined) return undefined;
        return [across && `x ${across}`, down && `y ${down}`].filter(Boolean).join(", ");
      },
      rows,
    );
  }

  series() {
    return [];
  }

  xExtent(_series: unknown, log: boolean, _breaks?: unknown, rows?: RowParts) {
    return this.#data.extent(this.#pair("x"), log, undefined, rows);
  }

  yExtent(
    _series: unknown,
    x0: number,
    x1: number,
    log: boolean,
    _breaks?: unknown,
    rows?: RowParts,
  ) {
    const x = this.#places("x");
    if (!x) return this.#data.extent(this.#pair("y"), log, undefined, rows);
    // Regions that also span x count toward y only where they overlap the view.
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    // An edge at a fraction, pixels, or a category is in view wherever x is.
    const edge = (place: Place, i: number, end: number) =>
      place.kind === "value" ? this.#data.value(place, i) : end;
    const overlaps = (i: number) => {
      const p = edge(x[0], i, hi);
      const q = edge(x[1], i, lo);
      return Math.max(p, q) >= lo && Math.min(p, q) <= hi;
    };
    return this.#data.extent(this.#pair("y"), log, overlaps, rows);
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey, rows?: RowParts): Geometry[] {
    const { plot, theme } = frame;
    const data = this.#data;
    const id = seriesKey(key, "region");
    const xs = this.#places("x");
    const ys = this.#places("y");
    const label = data.label;
    const write = data.writer(frame.locale, frame.features?.of(this)?.format);
    // Buffers as large as the items drawn: a facet panel's, not the table's.
    const size = data.size(rows);
    const rects = frame.floats(id, "rect", size * 4);
    const placed: PlacedLabel[] = [];
    const paint = label && labelPaint(theme, theme.text, label.style);
    let count = 0;
    data.each(rows, (i) => {
      // Each region is clipped to the plot, so a label stays in its visible part.
      const across = this.#span(xs, "x", i, frame.x, frame, plot.x, plot.x + plot.width);
      const down = this.#span(ys, "y", i, frame.y, frame, plot.y, plot.y + plot.height);
      if (!across || !down) return;
      rects[count * 4] = across[0];
      rects[count * 4 + 1] = down[0];
      rects[count * 4 + 2] = across[1] - across[0];
      rects[count * 4 + 3] = down[1] - down[0];
      if (paint) {
        const text = data.text(i, frame.locale, write);
        placed.push(
          this.#plain
            ? {
                text,
                x: across[0] + PADDING,
                y: down[0] + PADDING + paint.size / 2,
                anchor: "start",
                baseline: "middle",
              }
            : this.#place(text, across, down, paint.size),
        );
      }
      count++;
    });
    const fill: RectGeometry = {
      kind: "rect",
      draw: rectDrawing,
      key: id,
      fill: this.spec.fill ?? theme.muted,
      fillOpacity: this.spec.fillOpacity ?? 0.15,
      rects,
      count,
    };
    const out: Geometry[] = [fill];
    if (placed.length > 0 && paint) {
      const labelKey = seriesKey(key, "region label");
      const halo = label?.style?.halo ?? this.spec.halo;
      out.push(
        this.#plain || plainText(paint, theme)
          ? textGeometry(labelKey, placed, paint.color, halo, frame)
          : labelsGeometry(labelKey, placed, paint, halo, frame),
      );
    }
    return out;
  }

  /**
   * Where a region's label goes: along the edge `side` names (top by
   * default), at its start, middle, or end, inside the region or outside it.
   */
  #place(
    text: string,
    [left, right]: [number, number],
    [top, bottom]: [number, number],
    size: number,
  ): PlacedLabel {
    const place: Frozen<LabelPlaceSpec> = this.#data.label?.place ?? {};
    const side = place.side ?? "top";
    const attachment = place.attachment ?? "start";
    const gap = PADDING + (place.offset ?? 0);
    const out = place.outside ? -1 : 1;
    if (side === "top" || side === "bottom") {
      const y = side === "top" ? top + out * (gap + size / 2) : bottom - out * (gap + size / 2);
      return attachment === "start"
        ? { text, x: left + PADDING, y, anchor: "start", baseline: "middle" }
        : attachment === "end"
          ? { text, x: right - PADDING, y, anchor: "end", baseline: "middle" }
          : { text, x: (left + right) / 2, y, anchor: "middle", baseline: "middle" };
    }
    const y =
      attachment === "start"
        ? top + PADDING + size / 2
        : attachment === "end"
          ? bottom - PADDING - size / 2
          : (top + bottom) / 2;
    return side === "left"
      ? {
          text,
          x: left + out * gap,
          y,
          anchor: place.outside ? "end" : "start",
          baseline: "middle",
        }
      : {
          text,
          x: right - out * gap,
          y,
          anchor: place.outside ? "start" : "end",
          baseline: "middle",
        };
  }

  /**
   * Pixel span [start, end] of item i on one axis, clipped to [min, max];
   * the whole range without places; undefined when nothing of it is in
   * view. Values a log scale cannot place (zero or below) sit at its low
   * end, so a region from zero reaches the axis.
   */
  #span(
    places: [Place, Place] | undefined,
    axis: "x" | "y",
    item: number,
    scale: PositionScale,
    frame: Frame,
    min: number,
    max: number,
  ): [number, number] | undefined {
    if (!places) return [min, max];
    const a = this.#data.pixel(places[0], axis, item, scale, frame, true);
    const b = this.#data.pixel(places[1], axis, item, scale, frame, true);
    if (a === undefined || b === undefined) return undefined;
    const start = Math.max(min, Math.min(a, b));
    const end = Math.min(max, Math.max(a, b));
    return end > start ? [start, end] : undefined;
  }

  #pair(
    axis: "x" | "y",
  ): [Frozen<AnnotationPosition> | undefined, Frozen<AnnotationPosition> | undefined] {
    return axis === "x" ? [this.spec.x1, this.spec.x2] : [this.spec.y1, this.spec.y2];
  }

  #places(axis: "x" | "y"): [Place, Place] | undefined {
    const [a, b] = this.#pair(axis);
    return a === undefined || b === undefined
      ? undefined
      : [this.#data.place(a), this.#data.place(b)];
  }
}

/**
 * Shaded regions: one between constant places, or one per row of a table.
 * List them before the marks they highlight to draw them underneath.
 *
 * ```ts
 * region({ x1: start, x2: end, label: "Maintenance" })
 * region(incidents, { x1: "start", x2: "end", label: { field: "title" } })
 * region({ y1: 200, y2: 300, fill: "#2a9d8f" })
 * region({ x1: start, x2: end, y1: { fraction: 0 }, y2: { fraction: 0.1 } })
 * ```
 */
export function region(options: RegionOptions): ChartMark<Frozen<RegionSpec>>;
export function region<S extends Schema>(
  table: Table<S>,
  options: RegionDataOptions<S>,
): ChartMark<Frozen<RegionSpec>>;
export function region<S extends Schema>(
  first: Table<S> | RegionOptions,
  second?: RegionDataOptions<S>,
): ChartMark<Frozen<RegionSpec>> {
  const table = second ? (first as Table<S>) : undefined;
  const options = (second ?? first) as RegionDataOptions<S>;
  const spec = {
    type: "region",
    ...definedFields(
      {
        ...options,
        x1: position(options.x1),
        x2: position(options.x2),
        y1: position(options.y1),
        y2: position(options.y2),
      },
      [
        "halo",
        "id",
        "x1",
        "x2",
        "y1",
        "y2",
        "fill",
        "fillOpacity",
        "label",
        "contributeDomain",
        "axis",
        "facet",
        "panel",
        "clip",
      ],
    ),
  } as unknown as RegionSpec;
  const field = typeof spec.label === "object" ? spec.label.field : undefined;
  if (table?.name !== undefined && readsTable([spec.x1, spec.x2, spec.y1, spec.y2], field))
    spec.data = table.name;
  return new RegionMark(spec, table as unknown as Table | undefined);
}
