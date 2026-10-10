// What charts load for tooltips that show more than their marks' values:
// the fields of rows marks' tooltips show (`tooltip.fields`), read and
// written for inspections, and content of the application's own
// (`renderTooltip`) in the tooltip's box. It imports only types, so that
// loading it later shares no code with the chart's own.

import type { Formatter } from "../format/format.ts";
import type { FieldReaders, InspectedField } from "../marks/tooltip-fields.ts";
import type { Inspection } from "../model/model.ts";
import type { Theme } from "../theme.ts";
import type { RenderTooltip, Tooltip } from "./tooltip.ts";

/**
 * Reads tooltip fields in a chart's locale and zone, written with their
 * formats, else numbers as `numbers` writes them, and times as `times`
 * does (the x axis' formatter, on time axes) or as dates and times.
 */
export const fieldReader: FieldReaders = (locale, zone, numbers, times) => {
  const timeZone = zone === "local" ? undefined : zone;
  const formats = new Map<string, Formatter>();
  const write = (kind: string, format: object | undefined): Formatter => {
    if (!format && kind === "number") return numbers;
    if (!format && times) return times;
    const key = `${kind} ${JSON.stringify(format)}`;
    let formatter = formats.get(key);
    if (!formatter) {
      const intl =
        kind === "time"
          ? new Intl.DateTimeFormat(locale, {
              timeZone,
              ...(format ?? { dateStyle: "medium", timeStyle: "short" }),
            })
          : // As the chart writes numbers: values that round to zero without a minus sign.
            new Intl.NumberFormat(locale, { signDisplay: "negative", ...format });
      formatter = (value) => intl.format(value);
      formats.set(key, formatter);
    }
    return formatter;
  };
  return (table, tooltip, row) =>
    tooltip?.fields?.map((entry) => {
      const { field, label = field, format } = typeof entry === "string" ? { field: entry } : entry;
      const value = table!.value(field, row);
      const kind = table!.kind(field) as InspectedField["kind"];
      // Times beyond what dates hold (an infinity among them) have no date to write.
      const text =
        value === null || (kind === "time" && !(Math.abs(value as number) <= 8.64e15))
          ? "–"
          : typeof value === "string"
            ? value
            : write(kind, format)(value);
      return { field, label, kind, value, text };
    });
};

/**
 * Makes the chart's tooltip, `tooltip`, show the fields of the rows its
 * points are, and the content `render()` returns in its box (the built-in
 * content where it returns none). `render`'s content is asked for again
 * only when what the tooltip is at changes or the content left the box,
 * and the box is placed again as that content changes size, as frameworks
 * render it. Returns what stops watching its size.
 */
export function ownContent(tooltip: Tooltip, render: () => RenderTooltip | undefined): () => void {
  const { element } = tooltip;
  const document = element.ownerDocument;
  let shown: unknown[] = [];
  let at: [{ x: number; y: number }, { width: number; height: number }] | undefined;
  /** As the built-in tooltip is placed: right of the pointer, flipped when it would overflow the chart. */
  const place = () => {
    if (!at || element.style.display === "none") return;
    const [pointer, bounds] = at;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let x = pointer.x + 14;
    if (x + width > bounds.width) x = Math.max(0, pointer.x - 14 - width);
    const y = Math.min(Math.max(0, pointer.y - height / 2), Math.max(0, bounds.height - height));
    element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  const resized = new ResizeObserver(place);
  resized.observe(element);
  /** The built-in content, each point's row followed by its fields', which line up under its label. */
  const builtIn = (inspection: Inspection, theme: Theme) => {
    const header = document.createElement("div");
    header.textContent = inspection.label;
    header.style.cssText = `color:${theme.muted};margin-bottom:2px`;
    element.append(header);
    const row = (name: string, text: string, color?: string) => {
      const line = document.createElement("div");
      line.style.cssText = "display:flex;align-items:center;gap:6px";
      const swatch = document.createElement("span");
      swatch.style.cssText = `width:8px;height:8px;border-radius:2px;background:${color ?? "none"};flex:none`;
      const label = document.createElement("span");
      label.textContent = name;
      label.style.cssText = `flex:1;color:${color ? theme.text : theme.muted}`;
      const value = document.createElement("span");
      value.textContent = text;
      value.style.cssText = "font-weight:600;margin-left:12px";
      line.append(swatch, label, value);
      element.append(line);
    };
    for (const point of inspection.points) {
      row(point.label, point.text, point.color);
      for (const field of point.fields ?? []) row(field.label, field.text);
    }
  };
  tooltip.show = (inspection, theme, pointer, bounds) => {
    const own = render();
    const key = JSON.stringify(inspection);
    // A framework may have taken its content out of the box (a snippet removed and given again).
    const kept = !(shown[3] instanceof Node) || element.contains(shown[3]);
    if (own !== shown[0] || theme !== shown[1] || key !== shown[2] || !kept) {
      shown = [own, theme, key];
      element.style.background = theme.tooltipBackground;
      element.style.color = theme.text;
      element.style.border = `1px solid ${theme.tooltipBorder}`;
      element.style.boxShadow =
        "0 1px 2px rgba(16, 24, 40, 0.06), 0 6px 16px rgba(16, 24, 40, 0.12)";
      element.style.font = `${theme.fontSize}px ${theme.font}`;
      element.replaceChildren();
      const content = own?.(inspection);
      // Text is shown as text, never parsed as markup.
      if (content != null) element.append(content);
      else builtIn(inspection, theme);
      // A fragment leaves its children in the box, not itself.
      shown.push(content instanceof Node ? element.firstChild : undefined);
    }
    element.style.display = "block";
    at = [pointer, bounds];
    place();
  };
  return () => resized.disconnect();
}
