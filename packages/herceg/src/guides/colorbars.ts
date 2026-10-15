// Colorbars: a color scale's colors along its values, standing beside the
// plots (low values at the bottom) or lying above or below them (low at
// the left), with ticks as an axis plans them over the scale's domain and
// a title. A ramp is drawn as the scale colors values, its middle color at
// a diverging scale's midpoint; a contour's bands as boxes between their
// levels.

import type { AxisContext } from "../model/axis.ts";
import type { GuideKit } from "../model/guides.ts";
import type { ColorbarScale, LegendText, MeasuredLegend } from "../model/legend.ts";
import type { ColorbarGuide, GuideItem, RampItem } from "../scene/scene.ts";
import type { Place } from "../spec/place.ts";
import type { ScaleRef } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import {
  TICK as AXIS_TICK,
  drawn,
  extent,
  layered,
  outward,
  resolveLayers,
  rowDepths,
  widest,
} from "./axes.ts";
import type { ColorbarOptions } from "./options.ts";
import { restroke, restyle } from "./paints.ts";
import { countOf, tickPlanner } from "./ticks.ts";

/** Pixels across a colorbar, its ticks' length, from its ticks to its labels, between rows and its title and ramp. */
const THICKNESS = 12;
const TICK = 4;
const LABEL_GAP = 4;
const ROW_GAP = 2;
const TITLE_GAP = 6;

/** A colorbar the guides list. */
export interface ColorbarPlan {
  key: string;
  place: Place;
  options: ColorbarOptions;
  scale: ScaleRef | undefined;
  path: string;
}

/** The colorbars `guides` lists. */
export function plannedColorbars(guides: readonly { type: string }[] | undefined): ColorbarPlan[] {
  return (guides ?? []).flatMap((guide, i) => {
    if (guide.type !== "colorbar") return [];
    const options = guide as ColorbarOptions;
    if (options.show === false) return [];
    return [
      {
        key: options.id !== undefined ? `colorbar|id|${options.id}` : `colorbar|${i}`,
        place: options.place ?? { side: "right" },
        options,
        scale: options.scale,
        path: `chart guides[${i}]`,
      },
    ];
  });
}

/**
 * A colorbar of `scale` placed at `place`, measured: `length` pixels along
 * its values (by default most of the chart's height beside the plots, or a
 * share of its width above or below them). Its ticks are an axis' along
 * the bar, layers and all, labeled beside it standing and below it lying.
 */
