// The interaction controller: pointer, wheel, and keyboard handling, and
// what they draw over the chart (crosshairs, points, item outlines, the
// tooltip, brushes, and crosshair labels). Charts load this module once,
// after their first frame or at the first input, and keep the input that
// arrives before it (chart.ts, `#hold`), which the controller then plays
// through its handlers. What the chart is (its state, inspection, views,
// selections, and their events) stays in chart.ts, which the controller
// changes through its host.

import type { AxisFormat } from "../marks/mark.ts";
import type { lowerPosition, placeAt, rowOf, Series, samePositions, xAt } from "../marks/series.ts";
import { type Binding, Bindings } from "../model/bindings.ts";
import { cursorAxis, inspectPosition, keyboardStops, stepCell } from "../model/keyboard.ts";
import type { ChartModel, DrawnPanel, Inspection, YViewport } from "../model/model.ts";
import type { RowLink } from "../model/row-selection.ts";
import type { SelectionOwner } from "../model/selected-rows.ts";
import { inspectSnapped } from "../model/snap.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { PlotRect, Scene, tickLabelGap } from "../scene/scene.ts";
import type { CursorShowSpec, CursorSnap, ZoomSpec } from "../spec/spec.ts";
import type { surface } from "../theme.ts";
import type { CrosshairLabels } from "./axis-labels.ts";
import type { Brush } from "./brush.ts";
import type { Selection } from "./brushed.ts";
import type { ChartOptions } from "./chart.ts";
import type { Emitter, ViewCause } from "./events.ts";
import type { CursorPosition } from "./handle.ts";
import type { svgElement } from "./svg-layer.ts";
import { describeInspection, Tooltip } from "./tooltip.ts";

// Layout controls compile their bindings with this module's class
// (layout-controls.ts), which keeps it in this module's chunk: in a chunk
// of its own, it would be one more round trip before the first input.
export { Bindings };

/**
 * Code the controller shares with the chart, handed to it so that loading
 * the controller moves none of it out of the chart's bundle.
 */
export interface InteractionKit {
  svgElement: typeof svgElement;
  placeAt: typeof placeAt;
  rowOf: typeof rowOf;
  lowerPosition: typeof lowerPosition;
  xAt: typeof xAt;
  samePositions: typeof samePositions;
  surface: typeof surface;
  tickLabelGap: typeof tickLabelGap;
  /** Keys the keyboard cursor and selections answer to. */
  keys: readonly string[];
  /** Below this many pixels, a press is a click rather than a drag. */
  dragThreshold: number;
}

/** What a chart lends its controller. */
export interface InteractionHost {
  readonly root: HTMLDivElement;
  readonly model: ChartModel;
  /** The pointer overlay of the chart's SVG layer. */
  readonly overlay: SVGGElement;
  /** The live region, which reads sentences aloud. */
  readonly live: HTMLElement;
  /** The legend's element, whose presses and clicks are its own. */
  readonly legend: HTMLElement;
  readonly events: Emitter;
  /** Unique in the page: prefixes the ids the controller's drawings need. */
  readonly id: string;
  options(): ChartOptions;
  /** The scene on screen, undefined before the first. */
  scene(): Scene | undefined;
  /** Draws the overlay again on the next frame. */
  schedule(): void;
  /** Tells of code the controller could not load, as the chart tells of what fails. */
  report(error: unknown): void;
  /** Draws the scene again on the next frame. */
  invalidate(): void;
  /** Ends the frame without drawing the data: keeps the selection, then draws the overlay. */
  finishFrame(): void;
  /** Draws pending changes now, values on their way shown where they go. */
  current(): void;
  /** Whether changes since the last frame (options, data, size) may change the panels or their scales. */
  stale(): boolean;
  /** Shows values on their way where they go, before input reads them. */
  showValues(): void;
  /** Ends a change of view or values playing and draws where it was going. */
  settle(): void;
  animated(change: () => void): void;
  /** One change of view, reported once; with `shareX`, shared with synced charts. */
  changeView(change: () => void, shareX: boolean, cause: ViewCause): void;
  /** Sets the selection in panel `at`, as one of the chart's own, sharing it with synced charts. */
  select(selection: Selection | null, at?: DrawnPanel): void;
  selection(): Selection | null;
  owner(): SelectionOwner | null;
  rows(): RowLink | undefined;
  /** The brush, once loaded: it draws drags and the selection. */
  brush(): Brush | undefined;
  /** The scale the chart's cursor channel carries, when it syncs its cursor. */
  cursorScale(): "x" | "y" | "xy" | undefined;
  /** Shares the value under the pointer (a category by name) with synced charts; null for none. */
  shareCursor(value: number | string | null): void;
  /** The cursor a synced chart shares or `showCursor` shows, or null. */
  cursor(): ShownCursor | null;
  /** What last changed the view or what bounds it. */
  cause(): ViewCause;
}

/**
 * A cursor the chart shows that is not its pointer's: where, and with
 * `showCursor`, how it shows (else as the cursor channel says).
 */
export interface ShownCursor {
  at: CursorPosition;
  shown?: CursorShowSpec;
}

/** Where the keyboard cursor is: a panel, a series, and a position in the series' part in the panel. */
export interface KeyboardCursor {
  panel: string;
  key: string;
  position: number;
  /** What it last announced: where the cursor was, should its series go (hidden) before the next key. */
  last?: Inspection;
}

/**
 * A primary-button press on a plot until release: where it started, the
 * panel (and so the scales) it started in, and what dragging does.
 */
interface Press {
  x: number;
  y: number;
  panel: DrawnPanel;
  mode: "pan" | "brush" | "cursor" | "click";
  /** What the press's binding does. */
  action: Binding["action"] | undefined;
  moved: boolean;
  /** The view when it started and the last its pan set, which Escape goes back from to the first. */
  from: View;
  last?: View;
}

/** The view of a panel's x scale and the y axes', as a press saw it. */
type View = readonly [x: readonly [number, number] | null, y: YViewport];

/** A two-finger pinch: the fingers' distance and middle when last moved, and the panel and axes it zooms. */
interface Pinch {
  distance: number;
  middle: { x: number; y: number };
  panel: DrawnPanel;
  axes: ZoomSpec | undefined;
}

/**
 * A panel's pixels as values of the view it shows (`#shown`): along x, y,
 * and the right y axis when it has one.
 */
interface Shown {
  panel: DrawnPanel;
  x(pixel: number): number;
  y(pixel: number): number;
  yRight: ((pixel: number) => number) | undefined;
}

/**
 * Values at the pixels of a scale's range for `view`, a view asked for
 * since the scale was drawn (null: the one drawn), read through the drawn
 * scale's pixels, which the view's ends span: so steps taken between frames
 * add up without drawing, on any scale type.
 */
function inverter(
  scale: PositionScale,
  view: readonly [number, number] | null,
): (pixel: number) => number {
  if (!view) return (pixel) => scale.invert(pixel);
  // Views are ascending; axes show them the way their domains run.
  const [a, b] = scale.domain[0] <= scale.domain[1] ? view : [view[1], view[0]];
  const [r0, r1] = scale.range;
  const p0 = scale.map(a);
  const p1 = scale.map(b);
  return (pixel) => scale.invert(p0 + ((pixel - r0) * (p1 - p0)) / (r1 - r0));
}

/** The bindings of a chart's options, compiled; throws for those it refuses. */
function bindingsOf({ interaction, rowSelection }: ChartOptions): Bindings {
  const brushesRows = rowSelection?.bindings.some(({ events }) => events.includes("brush"));
  return new Bindings(interaction, brushesRows);
}

/** What the controller acts on along axes; layout marks' controls take the rest. */
const OWN = ({ type }: Binding["action"]) => type !== "orbit" && type !== "moveItem";

