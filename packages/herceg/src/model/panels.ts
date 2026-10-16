// Subplots: a chart drawn in several panels, each with the marks that name it
// in their `panel` option, placed by a layout of grids (layout/compile.ts,
// layout/grid.ts) and insets (layout/insets.ts). A chart's `panels` option
// holds a Panels; charts without one never load this module. Marks keep
// their place in the chart's one list of marks, so their identity, colors,
// and legend state do not depend on the panel they draw in.

import type { AxisOptions, PanelOptions } from "../guides/options.ts";
import { type CompiledLayout, compileLayout, scopeGroups } from "../layout/compile.ts";
import { type LayoutOptions, normalizeLayout } from "../layout/options.ts";
import { aligned } from "../layout/place.ts";
import type { MeasureText } from "../layout/text.ts";
import type { LayoutMark } from "../marks/layout-mark.ts";
import type { BandContext, Bands, Mark } from "../marks/mark.ts";
import type { HeaderGuide, Rect } from "../scene/scene.ts";
import { ChartError } from "../spec/errors.ts";
import type { LayoutSpec, ScaleScope } from "../spec/spec.ts";
import type { TextPaint } from "../style/style.ts";
import type { AxisType } from "./axis.ts";
import { Cells } from "./cells.ts";
import type { MarkSeries } from "./inspect.ts";
import type { HiddenKeys } from "./legend.ts";
import {
  type AnnotatedPanel,
  across,
  alongY,
  annotations,
  checkBands,
  checkLayouts,
  type DescribeAnnotation,
  groups,
  headerGuides,
  type LayoutConfig,
  lowestWithAxes,
  onAxis,
  type PanelAxis,
  PanelBands,
  type PanelChart,
  type PanelGrid,
  type PanelLayout,
  type PanelPlacement,
  type PanelSplit,
  type PanelSplitter,
  type ScaleGroups,
  typedGroups,
  yAxesOf,
} from "./panel-layout.ts";
import { PanelLegends } from "./panel-legends.ts";
import { mixedPanels, type ScaledConfig, type ScaleName, type Scopes, scopesOf } from "./scales.ts";
import { titleText } from "./titles.ts";

/** The `panel` that draws a mark in every panel. */
export const EVERY_PANEL = "*";

/** Ids of functions in settings, so that settings compare them by identity. */
const functionIds = new WeakMap<object, number>();
let lastFunctionId = 0;
function functionId(value: object): number {
  let id = functionIds.get(value);
  if (id === undefined) {
    id = ++lastFunctionId;
    functionIds.set(value, id);
  }
  return id;
}

/**
 * Subplots for a chart's `panels` option: panels placed by a layout (one
 * column of them, in order, by default), each drawing the marks whose
 * `panel` names it, and marks with `panel: "*"` in all of them. Each panel
 * has scales of its own unless a scale's `scope` shares them. A panel may
 * change the chart's `x` and `y` settings for its own axes. A layout mark (a
 * pie) has the panel it names to itself, without axes.
 *
 * Give the panels as a list, with a layout naming them by id, or as a
 * layout giving each panel's settings where it goes (see herceg/layout):
 *
 * ```ts
 * createChart(element, {
 *   marks: [
 *     line(metrics, { x: "time", y: "latency", panel: "latency" }),
 *     bar(metrics, { x: "time", y: "requests", panel: "traffic" }),
 *     rule({ x: deployedAt, panel: "*" }),
 *   ],
 *   panels: panels([
 *     { id: "latency", title: "Latency", y: { title: "ms" } },
 *     { id: "traffic", title: "Requests" },
 *   ]),
 * });
 * ```
 */
export function panels(list: readonly PanelOptions[], layout?: LayoutOptions): Panels;
export function panels(layout: LayoutOptions): Panels;
export function panels(
  first: readonly PanelOptions[] | LayoutOptions,
  layout?: LayoutOptions,
): Panels {
  return Array.isArray(first)
    ? new Panels(first as readonly PanelOptions[], layout)
    : new Panels([], first as LayoutOptions);
}

