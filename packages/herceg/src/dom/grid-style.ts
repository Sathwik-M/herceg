// How a grid looks: one stylesheet for its elements, which every grid
// carries in its own root (so grids inside shadow roots are styled too), and
// the theme as custom properties on that root.

import type { Theme } from "../theme.ts";

const G = ".herceg-grid";

export const GRID_CSS = `
${G}{position:relative;font-family:var(--hg-font);font-size:var(--hg-size);color:var(--hg-text);background:var(--hg-background)}
${G} .hg-scroller{position:absolute;inset:0;overflow:auto;overflow-anchor:none;scroll-behavior:auto;outline-offset:-2px}
${G} .hg-scroller:focus-visible{outline:2px solid var(--hg-accent)}
${G} .hg-header{position:sticky;top:0;z-index:2;width:max-content;min-width:100%;height:var(--hg-header-height);background:var(--hg-surface)}
${G} .hg-header [role=row]{position:relative;display:flex;height:100%;box-sizing:border-box;border-bottom:1px solid var(--hg-rule)}
${G} .hg-body{position:relative;overflow:clip}
${G} .hg-body [role=row]{position:absolute;display:flex;left:0;top:0;height:var(--hg-row-height);box-sizing:border-box;border-bottom:1px solid var(--hg-line)}
${G} [role=gridcell],${G} [role=columnheader]{position:absolute;top:0;height:100%;box-sizing:border-box;padding:0 8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
${G} [role=gridcell]{line-height:calc(var(--hg-row-height) - 1px)}
${G} [role=columnheader]{line-height:calc(var(--hg-header-height) - 1px);color:var(--hg-muted);font-weight:600;user-select:none;cursor:default}
${G} [data-align=end]{text-align:end;font-variant-numeric:tabular-nums}
${G} [data-align=center]{text-align:center}
${G} .hg-sort{margin-inline-start:4px;font-size:0.85em}
${G} [aria-selected=true],${G} [aria-expanded][data-selection=all]{background:var(--hg-selected);box-shadow:inset 3px 0 var(--hg-accent)}
${G} [role=gridcell]:focus,${G} [role=columnheader]:focus{outline:2px solid var(--hg-accent);outline-offset:-2px}
${G} [data-pin]{position:sticky;top:auto;flex:none;z-index:1;background:var(--hg-surface)}
${G} [data-edge=left]{border-right:1px solid var(--hg-rule)}
${G} [data-edge=right]{border-left:1px solid var(--hg-rule)}
${G} .hg-body [aria-selected=true]>[data-pin],${G} .hg-body [aria-expanded][data-selection=all]>[data-pin]{background:linear-gradient(var(--hg-selected),var(--hg-selected)) var(--hg-surface)}
${G} .hg-body [aria-selected=true]>[data-pin][aria-colindex="1"],${G} .hg-body [aria-expanded][data-selection=all]>[data-pin][aria-colindex="1"]{box-shadow:inset 3px 0 var(--hg-accent)}
${G} .hg-menu-button{position:absolute;top:0;right:6px;display:none;width:18px;height:100%;text-align:center;cursor:pointer;color:var(--hg-muted);background:var(--hg-surface)}
${G} .hg-menu-button::before{content:"\\22EE"}
${G} [role=columnheader]:hover>.hg-menu-button,${G} [role=columnheader]:focus>.hg-menu-button{display:block}
${G} .hg-resize{position:absolute;top:0;right:0;width:6px;height:100%;cursor:col-resize;touch-action:none}
${G} [role=columnheader]:hover>.hg-resize{background:linear-gradient(var(--hg-rule),var(--hg-rule)) right/2px 50% no-repeat}
${G} [data-pin=right]>.hg-resize{right:auto;left:0}
${G} [role=columnheader][data-pin=right]:hover>.hg-resize{background-position:left}
${G} [data-pin=right]>.hg-menu-button{right:2px}
${G}[data-dragging=resize] .hg-scroller{cursor:col-resize}
${G}[data-dragging=move] .hg-scroller{cursor:grabbing}
${G} [data-moving]{opacity:0.5}
${G} .hg-drop{position:absolute;top:0;z-index:3;width:2px;height:var(--hg-header-height);background:var(--hg-accent);pointer-events:none}
${G} .hg-menu{position:absolute;z-index:3;box-sizing:border-box;min-width:200px;overflow:auto;padding:4px 0;font-weight:400;color:var(--hg-text);background:var(--hg-surface);border:1px solid var(--hg-rule);border-radius:4px;box-shadow:0 4px 16px rgb(0 0 0 / 0.2)}
${G} .hg-menu [role^=menuitem]{position:relative;display:flex;gap:24px;padding:4px 12px 4px 28px;line-height:20px;white-space:nowrap;cursor:pointer}
${G} .hg-menu [role^=menuitem]:focus{outline:2px solid var(--hg-accent);outline-offset:-2px;background:var(--hg-selected)}
${G} .hg-menu [aria-checked=true]::before{content:"\\2713" / "";position:absolute;left:10px}
${G} .hg-menu [aria-disabled=true]{color:var(--hg-muted);cursor:default}
${G} .hg-keys{margin-left:auto;color:var(--hg-muted)}
${G} .hg-menu [role=separator]{height:1px;margin:4px 0;background:var(--hg-rule)}
${G} .hg-menu-title{padding:4px 12px;color:var(--hg-muted);font-size:0.85em}
${G} .hg-body [aria-expanded]{font-weight:600}
${G} .hg-body [aria-expanded]>[aria-colindex="1"]{text-align:start;padding-inline-start:calc(8px + var(--hg-indent) * (1em + 6px))}
${G} .hg-body [aria-level]:not([aria-expanded])>[aria-colindex="1"]{padding-inline-start:calc(34px + 1em + var(--hg-indent) * (1em + 6px))}
${G} .hg-controls{display:inline-flex;align-items:center;gap:6px;height:100%;margin-inline-end:6px;vertical-align:top}
${G} .hg-toggle{width:1em;text-align:center;cursor:pointer;color:var(--hg-muted)}
${G} .hg-toggle::before{content:"\\25B8"}
${G} [aria-expanded=true] .hg-toggle::before{content:"\\25BE"}
${G} .hg-check{width:12px;height:12px;box-sizing:border-box;border:1px solid var(--hg-muted);border-radius:2px;cursor:pointer}
${G} .hg-check[aria-checked=true]{background:var(--hg-accent);border-color:var(--hg-accent)}
${G} .hg-check[aria-checked=mixed]{background:linear-gradient(var(--hg-accent),var(--hg-accent)) center/6px 2px no-repeat}
@media (forced-colors:active){
${G} [aria-selected=true],${G} [aria-expanded][data-selection=all]{forced-color-adjust:none;background:Highlight;color:HighlightText;box-shadow:none}
${G} [role=gridcell]:focus,${G} [role=columnheader]:focus,${G} .hg-scroller:focus-visible,${G} .hg-menu [role^=menuitem]:focus{outline-color:CanvasText}
${G} [aria-selected=true]>[data-pin],${G} [aria-expanded][data-selection=all]>[data-pin]{background:Highlight}
${G} .hg-drop{forced-color-adjust:none;background:Highlight}
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