export class Interaction {
  readonly #host: InteractionHost;
  readonly #kit: InteractionKit;
  /** The gestures the chart's `interaction` binds. */
  #bindings: Bindings;
  readonly #tooltip: Tooltip;
  /** Tooltips of other panels showing the cursor (`sync.panels.tooltip`), made as needed. */
  readonly #tips: Tooltip[] = [];
  /** What the keyboard's cursor shared with the cursor channel and the charts there show, or null. */
  #keyShared: number | string | null = null;
  /** A crosshair per panel shown; the first stays, hidden, when none is. */
  readonly #crosshairs: SVGLineElement[];
  readonly #dots: SVGGElement;
  /** Outlines the item inspected in charts of a layout mark (a pie slice). */
  readonly #outline: SVGPathElement;
  /** Labels on the axes at the crosshair, once loaded for `tooltip.axisLabels`; null if it failed to load. */
  #crosshair: CrosshairLabels | null | undefined;
  #crosshairLoading: Promise<void> | undefined;
  /** Whether the tooltip shows tooltip fields and `renderTooltip`'s content. */
  #content: Promise<void> | undefined;
  #pointer: { x: number; y: number } | null = null;
  #keyboard: KeyboardCursor | null = null;
  #press: Press | null = null;
  /** Where each touch is, for pinches. */
  readonly #touches = new Map<number, { x: number; y: number }>();
  #pinch: Pinch | null = null;
  /** A press in a chart of a layout mark, which has nothing to drag: a click if released in place. */
  #tap: { pointer: number; x: number; y: number; moved: boolean } | null = null;
  /** Where a keyboard selection (Shift + arrows) started: a value along the cursor's axis and its label. */
  #brushAnchor: { value: number; label: string; axis: "x" | "y" } | null = null;
  /** What the last hover event reported, to emit only changes. */
  #hovered = "";
  /**
   * The ends each scale instance's view is near, by scale, group, and side:
   * the bound it came near, until it moves away or the bound moves.
   */
  readonly #edges = new Map<string, number>();
  /** Whether the views' edges are reported on the next frame, drawn or not: the first after attaching. */
  #edgesDue = true;
  /** The views each panel's frame drew, by panel: what input between frames starts from. */
  readonly #framed = new Map<string, View>();
  /** What the input being handled is, as views changed report it. */
  #cause: ViewCause = "pointer";
  /** Handlers by event type, which play held input too. */
  readonly #handlers = new Map<string, (event: never) => void>();
  readonly #cleanup: (() => void)[] = [];
  #disposed = false;

