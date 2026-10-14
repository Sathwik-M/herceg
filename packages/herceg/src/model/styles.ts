// The styles of a chart's guides and panels: each role's paint from the
// cascade's levels the model owns (the theme, the chart's guide options,
// a subplot's style and its own axis settings), made once per
// configuration and theme. Levels merge before their colors and fonts are
// read, so only values that win are; levels that set nothing reuse the
// theme's paint.

import type { AxisStyles } from "../spec/style.ts";
import {
  cascade,
  type PlotPaint,
  plotPaint,
  type StrokePaint,
  strokePaint,
  type TextPaint,
  textPaint,
} from "../style/style.ts";
import { readStyle, type TextRole, type Theme, type ThemeEnvironment } from "../theme.ts";
import type { ChartConfig } from "./model.ts";
import type { ScaleName } from "./scales.ts";

/** A level of a role's style, and where it is set, for messages. */
type Level = readonly [style: object | undefined, path: string];

/** The styles of a chart's guides and panels, resolved once per configuration and theme. */
export type ChartStyles = ReturnType<typeof chartStyles>;

/** Where a chart's guides and panels set styles of their own, beyond the theme. */
export function styleSources(config: ChartConfig): unknown[] {
  return [
    config.x?.style,
    config.y?.style,
    config.yRight?.style,
    config.title,
    config.legend,
    config.panels?.list,
  ];
}

export function chartStyles(theme: Theme, config: ChartConfig, environment: ThemeEnvironment = {}) {
  const cache = new Map<string, unknown>();
  const { roles, style } = theme;
  const panels = config.panels?.list ?? [];
  const { title, legend } = config;
  // Most charts style no axis or panel: theirs take the theme's paints at
  // once, which the scene asks for panel by panel.
  const [x, y, yRight, ...rest] = styleSources(config);
  const styled = !!(x || y || yRight) || /"style"/.test(JSON.stringify(rest));
  /**
   * A paint by `make` from what `levels` set, cached as `key`; `theirs`, the
   * theme's own, when they set nothing.
   */
  const paint = <P>(key: string, theirs: P, levels: () => Level[], make: (own: object) => P): P => {
    if (!styled) return theirs;
    if (!cache.has(key)) {
      const set = levels().filter(([level]) => level);
      // Each property is named in messages by the level that set it.
      const from: Record<string, string> = {};
      for (const [level, path] of set)
        for (const [name, value] of Object.entries(level!))
          if (value !== undefined) from[name] = path;
      const own = cascade(set.map(([level]) => level!));
      cache.set(
        key,
        set.length ? make(readStyle(own, (name) => `${from[name]}.${name}`, environment)) : theirs,
      );
    }
    return cache.get(key) as P;
  };
  // The plot's paint as the theme sets it: undefined without a background or border.
  const plot = plotPaint([roles.plot]);
  const text = (role: TextRole, key: string, levels: () => Level[]): TextPaint =>
    paint(key, style[role], levels, (own) => textPaint([roles.text, roles[role], own]));
  /** An axis role's levels in panel `panel`: the chart's axis, the subplot, the subplot's own axis. */
  const axisLevels = (role: keyof AxisStyles, axis: ScaleName, panel: number) => (): Level[] => {
    const own = panels[panel];
    return [
      [config[axis]?.style?.[role], `${axis}.style.${role}`],
      [own?.style?.[role], `panels[${panel}].style.${role}`],
      [own?.[axis]?.style?.[role], `panels[${panel}].${axis}.style.${role}`],
    ];
  };
  return {
    /** How axis `axis` of panel `panel` writes its tick labels or title. */
    axisText: (role: "tickLabel" | "axisTitle", axis: ScaleName, panel: number): TextPaint =>
      text(role, `${role} ${axis} ${panel}`, axisLevels(role, axis, panel)),
    /** How axis `axis` of panel `panel` draws its line, ticks, or grid lines. */
    axisStroke: (role: "axisLine" | "tick" | "grid", axis: ScaleName, panel: number): StrokePaint =>
      paint(`${role} ${axis} ${panel}`, style[role], axisLevels(role, axis, panel), (own) =>
        strokePaint([roles[role], own]),
      ),
    /** Panel `panel`'s plot background and border; undefined when it has neither. */
    plot: (panel: number): PlotPaint | undefined =>
      paint(
        `plot ${panel}`,
        plot,
        () => [[panels[panel]?.style?.plot, `panels[${panel}].style.plot`]],
        (own) => plotPaint([roles.plot, own]),
      ),
    /** How panel `panel`'s title, or a facet panel's header, is written. */
    panelTitle: (panel: number): TextPaint =>
      text("panelTitle", `panelTitle ${panel}`, () => {
        const own = panels[panel];
        const heading = own?.title;
        return [
          [own?.style?.panelTitle, `panels[${panel}].style.panelTitle`],
          [typeof heading === "object" ? heading.style : undefined, `panels[${panel}].title.style`],
        ];
      }),
    /** How the chart's title is written. */
    title: (): TextPaint =>
      text("title", "title", () => [
        [typeof title === "object" ? title.style : undefined, "title.style"],
      ]),
    /** How the legend writes its labels, its parts' titles, and the values they write. */
    legend: (role: "legendLabel" | "legendTitle" | "tickLabel"): TextPaint =>
      text(role, `legend ${role}`, () => [
        [typeof legend === "object" ? legend.style?.[role] : undefined, `legend.style.${role}`],
      ]),
  };
}