export function measureColorbar(
  kit: GuideKit,
  plan: ColorbarPlan,
  scale: ColorbarScale,
  text: LegendText,
  theme: Theme,
  chart: { readonly width: number; readonly height: number },
): MeasuredLegend {
  const { options, place } = plan;
  const { measure } = text;
  const upright = !("side" in place) || place.side === "left" || place.side === "right";
  const style = options.style;
  const read = text.read ?? ((given) => given);
  const at = `${plan.path}.style`;
  const base = {
    label: restyle(kit, read, text.value, style?.tickLabel, `${at}.tickLabel`),
    tick: restroke(kit, read, theme.style.tick, style?.tick, `${at}.tick`),
  };
  const title = typeof options.title === "string" ? { text: options.title } : options.title;
  const heading =
    title &&
    restyle(
      kit,
      read,
      restyle(kit, read, text.title, style?.legendTitle, `${at}.legendTitle`),
      title.style,
      `${plan.path}.title.style`,
    );
  const thickness = options.thickness ?? THICKNESS;
  const length =
    options.length ??
    (upright
      ? Math.max(60, Math.min(240, (chart.height - 80) * 0.75))
      : Math.max(80, Math.min(240, chart.width * 0.4)));
  const domain: [number, number] =
    scale.kind === "ramp"
      ? [scale.ramp.domain[0], scale.ramp.domain[1]]
      : [scale.levels[0]!, scale.levels.at(-1)!];
  // Ticks as an axis along the bar plans them, inside the domain; a
  // contour's at its levels unless asked for others.
  const ticks = options.ticks ?? (scale.kind === "steps" ? { values: scale.levels } : undefined);
  const axis = {
    scale: "color",
    across: !upright,
    above: false,
    layers: resolveLayers(
      { ...options, ticks },
      {
        across: !upright,
        home: true,
        path: plan.path,
        name: "colorbar standing beside the plots",
        tick: 2,
        major: { direction: "out", length: TICK },
      },
    ),
  };
  const context: AxisContext = {
    type: "linear",
    spec: undefined,
    zone: "UTC",
    locale: text.locale,
  };
  const major = axis.layers[0]!;
  const planner = tickPlanner(
    kit,
    ticks,
    options.format,
    context,
    "color",
    { ticks: `${plan.path}.ticks`, format: `${plan.path}.format` },
    major.labels ? major.labels.duplicates : "hide",
  );
  const count = countOf(ticks) ?? Math.max(2, Math.round(length / 40));
  const along = (start: number) =>
    kit.planAxis(
      { ...context, plan: planner },
      domain,
      upright ? [start + length, start] : [start, start + length],
      count,
      domain,
    );
  // Measured where it starts at 0, its labels kept as wherever it is drawn:
  // a colorbar's own room keeps its labels inside the chart.
  const probe = layered(kit, axis, base, read, measure, along(0), undefined);
  const reach = outward(axis.layers);
  const titleHeight = heading ? kit.textHeight(heading) + TITLE_GAP : 0;
  const titleWidth = heading && title ? kit.textWidth(title.text, heading, measure) : 0;
  const labeled = probe.some(({ layer }) => layer.labels);
  const rows = rowDepths(kit, probe, measure);
  const depth = rows.reduce((sum, row) => sum + row + ROW_GAP, -ROW_GAP);
  // How far labels near the ends reach past the bar, every layer's in its
  // own paint and turn, as drawn: their boxes' extents along it.
  let overhang = 0;
  for (const { ticks: placed, label: paint, angle } of probe)
    for (const tick of placed) {
      if (!tick.label) continue;
      const [from, to] = extent(tick, paint, angle, upright ? "along" : "below", measure);
      overhang = Math.max(overhang, -from, to - length);
    }
  // As axes draw labels: beside the ticks standing, below the default tick length lying.
  const gap = 1 + (upright ? LABEL_GAP : LABEL_GAP + AXIS_TICK);
  const width = upright
    ? Math.max(
        thickness + reach + (labeled ? LABEL_GAP + widest(kit, probe, measure) : 0),
        titleWidth,
      )
    : Math.max(length + 2 * overhang, titleWidth);
  const height = upright
    ? titleHeight + overhang + length + overhang
    : titleHeight +
      thickness +
      Math.max(reach, labeled ? gap + Math.max(0, reach - AXIS_TICK) + depth : 0);
  return {
    width,
    height,
    place(x, y, surface) {
      const shown = surface ?? text.surface;
      const items: GuideItem[] = [];
      if (heading && title)
        items.push(
          kit.textItem(
            title.text,
            {
              x,
              y: y + kit.textHeight(heading) / 2,
              anchor: "start",
              baseline: "middle",
              angle: 0,
            },
            heading,
            shown,
            measure,
          ),
        );
      // The ramp's box: beside the plots it stands, below them it lies.
      const rx = upright ? x : x + overhang;
      const ry = upright ? y + titleHeight + overhang : y + titleHeight;
      const bar = {
        x: rx,
        y: ry,
        width: upright ? thickness : length,
        height: upright ? length : thickness,
      };
      const planned = along(upright ? ry : rx);
      const at = (value: number) => planned.scale.map(value);
      if (scale.kind === "ramp")
        items.push({
          type: "ramp",
          ...bar,
          ...(upright && { vertical: true }),
          radius: 2,
          stops: scale.ramp.stops,
          offsets: scale.offsets,
        } satisfies RampItem);
      else
        scale.colors.forEach((fill, k) => {
          const [a, b] = [at(scale.levels[k]!), at(scale.levels[k + 1]!)];
          items.push(
            upright
              ? {
                  type: "rect",
                  x: bar.x,
                  y: Math.min(a, b),
                  width: thickness,
                  height: Math.abs(b - a),
                  radius: 0,
                  fill,
                }
              : {
                  type: "rect",
                  x: Math.min(a, b),
                  y: bar.y,
                  width: Math.abs(b - a),
                  height: thickness,
                  radius: 0,
                  fill,
                },
          );
        });
      // Tick marks and labels as an axis along the bar's outer edge draws
      // them: its last row of pixels, where lines fall on pixel centers.
      const placement = {
        side: upright ? ("right" as const) : ("bottom" as const),
        edge: (upright ? bar.x : bar.y) + thickness - 1,
        start: upright ? bar.y + length : bar.x,
        end: upright ? bar.y : bar.x + length,
        gap,
        surface: shown,
      };
      items.push(
        ...drawn(
          kit,
          placement,
          layered(kit, axis, base, read, measure, planned, undefined),
          false,
          measure,
          chart,
        ),
      );
      const guide: ColorbarGuide = { kind: "colorbar", key: plan.key, items, rampMarkup };
      return [guide];
    },
  };
}

/** A ramp as SVG: a box filled with a gradient of its stops, left to right or bottom to top. */
function rampMarkup(item: RampItem, id: string): string {
  const round = (v: number) => Math.round(v * 100) / 100;
  const stops = item.stops
    .map((color, i) => `<stop offset="${round(item.offsets[i]! * 100)}%" stop-color="${color}"/>`)
    .join("");
  // Ramps are "#rrggbb" colors, checked as their scales are made.
  const along = item.vertical ? ' x1="0" y1="1" x2="0" y2="0"' : "";
  return `<defs><linearGradient id="${id}"${along}>${stops}</linearGradient></defs><rect x="${round(item.x)}" y="${round(item.y)}" width="${round(item.width)}" height="${round(item.height)}" rx="${item.radius}" fill="url(#${id})"/>`;
}