export class Panels implements PanelLayout {
  /** The panels, in the order the layout draws and reads them. */
  readonly list: readonly PanelOptions[];
  /** The layout as the spec writes it, with every panel's id. */
  readonly layout: LayoutSpec | undefined;
  readonly #compiled: CompiledLayout;
  /** Where its panels go, scene after scene, in the one chart drawing them (see `forChart`). */
  readonly #cells: Cells;

  /** The panels of `list` placed by `layout`; or `from`'s, for one chart of its own. */
  constructor(list: readonly PanelOptions[], layout?: LayoutOptions, from?: Panels) {
    if (from) {
      this.list = from.list;
      this.layout = from.layout;
      this.#compiled = from.#compiled;
      this.#cells = from.#newCells();
      return;
    }
    const normal = normalizeLayout(list, layout);
    if (normal.list.length === 0)
      throw new RangeError("panels: expected at least one panel; give a list or a layout of them");
    const ids = new Set<string>();
    for (const [i, { id }] of normal.list.entries()) {
      if (typeof id !== "string" || id === "" || id === EVERY_PANEL)
        throw new TypeError(
          `panels[${i}].id: expected a name other than "" and "*"; received ${JSON.stringify(id)}`,
        );
      if (ids.has(id)) throw new TypeError(`panels[${i}].id: "${id}" names two panels`);
      ids.add(id);
    }
    this.#compiled = compileLayout(
      normal.layout,
      normal.list.map(({ id }) => id),
    );
    const byId = new Map(normal.list.map((panel) => [panel.id, panel]));
    this.list = this.#compiled.order.map((id) => byId.get(id)!);
    this.layout = normal.layout;
    this.#cells = this.#newCells();
  }

  #newCells(): Cells {
    return new Cells(
      this.#compiled,
      this.list.map(({ title }) => title !== undefined),
    );
  }

  /**
   * The panels as one chart draws them: the compiled layout shared, and
   * where its panels went (the margins it keeps) that chart's alone, so a
   * configuration given to several charts lays each out as if alone.
   */
  forChart(): Panels {
    return new Panels([], undefined, this);
  }

  placement(_split: PanelSplit, grid: PanelGrid): PanelPlacement {
    return this.#cells.placement(grid);
  }

  /** What lists subplots in panels' legends, for the guide compiler. */
  get panelLegends(): typeof PanelLegends {
    return PanelLegends;
  }

  coveredAt(key: string, x: number, y: number): boolean {
    return this.#cells.coveredAt(key, x, y);
  }

  /**
   * What hiding (or showing, `visible`) series and items `keys` makes of
   * what panels' legends set (`hidden.panels`): in `panel`, its own state
   * of them (what a key stands for in place of its series' own settings);
   * in every panel, without one, they let go of what they set of the keys
   * and of what those stand for. `hidden.panels` itself where nothing
   * changes.
   */
  visibility(
    hidden: HiddenKeys,
    keys: readonly string[],
    visible: boolean,
    panel: string | undefined,
  ): Map<string, Map<string, boolean>> {
    const { groups } = hidden;
    let changed = false;
    if (panel !== undefined) {
      if (!this.list.some(({ id }) => id === panel))
        throw new RangeError(`setVisibility panel: no panel "${panel}"`);
      const own = new Map(hidden.panels.get(panel));
      // Settings of what keys stand for replace their series' own, in one
      // pass over the series.
      const given = new Set(keys);
      for (const [series, identity] of groups)
        if (given.has(identity) && own.delete(series)) changed = true;
      for (const key of keys) {
        if (own.get(key) !== !visible) changed = true;
        own.set(key, !visible);
      }
      return changed ? new Map(hidden.panels).set(panel, own) : hidden.panels;
    }
    const identity = (key: string) => groups.get(key) ?? key;
    const given = new Set(keys.map(identity));
    const out = new Map<string, Map<string, boolean>>();
    for (const [name, own] of hidden.panels) {
      const kept = new Map([...own].filter(([key]) => !given.has(identity(key))));
      if (kept.size !== own.size) changed = true;
      if (kept.size > 0) out.set(name, kept);
    }
    return changed ? out : hidden.panels;
  }

  /**
   * What is hidden in panel `panel` (the chart's own and what its legend
   * changed there); undefined without a panel, for the chart's.
   */
  hiddenKeys(hidden: HiddenKeys, panel: string | undefined): string[] | undefined {
    if (panel === undefined) return undefined;
    if (!this.list.some(({ id }) => id === panel))
      throw new RangeError(`getHiddenKeys panel: no panel "${panel}"`);
    const keys = new Set([...hidden, ...(hidden.panels.get(panel)?.keys() ?? [])]);
    // What series stand for is hidden there when all of them are: whether
    // all are, by identity, in one pass over the series.
    const all = new Map<string, boolean>();
    for (const [s, identity] of hidden.groups)
      if (keys.has(identity))
        all.set(identity, (all.get(identity) ?? true) && hidden.hiddenIn(s, panel));
    return [...keys].filter((key) => all.get(key) ?? hidden.hiddenIn(key, panel));
  }

  /**
   * What a scene draws as hidden in panel `panel` (see `HiddenKeys.snapshot`),
   * where its legend showed or hid series or what they stand for unlike the
   * chart; undefined where it did not.
   */
  snapshot(hidden: HiddenKeys, panel: string): ReadonlySet<string> | undefined {
    const own = hidden.panels.get(panel);
    if (!own) return undefined;
    const keys = hidden.snapshot();
    const set = (key: string, hide: boolean) => (hide ? keys.add(key) : keys.delete(key));
    for (const [key, entry] of hidden.groups) {
      const local = own.get(key) ?? own.get(entry);
      if (local !== undefined) set(key, local);
    }
    for (const [key, hide] of own) set(key, hide);
    return keys;
  }

  /**
   * What panels' legends set (`panels`), of panels the chart still has and
   * of keys `keeps` keeps (those of marks it still draws); undefined when
   * that is all of it.
   */
  prune(
    panels: ReadonlyMap<string, ReadonlyMap<string, boolean>>,
    keeps: (key: string) => boolean,
  ): Map<string, Map<string, boolean>> | undefined {
    let changed = false;
    const out = new Map<string, Map<string, boolean>>();
    for (const [panel, own] of panels) {
      const kept = this.list.some(({ id }) => id === panel)
        ? new Map([...own].filter(([key]) => keeps(key)))
        : new Map<string, boolean>();
      if (kept.size !== own.size) changed = true;
      if (kept.size > 0) out.set(panel, kept);
    }
    return changed ? out : undefined;
  }

  /** The `panels` of a visibility event: by panel, the keys its legend hid and showed there. */
  overrides(panels: ReadonlyMap<string, ReadonlyMap<string, boolean>>): {
    panels?: Record<string, { hidden: string[]; shown: string[] }>;
  } {
    if (panels.size === 0) return {};
    const own = (map: ReadonlyMap<string, boolean>, hide: boolean) =>
      [...map].flatMap(([key, hidden]) => (hidden === hide ? [key] : []));
    return {
      panels: Object.fromEntries(
        [...panels].map(([key, map]) => [key, { hidden: own(map, true), shown: own(map, false) }]),
      ),
    };
  }

  /** Whether panels are drawn over others: insets, whose scales are their own unless a scope names them. */
  get insets(): boolean {
    return this.#compiled.places.some(({ inset }) => inset);
  }

  /** The id of the panel inset `id` is drawn over; undefined for panels in cells. */
  parentKey(id: string): string | undefined {
    const parent = this.#compiled.places[this.#compiled.order.indexOf(id)]?.parent;
    return parent === undefined ? undefined : this.#compiled.order[parent];
  }

  /** The panel inset `i` is drawn over; undefined for panels in cells. */
  parentOf(i: number): number | undefined {
    return this.#compiled.places[i]!.parent;
  }

  scopes(config: ScaledConfig): Scopes {
    return scopesOf(config, "panel");
  }

  /** Every panel's instance of a scale under `scope`, numbered in order (see `scopeGroups`). */
  groupsOf(scope: ScaleScope, axis: PanelAxis): number[] {
    return scopeGroups(this.#compiled, scope, `chart ${axis}.scope`);
  }

  /** Whether every panel shares one instance of the scale under `scope`: insets have their own unless named. */
  shares(scope: ScaleScope, axis: PanelAxis): boolean {
    return this.groupsOf(scope, axis).every((g) => g === 0);
  }

  mixed(numbers: Mark, categories: Mark, scale: ScaleName): Error {
    return mixedPanels(numbers, categories, scale, panelOf);
  }

  get remedy(): string {
    return "change the layout";
  }

  /**
   * Rejects marks that name no panel or an unknown one, marks sharing a
   * panel with a layout mark, which has it to itself (a map's layers are
   * one mark), and what panels with axes of their own cannot do yet:
   * zooming or brushing along y. Returns the layout marks drawn.
   */
  check(
    marks: readonly Mark[],
    options: LayoutConfig,
    given: readonly LayoutMark[] = [],
  ): LayoutMark[] {
    const ids = new Set(this.list.map(({ id }) => id));
    const unknown = (mark: Mark | LayoutMark, panel: string) => {
      const index = (options.marks as readonly unknown[]).indexOf(mark);
      return new ChartError({
        code: "unknown-reference",
        path: `marks[${index}].panel`,
        mark: mark.spec.id ?? index,
        message: `${mark.spec.type} panel: no panel "${panel}"; name one of ${[...ids].map((id) => `"${id}"`).join(", ")}`,
      });
    };
    checkLayouts(given, true);
    for (const mark of given) {
      const { panel } = mark.spec;
      if (panel !== undefined && panel !== EVERY_PANEL && !ids.has(panel))
        throw unknown(mark, panel);
    }
    const layouts = given[0] ? given[0].views.inPanels(given, options, true) : [];
    // The panels layout marks have to themselves.
    const held = new Map<string, string>();
    for (const mark of layouts) {
      const { type, panel } = mark.spec;
      if (panel === undefined || panel === EVERY_PANEL)
        throw new Error(
          `${type} panel: expected the id of the panel it draws in; received ${JSON.stringify(panel) ?? "none"}`,
        );
      if (!ids.has(panel)) throw unknown(mark, panel);
      const other = held.get(panel);
      if (other)
        throw new Error(
          `${type} panel: a ${other} mark has panel "${panel}" too; give each a panel of its own`,
        );
      held.set(panel, type);
    }
    if (layouts[0])
      layouts[0].views.interactions(
        layouts,
        options,
        held.size < this.list.length,
        given[0]!.spec.type,
      );
    for (const [i, { id, x, y, yRight }] of this.list.entries())
      if (held.has(id) && (x || y || yRight))
        throw new Error(
          `panels[${i}]: the ${held.get(id)} mark it draws has no axes; drop its x, y, and yRight`,
        );
    for (const [i, panel] of this.list.entries())
      if (panel.camera && !layouts.some((mark) => mark.spec.panel === panel.id && mark.camera))
        throw new Error(
          `panels[${i}].camera: panel "${panel.id}" has no 3D marks; drop camera or add a 3D mark`,
        );
    const [first] = held;
    for (const mark of marks) {
      const { type, panel } = mark.spec;
      if (panel === undefined)
        throw new Error(`${type} panel: missing; give the id of a panel, or "*" for every panel`);
      if (panel !== EVERY_PANEL && !ids.has(panel)) throw unknown(mark, panel);
      if (panel === EVERY_PANEL && first)
        throw new Error(
          `${type} panel: "*" would draw in panel "${first[0]}", which a ${first[1]} mark has to itself; give the id of a panel with axes`,
        );
      if (held.has(panel))
        throw new Error(
          `${type} panel: a ${held.get(panel)} mark has panel "${panel}" to itself; name another`,
        );
    }
    // Panels with axes zoom, pan, and brush along x; maps and networks with panels to themselves, their plane.
    const along = held.size < this.list.length && alongY(options.interaction, true);
    if (along)
      throw new Error(
        `chart interaction.${along[0]}: charts with panels zoom, pan, and brush along x only; use "x"`,
      );
    const scopes = this.scopes(options);
    this.#agree("x", marks, scopes.x, options.x, held);
    this.#agree("y", marks, scopes.y, options.y, held);
    this.#agree("yRight", marks, scopes.yRight, options.yRight, held);
    checkBands(marks, options, scopes);
    return layouts;
  }

  /** Panels draw their marks whole. */
  splits(): boolean {
    return false;
  }

  /**
   * Panels sharing a scale must agree on how it is set up: as the chart's
   * settings with their own, and for y with the type their marks on that
   * side give. An x scale takes the chart's type unless they set one.
   * Titles, `show`, and grid lines are each panel's own. Panels a layout
   * mark has (`held`) have no axes, and panels without marks on the right
   * axis none there, and so nothing to agree on.
   */
  #agree(
    axis: PanelAxis,
    marks: readonly Mark[],
    scope: ScaleScope,
    chart: AxisOptions | undefined,
    held: ReadonlyMap<string, string>,
  ): void {
    if (scope === "panel") return;
    const groupOf = this.groupsOf(scope, axis);
    const first = new Map<number, string>();
    const x = axis === "x";
    this.list.forEach(({ id }, i) => {
      if (held.has(id)) return;
      const spec = this.panelAxis(axis, i, chart);
      const inPanel = marks.filter(({ spec }) => spec.panel === id || spec.panel === EVERY_PANEL);
      // Panels without the axis (as the chart draws them) have nothing to agree on.
      if (!x && !yAxesOf(inPanel)[axis === "y" ? "left" : "right"]) return;
      const drawn = inPanel.filter((mark) => onAxis(mark, axis));
      const type = spec?.type ?? (x ? undefined : typeOf(drawn, "y"));
      const { domain, zero, nice, ticks, format, tooltipFormat } = spec ?? {};
      const policy = JSON.stringify(
        [type, domain, zero, nice, ticks, format, tooltipFormat],
        // Tick generators and formatters agree when they are the same function.
        (_, value) => (typeof value === "function" ? `function ${functionId(value)}` : value),
      );
      const seen = first.get(groupOf[i]!);
      if (seen === undefined) first.set(groupOf[i]!, policy);
      else if (seen !== policy)
        throw new Error(
          `panels[${i}].${axis}: shares ${x ? "an x" : axis === "y" ? "a y" : "a right y"} scale with others but differs in type, domain, zero, nice, ticks, format, or tooltipFormat; match them`,
        );
    });
  }

  /** A chart's splitter, which keeps its panels' categories (see PanelBands). */
  splitter(): PanelSplitter {
    const placed = new PanelBands();
    return {
      split: (base, chart, bands, context) => this.#split(base, chart, bands, context, placed),
    };
  }

  /** Every mark in the panels it names, with all of its series there; layout marks alone. */
  #split(
    base: readonly MarkSeries[],
    chart: PanelChart,
    bands: Bands,
    context: BandContext,
    placed: PanelBands,
  ): PanelSplit {
    const members = this.list.map(({ id }) =>
      base.map(({ mark }) => mark.spec.panel === id || mark.spec.panel === EVERY_PANEL),
    );
    // What names a panel for people (its title, or its id): an inset's says which panel it is over.
    const labels = this.list.map(({ id, title }) => titleText(title) ?? id);
    const split: PanelSplit = {
      keys: this.list.map(({ id }) => id),
      values: labels.map((label, i) => {
        const parent = this.parentOf(i);
        return [parent === undefined ? label : `${label}, inset of ${labels[parent]}`];
      }),
      dimensions: [],
      panels: members.map((drawn) =>
        base.map(({ mark, series }, m) => ({ mark, series: drawn[m] ? series : [] })),
      ),
      members,
      all: [...base],
    };
    const { marks } = chart.config;
    const items = this.list.map(({ id }) => {
      const mark = chart.layouts.find(({ spec }) => spec.panel === id);
      return mark && { mark, index: mark.indices?.[0] ?? marks.indexOf(mark), rows: undefined };
    });
    if (items.some(Boolean)) split.items = items;
    placed.place(
      split,
      (scope, axis) => this.groupsOf(scope, axis),
      bands,
      this.scopes(chart.config),
      context,
    );
    return split;
  }

  grid(split: PanelSplit, lineHeight: number): PanelGrid {
    const titled = this.list.some(({ title }) => title);
    return {
      ...lowestWithAxes(split, 1),
      columns: 1,
      rows: 1,
      header: titled ? lineHeight + 4 : 0,
      columnHeader: 0,
      rowHeader: 0,
    };
  }

  /** A panel's title above it (and its legends there), at the start of its plot's width unless its paint's `align` says. */
  headers(
    index: number,
    _values: readonly string[],
    _row: number,
    _column: number,
    plot: Rect,
    grid: PanelGrid,
    paint: TextPaint,
    _aside: number,
    surface: string,
    measure: MeasureText,
    key: string,
  ): HeaderGuide[] {
    const title = titleText(this.list[index]?.title);
    if (!grid.header || !title) return [];
    return headerGuides(key, paint, surface, measure, (fit) => {
      const { at, anchor } = aligned(paint.align ?? "start", plot.x, plot.width);
      const y = plot.y - this.#cells.lift(index) - grid.header / 2;
      return [{ text: fit(title, plot.width), x: at, y, anchor, angle: 0 }];
    });
  }

  /** The chart's `x`, `y`, or `yRight`, with the panel's own settings in place of its. */
  panelAxis(
    axis: PanelAxis,
    index: number,
    chart: AxisOptions | undefined,
  ): AxisOptions | undefined {
    const own = this.list[index]?.[axis];
    return own ? { ...chart, ...own } : chart;
  }

  /**
   * A group's axis is its first panel's, which the others agree with (see
   * `check`), of the type the marks its panels draw give unless that panel
   * sets one: categories in one subplot leave another's scale alone.
   */
  groups(
    scope: ScaleScope,
    split: PanelSplit,
    _columns: number,
    axis: PanelAxis,
    chart: AxisOptions | undefined,
  ): ScaleGroups {
    const found = groups(this.groupsOf(scope, axis), split, axis);
    return typedGroups(found, axis, (g) => this.panelAxis(axis, found.first[g]!, chart), panelOf);
  }

  across(
    split: PanelSplit,
    groupOf: readonly number[],
    by: readonly number[],
  ): [number, MarkSeries[]][][] {
    return across(split, groupOf, by);
  }

  annotations(
    views: readonly AnnotatedPanel[],
    marks: readonly Mark[],
    describe: DescribeAnnotation,
    panel?: string,
  ): string[] {
    return annotations(views, marks, describe, true, panel);
  }

  describe(labels: readonly string[], max: number): string {
    const named = labels.slice(0, max).join(", ");
    const more = labels.length > max ? `, and ${labels.length - max} more` : "";
    return `Panels: ${named}${more}.`;
  }
}

/** A time axis when marks place times along `axis`; else a linear one. */
function typeOf(marks: readonly Mark[], axis: "x" | "y"): AxisType {
  return marks.some((mark) => mark.channelKind(axis) === "time") ? "time" : "linear";
}

/** The one panel a mark draws in, for errors; undefined for marks drawn in every panel. */
function panelOf({ spec }: Mark): string | undefined {
  return spec.panel === EVERY_PANEL ? undefined : spec.panel;
}