  constructor(host: InteractionHost, kit: InteractionKit) {
    this.#host = host;
    this.#kit = kit;
    // Bindings it refuses throw before anything is installed.
    this.#bindings = bindingsOf(host.options());
    const { svgElement } = kit;
    const document = host.root.ownerDocument;
    this.#tooltip = new Tooltip(document);
    host.root.append(this.#tooltip.element);
    this.#crosshairs = [
      svgElement(document, "line", { "stroke-width": "1", visibility: "hidden" }),
    ];
    this.#dots = svgElement(document, "g");
    this.#outline = svgElement(document, "path", {
      fill: "none",
      "stroke-width": "2",
      "stroke-linejoin": "round",
      visibility: "hidden",
    });
    host.overlay.append(...this.#crosshairs, this.#dots, this.#outline);
    this.#listen();
    this.configure(this.#bindings);
  }

  /** Whether the pointer or keyboard is on the chart, or a press is in progress. */
  get busy(): boolean {
    return !!(this.#pointer || this.#keyboard || this.#press || this.#tap);
  }

  get keyboard(): KeyboardCursor | null {
    return this.#keyboard;
  }

  /** The x scale of the panel a press drags in, while it does. */
  get dragged(): string | undefined {
    return this.#press?.panel.xGroup;
  }

  /** Pending while the crosshair labels or the tooltip's content load. */
  get loading(): Promise<unknown>[] {
    return [this.#crosshairLoading, this.#content].filter((loading) => loading !== undefined);
  }

  /** Throws for bindings of `options` it would refuse, as `configure` does, changing nothing. */
  check(options: ChartOptions): void {
    bindingsOf(options);
  }

  /**
   * Follows the chart's options, loading what they ask for; throws, before
   * changing anything, for bindings it refuses (a gesture bound twice, a key
   * the cursor takes).
   */
  configure(bindings = bindingsOf(this.#host.options())): void {
    const host = this.#host;
    const options = host.options();
    this.#bindings = bindings;
    host.root.style.touchAction = this.#touchPolicy();
    // Labels that failed to load are tried again.
    if (this.#crosshair === null) this.#crosshair = undefined;
    if (typeof options.tooltip === "object" && options.tooltip.axisLabels) this.#loadCrosshair();
    if (options.renderTooltip || options.marks.some((mark) => mark.spec.tooltip))
      this.#loadContent();
  }

  /**
   * Plays input the chart held while this loaded, in order. Presses, wheels,
   * and double clicks on a layout mark's panels are its controls', which
   * were not there to take them: those are dropped, as hovers are not.
   */
  play(held: readonly Event[]): void {
    const controlled = !!this.#host.model.items?.asked().length;
    const rect = this.#host.root.getBoundingClientRect();
    for (const event of held) {
      const gesture = event instanceof MouseEvent && event.type !== "pointermove";
      if (
        controlled &&
        gesture &&
        this.#onItems(event.clientX - rect.left, event.clientY - rect.top)
      )
        continue;
      this.#handlers.get(event.type)?.(event as never);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const stop of this.#cleanup) stop();
  }

  /**
   * Draws the cursor and tooltip and reports what is hovered when it
   * changed; after a frame of the data (`frame`), views near their limits.
   */
  draw(frame = false): void {
    const host = this.#host;
    if (frame) {
      this.#framed.clear();
      for (const panel of host.model.panels()) this.#framed.set(panel.key, this.#view(panel));
      // What touches do depends on the panels drawn, which the first scene brings.
      const touch = this.#touchPolicy();
      if (host.root.style.touchAction !== touch) host.root.style.touchAction = touch;
    }
    if (frame || this.#edgesDue) {
      this.#edgesDue = false;
      this.#reportEdges();
    }
    const scene = host.scene();
    if (!scene) return;
    const { theme } = scene;
    const panels = host.model.panels();
    const options = host.options();
    const showTooltip = options.tooltip ?? true;
    // Hover listeners get the inspection even without the built-in tooltip,
    // which is how applications draw their own.
    const hovering = host.events.has("hover");
    const active = showTooltip || hovering ? this.#inspection() : undefined;
    this.#shareKeyboard(active);
    // The cursor shows in the chart's other panels too (`sync.panels`). A
    // cursor another chart shares, or `showCursor` shows, shows in every
    // panel, with one tooltip when it asks for it.
    const across = this.#across(active);
    const shown = active ? [active, ...across] : this.#synced();
    const sync = options.interaction?.sync;
    const acrossTips =
      typeof sync === "object" && typeof sync.panels === "object" && sync.panels.tooltip;
    const tips = new Set<Inspection>(
      showTooltip
        ? active
          ? [active, ...(acrossTips ? across : [])]
          : this.#showing(host.cursor()).tooltip
            ? shown.filter(({ points }) => points.length > 0).slice(0, 1)
            : []
        : [],
    );
    if (hovering) {
      const key = inspectionKey(shown[0]);
      if (key !== this.#hovered) {
        this.#hovered = key;
        host.events.emit("hover", { inspection: shown[0] });
      }
    }
    const { svgElement, tickLabelGap, surface } = this.#kit;
    const document = host.root.ownerDocument;
    const lines = this.#crosshairs;
    const drawn = showTooltip || !active ? shown : [];
    while (lines.length < drawn.length) {
      const line = svgElement(document, "line", { "stroke-width": "1" });
      this.#dots.before(line);
      lines.push(line);
    }
    const dots: SVGCircleElement[] = [];
    let tipped = 0;
    this.#outline.setAttribute("visibility", "hidden");
    const bounds = { width: scene.width, height: scene.height };
    for (const [i, line] of lines.entries()) {
      const inspection = drawn[i];
      if (!inspection || inspection.axis === "item") line.setAttribute("visibility", "hidden");
      if (!inspection) continue;
      // Items are outlined instead of crossed, and their tooltip points at them.
      if (inspection.axis === "item") {
        this.#outline.setAttribute("d", inspection.outline);
        this.#outline.setAttribute("stroke", theme.text);
        this.#outline.setAttribute("visibility", "visible");
        const [item] = inspection.points;
        const anchor = this.#pointer ?? { x: item!.px, y: item!.py };
        if (tips.has(inspection)) this.#tip(tipped++).show(inspection, theme, anchor, bounds);
        continue;
      }
      const { plot } = panels.find(({ key }) => key === (inspection.panel ?? "")) ?? panels[0]!;
      // The crosshair crosses the plot at the inspected position: a vertical
      // line for x, a horizontal one for y.
      const at = String(Math.round(inspection.position) + 0.5);
      const vertical = inspection.axis === "x";
      line.setAttribute("x1", vertical ? at : String(plot.x));
      line.setAttribute("x2", vertical ? at : String(plot.x + plot.width));
      line.setAttribute("y1", vertical ? String(plot.y) : at);
      line.setAttribute("y2", vertical ? String(plot.y + plot.height) : at);
      line.setAttribute("stroke", theme.axis);
      line.setAttribute("visibility", "visible");
      // A bar may end outside the plot; its marker would land on the axes.
      const inside = (point: { px: number; py: number }) =>
        point.px >= plot.x - 0.5 &&
        point.px <= plot.x + plot.width + 0.5 &&
        point.py >= plot.y - 0.5 &&
        point.py <= plot.y + plot.height + 0.5;
      for (const point of inspection.points.filter(inside)) {
        dots.push(
          svgElement(document, "circle", {
            cx: String(point.px),
            cy: String(point.py),
            r: "3.5",
            fill: point.color,
            stroke: theme.background === "transparent" ? "#ffffff" : theme.background,
            "stroke-width": "1.5",
          }),
        );
      }
      // The pointer's tooltip is at the pointer; others' at the crosshair.
      if (tips.has(inspection)) {
        const anchor =
          (inspection === active && this.#pointer) ||
          (vertical
            ? { x: inspection.position, y: plot.y + plot.height / 2 }
            : { x: plot.x + plot.width / 2, y: inspection.position });
        this.#tip(tipped++).show(inspection, theme, anchor, bounds);
      }
    }
    this.#dots.replaceChildren(...dots);
    const tooltip = options.tooltip;
    const crosshair = this.#crosshair;
    if (crosshair && typeof tooltip === "object" && tooltip.axisLabels) {
      // The pointer's or keyboard's cursor labels its own panel's axes alone.
      crosshair.draw(active ? [active] : drawn, active, this.#pointer, {
        model: host.model,
        scene,
        labelGap: tickLabelGap(theme.fontSize),
        surface: surface(theme),
      });
    } else {
      crosshair?.hide();
    }
    // Tooltips not shown this frame hide: the chart's own first, then those of other panels.
    for (const tip of [this.#tooltip, ...this.#tips].slice(tipped)) tip.hide();
  }

  /**
   * The `i`th tooltip shown this frame: the chart's own, then one per other
   * panel showing the cursor with `sync.panels.tooltip`, made as needed.
   */
  #tip(i: number): Tooltip {
    if (i === 0) return this.#tooltip;
    let tip = this.#tips[i - 1];
    if (!tip) {
      tip = new Tooltip(this.#host.root.ownerDocument);
      this.#host.root.append(tip.element);
      this.#tips.push(tip);
    }
    return tip;
  }

  /**
   * Shares where the keyboard's cursor is with the charts of the cursor
   * channel, as the pointer's is shared: when it moves, and none once it
   * leaves. The pointer's own takes over while it is on the chart.
   */
  #shareKeyboard(active: Inspection | undefined): void {
    const host = this.#host;
    const axis = this.#cursorAxis();
    if (this.#pointer || host.cursorScale() !== axis) return;
    const panel = host.model.panels().find(({ key }) => key === (active?.panel ?? ""));
    const scale = panel?.[axis];
    const value =
      this.#keyboard && active?.axis === axis && scale
        ? scale.categories
          ? (scale.categories[active.value] ?? null)
          : active.value
        : null;
    if (value === this.#keyShared) return;
    this.#keyShared = value;
    host.shareCursor(value);
  }

  /**
   * What touches the chart leaves to the browser: the axis its touch drags
   * do not move along, and pinches, where no binding takes them.
   */
  #touchPolicy(): string {
    const kinds = new Set(this.#host.model.items?.asked().map(({ kind }) => kind));
    const plane = kinds.has("map") || kinds.has("drag");
    const touch = { shiftKey: false, ctrlKey: false, altKey: false, metaKey: false };
    // Pans and brushes take axes or a map's or network's plane; orbits a 3D chart.
    const axes = this.#host.model.panels().length > 0;
    const action = this.#bindings.match(
      "drag",
      { ...touch, button: 0, pointerType: "touch" },
      (a) =>
        a.type === "orbit"
          ? kinds.has("orbit")
          : a.type === "moveItem"
            ? kinds.has("drag")
            : a.type === "pageScroll" || axes || plane,
    )?.action;
    const along =
      action?.type === "pan"
        ? (action.axes ?? (plane ? "xy" : "x"))
        : action?.type === "brush"
          ? action.shape === "lasso"
            ? "xy"
            : (action.shape ?? "x")
          : action?.type === "orbit" || action?.type === "cursor"
            ? "x"
            : action?.type === "moveItem"
              ? "xy"
              : "";
    // Pinches zoom along axes. Charts that drag both ways (maps, networks)
    // take them too, doing nothing, unless a binding leaves them to the page.
    const pinch = this.#bindings.match("pinch", touch)?.action.type;
    const pinches = axes && pinch === "zoom";
    const [x, y] = [along.includes("x"), along.includes("y")];
    return x && y
      ? pinch === "pageScroll"
        ? "pinch-zoom"
        : "none"
      : x
        ? `pan-y${pinches ? "" : " pinch-zoom"}`
        : y
          ? `pan-x${pinches ? "" : " pinch-zoom"}`
          : pinches
            ? "pan-x pan-y"
            : "";
  }

  /**
   * Reports each scale instance whose view came within its limits'
   * threshold of an end (`interaction.limits`, `edge`), once until it is
   * farther away than the threshold and hysteresis again.
   */
  #reportEdges(): void {
    const limits = this.#host.options().interaction?.limits;
    const edges = this.#edges;
    if (!limits) {
      edges.clear();
      return;
    }
    const { model, events } = this.#host;
    const panels = model.panels();
    const seen = new Set<string>();
    for (const name of ["x", "y", "yRight"] as const) {
      const { edge, extent } = limits[name] ?? {};
      if (!edge) continue;
      const { threshold = 0.1, hysteresis = 0.05 } = edge === true ? {} : edge;
      const groupOf = (panel: DrawnPanel) => panel[`${name}Group`];
      for (const panel of panels) {
        const scale = panel[name];
        const group = groupOf(panel);
        if (!scale || scale.type === "band" || panels.find((p) => groupOf(p) === group) !== panel)
          continue;
        // A view fitted to the data is at the data's ends: only the extent bounds it then.
        // The data bounds a zoomed x scale every panel shares.
        const zoomed = name === "x" && model.sharesX && model.viewportOf(panel.key);
        const data = zoomed ? model.dataXExtent() : undefined;
        const domain = [Math.min(...scale.domain), Math.max(...scale.domain)] as const;
        // Log axes measure by ratios, where ends that are not positive bound nothing (as limits do).
        const to = scale.type === "log" ? Math.log : Number;
        const span = to(domain[1]) - to(domain[0]);
        for (const end of [0, 1] as const) {
          const bound = extent?.[end] ?? data?.[end];
          const distance =
            bound == null
              ? Number.NaN
              : end
                ? to(bound) - to(domain[1])
                : to(domain[0]) - to(bound);
          if (!Number.isFinite(distance)) continue;
          const key = `${name} ${group} ${end}`;
          seen.add(key);
          // Near the same bound, the view reports again once it has moved away.
          // A listener's own frame may have reported it already: the latch is shared.
          if (edges.get(key) === bound) {
            if (distance > (threshold + hysteresis) * span) edges.delete(key);
            continue;
          }
          edges.delete(key);
          if (distance > threshold * span) continue;
          // Latched before listeners run, which may load and draw at once.
          edges.set(key, bound!);
          const keys = panels.filter((p) => groupOf(p) === group).map(({ key }) => key);
          events.emit("edge", {
            scale: name,
            side: end ? "end" : "start",
            domain,
            bound: bound!,
            ...(group && { panels: keys }),
            cause: this.#host.cause(),
          });
        }
      }
    }
    // Ends no longer limited, or of scales no longer drawn, are let go.
    for (const key of edges.keys()) if (!seen.has(key)) edges.delete(key);
  }

  /** The point the pointer or the keyboard is on. */
  #inspection(): Inspection | undefined {
    const { model } = this.#host;
    if (!this.#host.scene()) return undefined;
    // A chart being turned, panned, or dragged shows no tooltip.
    if (model.items?.busy) return undefined;
    // The model applies the configured tooltip mode.
    if (this.#pointer) return model.inspect(this.#pointer.x, this.#pointer.y);
    const keyboard = this.#keyboard;
    if (keyboard)
      return (
        model.inspectItem(keyboard.key, keyboard.panel) ??
        inspectPosition(model, keyboard.key, keyboard.position, keyboard.panel, this.#kit)
      );
    return undefined;
  }

  /**
   * Each panel's points at the cursor another chart shares or `showCursor`
   * shows: along the axis the chart's data is placed on, at a value on it
   * (a category by name on category axes).
   */
  #synced(): Inspection[] {
    const { model } = this.#host;
    const cursor = this.#host.cursor();
    const axis = this.#cursorAxis();
    if (!cursor || !(axis in cursor.at) || model.series().length === 0) return [];
    const value = (cursor.at as Record<string, number | string>)[axis]!;
    return this.#cursorAt(value, axis, this.#showing(cursor).snap ?? "nearest", model.panels());
  }

  /** How a cursor the chart did not make shows: as `showCursor` said, else as its cursor channel says. */
  #showing(cursor: ShownCursor | null): CursorShowSpec {
    const sync = this.#host.options().interaction?.sync;
    const channel = typeof sync === "object" ? sync.cursor : undefined;
    const given = typeof channel === "object" ? channel : {};
    return { ...given, ...cursor?.shown };
  }

  /**
   * Each of `panels`' points at `value` along `axis` (a category by name on
   * category axes), read as `snap` says: none where the value is out of a
   * panel's view or in a break its axis leaves out.
   */
  #cursorAt(
    value: number | string,
    axis: "x" | "y",
    snap: CursorSnap,
    panels: readonly DrawnPanel[],
  ): Inspection[] {
    const { model } = this.#host;
    return panels.flatMap((panel) => {
      const scale = panel[axis];
      const { plot } = panel;
      const named = typeof value === "string";
      const at = named ? (scale.categories?.indexOf(value) ?? -1) : value;
      // Categories go by name, other values by number; a time an axis break
      // leaves out has no place.
      if ((named ? at < 0 : scale.categories) || scale.breaks?.hides(at)) return [];
      const px = scale.map(at);
      // Outside a panel's range, the pixel would land in a neighboring panel.
      const [from, length] = axis === "x" ? [plot.x, plot.width] : [plot.y, plot.height];
      if (!(px >= from && px <= from + length)) return [];
      const inspection =
        (snap === "previous" || snap === "next") && axis === "x" && !scale.categories
          ? inspectSnapped(model, panel.key, at, snap, this.#kit)
          : axis === "x"
            ? model.inspect(px, plot.y + plot.height / 2, "nearest-x", panel.key)
            : model.inspect(plot.x + plot.width / 2, px, "nearest-y", panel.key);
      return inspection ? [inspection] : [];
    });
  }

  /**
   * The cursor in the other panels of the chart, where `active` (the
   * pointer's or keyboard's) is in one (`interaction.sync.panels`): at its
   * x in those sharing its x scale, by default, and with `panels` on in
   * those with x scales of their own too, read on each one's scale.
   */
  #across(active: Inspection | undefined): Inspection[] {
    const option = this.#host.options().interaction?.sync;
    const panels = typeof option === "object" ? option.panels : undefined;
    if (active?.axis !== "x" || panels === false) return [];
    const all = this.#host.model.panels();
    const from = all.find(({ key }) => key === (active.panel ?? ""));
    if (!from || all.length < 2) return [];
    const show: CursorShowSpec = typeof panels === "object" ? panels : {};
    const others = all.filter(
      (panel) => panel !== from && (panels !== undefined || panel.xGroup === from.xGroup),
    );
    const { categories } = from.x;
    const value = categories ? categories[active.value] : active.value;
    return value === undefined ? [] : this.#cursorAt(value, "x", show.snap ?? "nearest", others);
  }

  /** The axis the chart's data is placed along, which its cursor follows (see `cursorAxis`). */
  #cursorAxis(): "x" | "y" {
    const { model } = this.#host;
    return cursorAxis(model.panels().map(({ key }) => model.inspectorOf(key)));
  }

  /** The value under a pixel of `panel` along `axis`: a category by name on category axes. */
  #valueAt(panel: DrawnPanel, axis: "x" | "y", x: number, y: number): number | string | null {
    const scale = panel[axis];
    const value = scale.invert(axis === "x" ? x : y);
    return scale.categories ? (scale.categories[Math.round(value)] ?? null) : value;
  }

  /** The series of panel `panel` the keyboard stops at (see `keyboardStops`). */
  #stops(panel: string): Series[] {
    return keyboardStops(this.#host.model.inspectorOf(panel), this.#kit.samePositions);
  }

  /** For heatmaps: the cell the keyboard steps to (see `stepCell`). */
  #stepCell(
    panel: string,
    key: string,
    position: number,
    columns: number,
    rows: number,
  ): number | undefined {
    return stepCell(this.#host.model.inspectorOf(panel), key, position, columns, rows);
  }

  #listen() {
    const host = this.#host;
    const root = host.root;
    const DRAG_THRESHOLD = this.#kit.dragThreshold;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      const handle = (event: HTMLElementEventMap[K]) => {
        this.#cause = type === "wheel" ? "wheel" : type === "keydown" ? "keyboard" : "pointer";
        handler(event);
      };
      root.addEventListener(type, handle, options);
      this.#cleanup.push(() => root.removeEventListener(type, handle, options));
      if (!options?.capture) this.#handlers.set(type, handle);
    };
    const local = (event: MouseEvent) => {
      const rect = root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    on("pointermove", (event) => {
      // Inspection reads the new values: they show first.
      host.showValues();
      this.#pointer = local(event);
      this.#keyboard = null;
      this.#brushAnchor = null;
      const press = this.#press;
      const { x, y } = this.#pointer;
      if (this.#touches.has(event.pointerId)) {
        this.#touches.set(event.pointerId, { x, y });
        if (this.#pinch) {
          this.#pinched();
          return;
        }
      }
      const tap = this.#tap;
      // A press that strays is not a click, even if it comes back.
      if (tap?.pointer === event.pointerId)
        tap.moved ||= Math.hypot(x - tap.x, y - tap.y) >= DRAG_THRESHOLD;
      if (press && !this.#still(press.panel)) this.#cancelPress();
      else if (press) {
        press.moved ||= Math.hypot(x - press.x, y - press.y) >= DRAG_THRESHOLD;
        if (press.moved && press.mode === "pan") {
          this.#pan(press, x, y);
          return;
        }
        const brush = host.brush();
        if (press.moved && press.mode === "brush" && brush) {
          if (!brush.dragging) {
            const { action } = press;
            const shape = action?.type === "brush" ? action.shape : undefined;
            brush.mode = shape ?? host.options().interaction?.brush ?? "x";
            brush.start(press.x, press.y, press.panel);
          }
          brush.move(x, y);
        }
      }
      host.schedule();
      // Share the value under the pointer along the axis the data is placed
      // on, if the cursor channel carries it; over no panel, none.
      const axis = this.#cursorAxis();
      if (host.cursorScale() === axis) {
        const panel = this.#panelAt(x, y);
        host.shareCursor(panel ? this.#valueAt(panel, axis, x, y) : null);
        // The charts there show the pointer's now: the keyboard shares again where it is.
        this.#keyShared = null;
      }
    });
    on("pointerleave", (event) => {
      this.#pointer = null;
      // A captured drag leaves only when released; any other press ends here.
      this.#press = null;
      if (this.#tap?.pointer === event.pointerId) this.#tap = null;
      host.brush()?.cancel();
      host.schedule();
      host.shareCursor(null);
    });

    on(
      "wheel",
      (event) => {
        if (!host.scene()) return;
        const point = local(event);
        if (this.#onItems(point.x, point.y)) return;
        // Outside the plots, the wheel acts on the one x scale every panel
        // shares; with several, on none, and the page scrolls.
        const panel =
          this.#panelAt(point.x, point.y) ??
          (host.model.sharesX ? host.model.panels()[0] : undefined);
        const focused = root.ownerDocument.activeElement === root;
        const action = panel && this.#bindings.match("wheel", event, OWN, focused)?.action;
        if (!action || (action.type !== "pan" && action.type !== "zoom")) return;
        event.preventDefault();
        // Steps faster than frames add up, each from the view the last asked for.
        const shown = this.#shown(panel!);
        // Lines and pages are turned into pixels; the wheel moves most along one axis.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? panel!.plot.height : 1;
        const [dx, dy] = [event.deltaX * unit, event.deltaY * unit];
        const along = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        if (action.type === "zoom")
          this.#zoomAt(shown, point, Math.exp(along * 0.002), action.axes);
        else if (action.axes === "xy") this.#move(shown, "xy", dx, dy);
        else this.#move(shown, action.axes, along, along);
      },
      { passive: false },
    );
    on("pointerdown", (event) => {
      // Buttons (the legend's, controls') take their own presses.
      if (!host.scene() || (event.target as Element).closest?.("button")) return;
      // A drag starts from the view it lands in, not one passing by, and
      // from values as they are.
      host.settle();
      host.current();
      const { x, y } = local(event);
      if (event.pointerType === "touch") {
        this.#touches.set(event.pointerId, { x, y });
        if (this.#touches.size === 2 && this.#startPinch(event)) return;
      }
      // Presses on what layout marks draw are clicks, not drags.
      if (host.model.layout || this.#onItems(x, y)) {
        // A second pointer down makes neither a click (a pinch, say).
        if (this.#tap) this.#tap.moved = true;
        else if (event.button === 0) this.#tap = { pointer: event.pointerId, x, y, moved: false };
        return;
      }
      // Presses on the axes, titles, gaps, or legend are not on the data.
      const panel = this.#panelAt(x, y);
      if (!panel) return;
      const action = this.#bindings.match("drag", event, OWN)?.action;
      const type = action?.type;
      const mode = type === "pan" || type === "brush" || type === "cursor" ? type : "click";
      // Other buttons click nothing.
      if (mode === "click" && event.button !== 0) return;
      this.#press = { x, y, panel, mode, action, moved: false, from: this.#view(panel) };
      // Touches are captured where they land, at once.
      if (mode !== "click" && event.pointerType !== "touch")
        root.setPointerCapture?.(event.pointerId);
    });
    on("pointerup", (event) => {
      this.#touches.delete(event.pointerId);
      if (this.#pinch) {
        this.#pinch = null;
        return;
      }
      const tap = this.#tap;
      if (tap) {
        if (tap.pointer !== event.pointerId) return;
        this.#tap = null;
        if (!tap.moved) this.#click(local(event), event);
        return;
      }
      const press = this.#press;
      this.#press = null;
      if (!press) return;
      if (!press.moved) {
        if (event.button === 0 && press.mode !== "cursor") this.#click(local(event), event);
        return;
      }
      if (press.mode !== "brush") return;
      // The release point ends the brush, wherever the last move was.
      const end = local(event);
      const brush = host.brush();
      brush?.move(end.x, end.y);
      const selection = brush?.end() ?? null;
      // The drag outline goes, whether or not the brush selects anything.
      host.schedule();
      // A panel that went while dragging (its facet value did) selects nothing.
      if (!selection || !this.#still(press.panel)) return;
      const zooms = press.action?.type === "brush" && press.action.zoom;
      if (zooms && this.#zoomable(selection, press.panel)) {
        this.#zoomTo(selection, press.panel);
        return;
      }
      host.select(selection, press.panel);
      const selected = host.selection();
      if (selected) {
        const format = host.model.formatsOf(undefined, press.panel.key);
        host.live.textContent = describeSelection(selected, format);
      }
    });
    // A drag the chart makes of a press (a brush, pan, lasso, node move, or
    // turn) captures its pointer at the root. The browser must not drag the
    // page's selection instead, which would end the press: Chrome does when
    // the selection spans the drawing pressed.
    // -1 is no pointer's id: it marks events no pointing device made. A
    // second pointer (a touch beside the mouse) leaves the first one's.
    let pressed = -1;
    on(
      "pointerdown",
      (event) => {
        if (!root.hasPointerCapture?.(pressed)) pressed = event.pointerId;
      },
      { capture: true },
    );
    on("dragstart", (event) => {
      if (root.hasPointerCapture?.(pressed)) event.preventDefault();
    });
    // The browser took the pointer (a touch turned into scrolling, say): a
    // pan keeps where it got, a brush goes. A tap ends only with its own pointer.
    const cancel = (event: PointerEvent) => {
      this.#touches.delete(event.pointerId);
      this.#pinch = null;
      this.#cancelPress();
      if (this.#tap?.pointer === event.pointerId) this.#tap = null;
    };
    on("pointercancel", cancel);
    on("lostpointercapture", (event) => {
      if (this.#press || this.#tap?.pointer === event.pointerId) cancel(event);
    });
    // Double click resets: on a plot, its x scale; elsewhere, every one. The
    // legend's buttons keep their clicks.
    on("dblclick", (event) => {
      if (host.legend.contains(event.target as Node)) return;
      const { x, y } = local(event);
      if (this.#onItems(x, y)) return;
      const panel = this.#panelAt(x, y);
      const action = this.#bindings.match("doubleClick", event, OWN)?.action;
      if (action?.type === "reset") this.#reset(host.model.sharesX ? undefined : panel);
      else if (action?.type === "zoom" && panel)
        this.#zoomAt(this.#shown(panel), { x, y }, 1 / (action.factor ?? 2), action.axes);
    });

    on("keydown", (event) => this.#key(event));
    on("blur", () => {
      this.#keyboard = null;
      this.#brushAnchor = null;
      host.schedule();
    });
  }

  /** Moves a drag's axes by its shift, through the scales of the panel it started in. */
  #pan(press: Press, x: number, y: number) {
    this.#host.settle();
    const { action } = press;
    this.#move(
      this.#drawn(press.panel),
      action?.type === "pan" ? action.axes : undefined,
      press.x - x,
      press.y - y,
    );
    press.last = this.#view(press.panel);
  }

  /**
   * Shows what lies `dx` pixels right and `dy` down of what a panel shows,
   * along `axes` (x by default) of those that pan: not category axes.
   */
  #move(shown: Shown, axes: ZoomSpec | undefined, dx: number, dy: number) {
    const { panel } = shown;
    const { plot } = panel;
    const along = this.#axes(axes, panel);
    // Along y first: a y range the chart refuses changes nothing.
    this.#change(() => {
      if (along.y) this.#zoomY(shown, plot.y + plot.height + dy, plot.y + dy);
      if (along.x)
        this.#host.model.setViewport(
          [shown.x(plot.x + dx), shown.x(plot.x + plot.width + dx)],
          panel.key,
        );
    }, along.x);
  }

  /**
   * Zooms a panel by `scale` (the new view's span over the old) about the
   * pixel `at`, which `to` (a pinch's middle, moved) shows next, along
   * `axes`: in pixel space, inverted, so the value under the pointer stays
   * with it on any scale type, including log.
   */
  #zoomAt(
    shown: Shown,
    at: { x: number; y: number },
    scale: number,
    axes: ZoomSpec | undefined,
    to = at,
  ) {
    const { panel } = shown;
    const { plot } = panel;
    const along = this.#axes(axes, panel);
    const inside = (value: number, from: number, length: number) =>
      Math.min(from + length, Math.max(from, value));
    const [px, py] = [inside(at.x, plot.x, plot.width), inside(at.y, plot.y, plot.height)];
    const [qx, qy] = [inside(to.x, plot.x, plot.width), inside(to.y, plot.y, plot.height)];
    // The pixels of what the view shows now that its edges will show.
    const edge = (side: number, from: number, next: number) => from + (side - next) * scale;
    this.#change(() => {
      if (along.y) this.#zoomY(shown, edge(plot.y + plot.height, py, qy), edge(plot.y, py, qy));
      if (along.x)
        this.#host.model.setViewport(
          [shown.x(edge(plot.x, px, qx)), shown.x(edge(plot.x + plot.width, px, qx))],
          panel.key,
        );
    }, along.x);
  }

  /** Back to the configured view: of `panel`'s x scale, or of every one, and of the y axes. */
  #reset(panel: DrawnPanel | undefined) {
    const host = this.#host;
    host.animated(() =>
      this.#change(() => {
        host.model.setViewport(null, panel?.key);
        host.model.setYViewport({ y: null, yRight: null });
      }, true),
    );
  }

  /** One change of view, reported as caused by the input being handled. */
  #change(change: () => void, shareX: boolean): void {
    this.#host.changeView(change, shareX, this.#cause);
  }

  /** A panel's pixels as values of the view drawn in it. */
  #drawn(panel: DrawnPanel): Shown {
    return {
      panel,
      x: inverter(panel.x, null),
      y: inverter(panel.y, null),
      yRight: panel.yRight && inverter(panel.yRight, null),
    };
  }

  /**
   * A panel's pixels as values of the view asked for since its frame, which
   * input between frames acts on. A view reset since then shows what fitting
   * the data gives, and other changes may change the scales, which only
   * drawing finds: those draw first.
   */
  #shown(drawn: DrawnPanel): Shown {
    const host = this.#host;
    host.settle();
    const [x, { y, yRight }] = this.#view(drawn);
    const [wasX, was] = this.#framed.get(drawn.key) ?? [x, { y, yRight }];
    // Options, data, or a size changed since may give the panel other scales.
    if (host.stale() || (!x && wasX) || (!y && was.y) || (!yRight && was.yRight)) {
      host.current();
      return this.#drawn(this.#find(drawn) ?? drawn);
    }
    const panel = drawn;
    return {
      panel,
      x: inverter(panel.x, x),
      y: inverter(panel.y, y),
      yRight: panel.yRight && inverter(panel.yRight, yRight),
    };
  }

  /** Which of `panel`'s axes an action along `axes` (x by default) moves: not category axes. */
  #axes(axes: ZoomSpec | undefined, panel: DrawnPanel): { x: boolean; y: boolean } {
    const along = axes ?? "x";
    return {
      x: along.includes("x") && panel.x.type !== "band",
      y: along.includes("y") && panel.y.type !== "band",
    };
  }

  /**
   * `panel` as it is drawn now, with what is pending (a wheel step, a key)
   * drawn first, so that steps faster than frames add up; undefined if it
   * went, or shares its scales otherwise now.
   */
  /** `panel` in the scene drawn last, if it is still there with its scales. */
  #find(panel: DrawnPanel): DrawnPanel | undefined {
    return this.#host.model
      .panels()
      .find(({ key, xGroup }) => key === panel.key && xGroup === panel.xGroup);
  }

  /** What `panel` shows: its x scale's view and the y axes'. */
  #view(panel: DrawnPanel): View {
    const { model } = this.#host;
    return [model.viewportOf(panel.key), model.yViewport];
  }

  /**
   * Whether a selection can be zoomed to: ranges (a lasso cannot), on
   * axes that zoom, in a chart whose brushes do not select rows.
   */
  #zoomable(selection: Selection, panel: DrawnPanel): boolean {
    if (selection.lasso || !(selection.x || selection.y) || this.#host.rows()?.brushes)
      return false;
    return (!selection.x || panel.x.type !== "band") && (!selection.y || panel.y.type !== "band");
  }

  /**
   * Whether Enter zooms to a selection (made with the keyboard or received
   * from a synced chart): when the chart zooms along every axis it has a
   * range on, and it can be zoomed to.
   */
  #zooms(selection: Selection, panel: DrawnPanel): boolean {
    const axes = this.#bindings.list
      .map(({ action }) => (action.type === "zoom" ? (action.axes ?? "x") : ""))
      .join("");
    return (
      (!selection.x || axes.includes("x")) &&
      (!selection.y || axes.includes("y")) &&
      this.#zoomable(selection, panel)
    );
  }

  /** Starts a pinch with a second touch, if a binding zooms with pinches. */
  #startPinch(event: PointerEvent): boolean {
    const action = this.#bindings.match("pinch", event, OWN)?.action;
    const [a, b] = [...this.#touches.values()];
    const panel = this.#panelAt((a!.x + b!.x) / 2, (a!.y + b!.y) / 2);
    if (action?.type !== "zoom" || !panel) return false;
    this.#cancelPress();
    this.#pinch = {
      distance: Math.hypot(a!.x - b!.x, a!.y - b!.y),
      middle: { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 },
      panel,
      axes: action.axes,
    };
    return true;
  }

  /**
   * Zooms by how much a pinch's fingers moved apart or together, and moves
   * what was between them to where they are now.
   */
  #pinched() {
    const pinch = this.#pinch!;
    const [a, b] = [...this.#touches.values()];
    const distance = Math.hypot(a!.x - b!.x, a!.y - b!.y);
    const middle = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
    if (!(distance > 0 && pinch.distance > 0)) return;
    const panel = this.#find(pinch.panel);
    if (!panel) return;
    this.#zoomAt(this.#shown(panel), pinch.middle, pinch.distance / distance, pinch.axes, middle);
    pinch.distance = distance;
    pinch.middle = middle;
  }

  /**
   * A press ends without doing more: the browser took the pointer, or its
   * panel went. With `back` (Escape), a pan goes back to where it started,
   * unless the view changed since in another way (`setViewport`, a synced chart).
   */
  #cancelPress(back = false) {
    const press = this.#press;
    this.#press = null;
    this.#host.brush()?.cancel();
    this.#host.schedule();
    if (!back || !press?.last || !this.#still(press.panel)) return;
    const [x, y] = this.#view(press.panel);
    const [lastX, lastY] = press.last;
    if (x !== lastX || y !== lastY) return;
    const [fromX, fromY] = press.from;
    this.#change(() => {
      this.#host.model.setViewport(fromX, press.panel.key);
      this.#host.model.setYViewport(fromY);
    }, true);
  }

  /**
   * Whether a panel of an earlier scene is still drawn, with the same
   * scales to share: what a drag that started in it may go on acting on.
   */
  #still(panel: DrawnPanel): boolean {
    return this.#host.model
      .panels()
      .some(({ key, xGroup }) => key === panel.key && xGroup === panel.xGroup);
  }

  /** Zooms to a brushed selection. */
  #zoomTo(selection: Selection, panel: DrawnPanel) {
    const host = this.#host;
    const { x, y } = selection;
    host.animated(() =>
      this.#change(() => {
        if (y) this.#zoomY(this.#drawn(panel), panel.y.map(y[0]), panel.y.map(y[1]));
        if (x) host.model.setViewport(x, panel.key);
      }, x !== null),
    );
  }

  /**
   * Shows the y values between two pixels of a panel: on the left axis, and
   * on the right axis what the same pixels show there.
   */
  #zoomY(shown: Shown, bottom: number, top: number) {
    const { yRight } = shown;
    this.#host.model.setYViewport({
      y: [shown.y(bottom), shown.y(top)],
      yRight: yRight ? [yRight(bottom), yRight(top)] : null,
    });
  }

  /** The panel whose plot holds a point of the chart. */
  #panelAt(x: number, y: number): DrawnPanel | undefined {
    return this.#host.model.panels().find(({ plot }) => holds(plot, x, y));
  }

  /** Whether a point of the chart is in a panel a layout mark drew in. */
  #onItems(x: number, y: number): boolean {
    return this.#host.model.allPanels().some(({ items, plot }) => items && holds(plot, x, y));
  }

  /**
   * A press released without dragging: selects the rows there (with
   * `rowSelection`), clears the brushed selection, and reports the data there.
   */
  #click(point: { x: number; y: number }, event: MouseEvent) {
    const host = this.#host;
    const written = host.rows()?.clicked(point.x, point.y, event);
    // A click on an item standing for none of the bound rows keeps the brush too.
    if (host.options().interaction?.brush && written !== null) host.select(null);
    if (host.events.has("click"))
      host.events.emit("click", { inspection: host.model.inspect(point.x, point.y), ...written });
  }

  /**
   * Arrow keys step through the points of the first visible series. The
   * cursor keeps its position in the series, so repeated x values are each
   * reachable. In charts with facets, the cursor is in one panel; the Up and
   * Down arrows move it to the previous or next panel, near the same x. With
   * brushing on, Shift extends a selection from where the cursor started,
   * Enter zooms to it when zoom is on, and Escape clears it.
   */
  #key(event: KeyboardEvent) {
    const host = this.#host;
    const { model, live } = host;
    // Controls inside the chart (legend buttons) keep their own keys.
    if (event.target !== host.root || this.#boundKey(event) || !this.#kit.keys.includes(event.key))
      return;
    // Escape ends a drag, a pan going back to where it started.
    if (event.key === "Escape" && this.#press) {
      event.preventDefault();
      this.#cancelPress(true);
      return;
    }
    // A selection cleared since (by a click, a synced chart, `select`) starts afresh.
    if (!host.selection()) this.#brushAnchor = null;
    // Keys move through what the chart shows once pending changes (a series
    // hidden, new options, values on their way) are drawn, and values that
    // render listeners changed meanwhile do not move.
    host.current();
    const panels = model.panels();
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const brush = host.options().interaction?.brush;
    // Enter and Escape act on the selection, whichever panel the cursor is in.
    if (event.key === "Enter") {
      const selection = host.selection();
      const at = panels.find(({ xGroup }) => xGroup === host.owner()?.x);
      if (!selection || !at || !this.#zooms(selection, at)) return;
      event.preventDefault();
      this.#brushAnchor = null;
      host.select(null);
      // A select listener may have taken the panel away, or given it another
      // scale: zoom only where the selection still is.
      host.current();
      const still = model
        .panels()
        .find(({ key, xGroup }) => key === at.key && xGroup === at.xGroup);
      if (still) this.#zoomTo(selection, still);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.#keyboard = null;
      this.#brushAnchor = null;
      live.textContent = "";
      if (host.selection()) host.select(null);
      host.schedule();
      return;
    }
    // Where the cursor stops, panel by panel: Left and Right move through a
    // stop's points, or a layout mark's items (a stop of their own), Up and
    // Down to the stop before or after.
    const stops = model
      .allPanels()
      .flatMap(({ key, items }): { panel: string; series?: Series }[] =>
        items ? [{ panel: key }] : this.#stops(key).map((series) => ({ panel: key, series })),
      );
    const keyboard = this.#keyboard;
    let at = stops.findIndex(
      ({ panel, series }) => panel === keyboard?.panel && (!series || series.key === keyboard.key),
    );
    // The cursor's stop may be gone (its series hidden): then it starts afresh in its panel.
    const found = at >= 0;
    const current = found ? keyboard!.position : -1;
    if (!found)
      at = Math.max(
        0,
        stops.findIndex(({ panel }) => panel === keyboard?.panel),
      );
    const start = stops[at];
    if (!start) return;
    // A layout mark's items: every arrow key reads them in a chart of one.
    if (!start.series && (!vertical || stops.length < 2)) {
      this.#itemKey(event, start.panel);
      return;
    }
    // Heatmaps step cell by cell, in rows and columns as drawn; Up and Down
    // leave the grid at its edges. Contours' regions and lines are read as points are.
    const cells = ({ series }: { series?: Series }) =>
      series !== undefined && model.markOf(series)?.stepCell !== undefined;
    let cell: number | undefined;
    if (cells(start) && current >= 0) {
      const [columns, rows] = CELL_STEPS[event.key] ?? [0, 0];
      cell =
        this.#stepCell(start.panel, start.series!.key, current, columns, rows) ??
        (vertical ? undefined : current);
    }
    let across = keyboard !== null && !found;
    if (vertical && cell === undefined) {
      const next = keyboard && found ? at + (event.key === "ArrowUp" ? -1 : 1) : at;
      if (next < 0 || next >= stops.length) return;
      across ||= next !== at;
      at = next;
    }
    const { panel, series } = stops[at]!;
    if (!series) {
      this.#itemKey(event, panel, true);
      return;
    }
    // Entering a grid, the cursor starts at its top left cell.
    if (cell === undefined && cells(stops[at]!) && (across || current < 0))
      cell = this.#stepCell(panel, series.key, -1, 0, 0);
    const from = panels.find(({ key }) => key === start.panel);
    const to = panels.find(({ key }) => key === panel);
    event.preventDefault();
    const before = keyboard ? (this.#inspection() ?? keyboard.last) : undefined;
    const page = Math.max(1, Math.round(series.length / 10));
    // Up and Down carry the cursor's place along the axis it follows (x, or
    // y for marks along y) to the next stop: its value on a shared scale,
    // else its place across the plot.
    const along = before?.axis === "y" ? "y" : "x";
    let position = Math.max(0, current);
    if (cell !== undefined) position = cell;
    else if (across)
      position = nearestTo(
        this.#kit,
        series,
        before?.axis !== along
          ? undefined
          : !from || !to || from[`${along}Group`] === to[`${along}Group`]
            ? before.value
            : to[along].invert(to.plot[along] + before.position - from.plot[along]),
        to![along],
        along,
      );
    else if (event.key === "ArrowLeft") position -= 1;
    else if (event.key === "ArrowRight") position = current < 0 ? 0 : current + 1;
    else if (event.key === "PageUp") position -= page;
    else if (event.key === "PageDown") position += page;
    else if (event.key === "Home") position = 0;
    else if (event.key === "End") position = series.length - 1;
    position = Math.min(series.length - 1, Math.max(0, position));
    // Reading series already exclude hidden points; other series step over
    // axis breaks in the direction of travel.
    const breaks = model.markOf(series)?.readSeries ? undefined : to?.x.breaks;
    if (breaks && !across) {
      const back = event.key === "ArrowLeft" || event.key === "PageUp" || event.key === "End";
      const { x, rows, length, sorted } = series;
      const shown = breaks.nearestShown(x, position, length, back, sorted, rows);
      if (shown >= 0) position = shown;
    }
    this.#keyboard = { panel, key: series.key, position };
    this.#pointer = null;
    // The cursor moves on the frame drawn: what listeners changed while it
    // drew waits for the next.
    host.finishFrame();
    const inspection = this.#inspection();
    if (!inspection) return;
    this.#keyboard.last = inspection;
    let text = describeInspection(inspection);
    // Arriving in a panel, the cursor names it and the annotations it alone draws.
    if (
      inspection.panel !== undefined &&
      (before?.panel !== inspection.panel || panel !== start.panel)
    )
      text = [
        `${panels.find(({ key }) => key === inspection.panel)?.label ?? inspection.panel}:`,
        ...model.annotationSummaries(inspection.panel),
        text,
      ].join(" ");
    // Shift selects a range along the axis the cursor steps along: for
    // brushes along that axis, and for rectangles and lassos, which the
    // keyboard cannot draw. A range does not go on into a panel with
    // another scale along that axis.
    const axis = inspection.axis;
    // Nor does it go on along another axis.
    const crossed = from?.xGroup !== to?.xGroup;
    if (crossed || (this.#brushAnchor && this.#brushAnchor.axis !== axis)) this.#brushAnchor = null;
    if (
      event.shiftKey &&
      axis !== "item" &&
      (brush === axis || brush === "xy" || brush === "lasso")
    ) {
      const start = before?.axis === axis && !crossed ? before : inspection;
      this.#brushAnchor ??= { value: start.value, label: start.label, axis };
      const range = [this.#brushAnchor.value, inspection.value] as const;
      // In the panel as drawn: what listeners changed since waits for the next frame.
      host.select(
        { x: axis === "x" ? range : null, y: axis === "y" ? range : null, lasso: null },
        to,
      );
      const selection = host.selection();
      const zooms = selection && this.#zooms(selection, to!);
      const hint = zooms ? " Press Enter to zoom to it." : "";
      text = `Selected ${this.#brushAnchor.label} to ${inspection.label}.${hint} ${text}`;
    } else {
      this.#brushAnchor = null;
    }
    live.textContent = text;
  }

  /**
   * A key a binding takes: pans by its step, zooms about the plot's middle
   * by its factor, or resets, in the keyboard cursor's panel (the first by default).
   */
  #boundKey(event: KeyboardEvent): boolean {
    const host = this.#host;
    const action = this.#bindings.match("key", event, OWN)?.action;
    const panels = host.model.panels();
    const at = panels.find(({ key }) => key === this.#keyboard?.panel) ?? panels[0];
    if (!action || !at) return false;
    event.preventDefault();
    const shown = this.#shown(at);
    const { plot } = shown.panel;
    if (action.type === "pan") {
      const [across, up] = action.step ?? [0.1, 0];
      this.#move(shown, action.axes, across * plot.width, -up * plot.height);
    } else if (action.type === "zoom") {
      const middle = { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 };
      this.#zoomAt(shown, middle, 1 / (action.factor ?? 1.25), action.axes);
    } else if (action.type === "reset") this.#reset(host.model.sharesX ? undefined : shown.panel);
    return true;
  }

  /**
   * Arrow keys step through a layout mark's items in `panel`, in reading
   * order; Up and Down `enter` the panel at its first item. Arriving in a
   * facet panel or subplot, the cursor names it. Escape leaves a chart of
   * one layout mark's items.
   */
  #itemKey(event: KeyboardEvent, panel: string, enters = false) {
    const host = this.#host;
    const items = host.model.items!;
    const from = this.#keyboard;
    const to = items.step(event.key, from, panel, enters);
    if (to === undefined) return;
    event.preventDefault();
    this.#keyboard = to;
    this.#pointer = null;
    this.#brushAnchor = null;
    host.finishFrame();
    const inspection = this.#inspection();
    host.live.textContent = to
      ? items.said(inspection && describeInspection(inspection), panel, from?.panel !== panel)
      : "";
  }

  /** Loads the crosshair labels the first time a chart asks for `tooltip.axisLabels`. */
  #loadCrosshair(): void {
    if (this.#crosshair !== undefined || this.#crosshairLoading) return;
    this.#crosshairLoading = import("./axis-labels.ts")
      .then(({ CrosshairLabels }) => {
        const labels = new CrosshairLabels(this.#host.root.ownerDocument);
        this.#dots.before(labels.line);
        this.#host.root.append(labels.labels);
        return labels;
      })
      // Without it, the crosshair has no labels, until the options ask again.
      .catch((error: unknown) => {
        this.#host.report(error);
        return null;
      })
      .then((labels) => {
        this.#crosshair = labels;
        this.#crosshairLoading = undefined;
        if (!this.#disposed) this.#host.schedule();
      });
  }

  /**
   * Loads what reads the fields of rows marks' tooltips show, which
   * inspections then carry, and has the tooltip draw them and
   * `renderTooltip`'s content.
   */
  #loadContent(): void {
    const host = this.#host;
    if (this.#content || host.model.fields) return;
    this.#content = import("./tooltip-content.ts")
      .then(({ fieldReader, ownContent }) => {
        if (this.#disposed) return;
        host.model.fields = fieldReader;
        this.#cleanup.push(ownContent(this.#tooltip, () => host.options().renderTooltip));
      })
      // Without it, tooltips show the built-in content, and inspections no fields.
      .catch((error: unknown) => this.#host.report(error))
      .then(() => {
        this.#content = undefined;
        // Inspections read the fields from the next frame on.
        if (!this.#disposed) host.invalidate();
      });
  }
}

/** Columns right and rows up each key moves in a grid of cells. */
const CELL_STEPS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  Home: [Number.NEGATIVE_INFINITY, 0],
  End: [Number.POSITIVE_INFINITY, 0],
  PageUp: [0, Number.POSITIVE_INFINITY],
  PageDown: [0, Number.NEGATIVE_INFINITY],
};

/**
 * Position of the point of `series` placed nearest `value` along `axis` on
 * screen (on `scale`), never one an axis break hides; the first without a
 * `value`.
 */
function nearestTo(
  { placeAt, rowOf }: InteractionKit,
  series: Series,
  value: number | undefined,
  scale: PositionScale,
  axis: "x" | "y",
): number {
  if (value === undefined) return 0;
  let best = 0;
  let distance = Infinity;
  const at = scale.map(value);
  for (let k = 0; k < series.length; k++) {
    const place = placeAt(series, axis, rowOf(series, k));
    if (scale.breaks?.hides(place)) continue;
    const d = Math.abs(scale.map(place) - at);
    if (d < distance) {
      best = k;
      distance = d;
    }
  }
  return best;
}

/** A sentence announcing a selection, with values as the axes label them. */
function describeSelection(selection: Selection, format: AxisFormat): string {
  if (selection.lasso) return "Selected a freehand region.";
  const { x, y } = selection;
  const ranges: string[] = [];
  if (x) ranges.push(`x from ${format.x(x[0])} to ${format.x(x[1])}`);
  if (y) ranges.push(`y from ${format.y(y[0])} to ${format.y(y[1])}`);
  return `Selected ${ranges.join(" and ")}.`;
}

/** Whether a plot holds a point of the chart. */
function holds(plot: PlotRect, x: number, y: number): boolean {
  return x >= plot.x && x <= plot.x + plot.width && y >= plot.y && y <= plot.y + plot.height;
}

/** What a hover event reports, as a key that changes when any of it does. */
function inspectionKey(inspection: Inspection | undefined): string {
  return inspection ? JSON.stringify(inspection) : "";
}
