// How a grid looks: one stylesheet for its elements, which every grid
// carries in its own root (so grids inside shadow roots are styled too), and
// the theme as custom properties on that root.

import type { Theme } from "../theme.ts";

const G = ".herceg-grid";

export const GRID_CSS = `
${G}{position:relative;font-family:var(--hg-font);font-size:var(--hg-size);color:var(--hg-text);background:var(--hg-background)}
${G} .hg-scroller{position:absolute;inset:0;overflow:auto;overflow-anchor:none;scroll-behavior:auto;outline-offset:-2px}
${G} .hg-scroller:focus-visible{outline:2px solid var(--hg-accent)}
${G} .hg-header{position:sticky;top:0;z-index:1;width:max-content;min-width:100%;height:var(--hg-header-height);background:var(--hg-surface)}
${G} .hg-header [role=row]{position:relative;height:100%;box-sizing:border-box;border-bottom:1px solid var(--hg-rule)}
${G} .hg-body{position:relative;overflow:clip}
${G} .hg-body [role=row]{position:absolute;left:0;top:0;height:var(--hg-row-height);box-sizing:border-box;border-bottom:1px solid var(--hg-line)}
${G} [role=gridcell],${G} [role=columnheader]{position:absolute;top:0;height:100%;box-sizing:border-box;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${G} [role=gridcell]{line-height:calc(var(--hg-row-height) - 1px)}
${G} [role=columnheader]{line-height:calc(var(--hg-header-height) - 1px);color:var(--hg-muted);font-weight:600;user-select:none;cursor:default}
${G} [data-align=end]{text-align:end;font-variant-numeric:tabular-nums}
${G} [data-align=center]{text-align:center}
${G} .hg-sort{margin-inline-start:4px;font-size:0.85em}
${G} [aria-selected=true],${G} [aria-expanded][data-selection=all]{background:var(--hg-selected);box-shadow:inset 3px 0 var(--hg-accent)}
${G} [role=gridcell]:focus,${G} [role=columnheader]:focus{outline:2px solid var(--hg-accent);outline-offset:-2px}
${G} .hg-body [aria-expanded]{font-weight:600}
${G} .hg-body [aria-expanded]>[aria-colindex="1"]{text-align:start}
${G} .hg-body [aria-level="2"]>[aria-colindex="1"]{padding-inline-start:calc(34px + 1em)}
${G} .hg-controls{display:inline-flex;align-items:center;gap:6px;height:100%;margin-inline-end:6px;vertical-align:top}
${G} .hg-toggle{width:1em;text-align:center;cursor:pointer;color:var(--hg-muted)}
${G} .hg-toggle::before{content:"\\25B8"}
${G} [aria-expanded=true] .hg-toggle::before{content:"\\25BE"}
${G} .hg-check{width:12px;height:12px;box-sizing:border-box;border:1px solid var(--hg-muted);border-radius:2px;cursor:pointer}
${G} .hg-check[aria-checked=true]{background:var(--hg-accent);border-color:var(--hg-accent)}
${G} .hg-check[aria-checked=mixed]{background:linear-gradient(var(--hg-accent),var(--hg-accent)) center/6px 2px no-repeat}
@media (forced-colors:active){
${G} [aria-selected=true],${G} [aria-expanded][data-selection=all]{forced-color-adjust:none;background:Highlight;color:HighlightText;box-shadow:none}
${G} [role=gridcell]:focus,${G} [role=columnheader]:focus,${G} .hg-scroller:focus-visible{outline-color:CanvasText}
${G} .hg-check{forced-color-adjust:none;border-color:currentColor}
${G} .hg-check[aria-checked=true]{background:currentColor}
${G} .hg-check[aria-checked=mixed]{background:linear-gradient(currentColor,currentColor) center/6px 2px no-repeat}
}`;

/** The theme as the custom properties the stylesheet reads. */
export function themeProperties(
  theme: Theme,
  rowHeight: number,
  headerHeight: number,
): Record<string, string> {
  const accent = theme.palette[0]!;
  return {
    "--hg-font": theme.font,
    "--hg-size": `${theme.fontSize}px`,
    "--hg-text": theme.text,
    "--hg-muted": theme.muted,
    "--hg-line": theme.grid,
    "--hg-rule": theme.axis,
    "--hg-accent": accent,
    "--hg-selected": `color-mix(in srgb, ${accent} 16%, transparent)`,
    // The sticky header covers rows scrolling under it, so it needs a color of its own.
    "--hg-surface": theme.background === "transparent" ? theme.tooltipBackground : theme.background,
    "--hg-background": theme.background,
    "--hg-row-height": `${rowHeight}px`,
    "--hg-header-height": `${headerHeight}px`,
  };
}
