import { describe, expect, it } from "vitest";
import { NO_PAGE } from "../src/render/fallbacks.ts";
import { isLightColor } from "../src/scale/color.ts";
import { resolveTheme, themeReadsPage } from "../src/theme.ts";

describe("resolveTheme", () => {
  it("gives named themes surfaces of their own and keeps auto transparent", () => {
    expect(resolveTheme(undefined).background).toBe("#ffffff");
    expect(resolveTheme("light").background).toBe("#ffffff");
    expect(resolveTheme("dark").background).toBe("#12151c");
    expect(resolveTheme("high-contrast").background).toBe("#ffffff");
    expect(resolveTheme("high-contrast-dark").background).toBe("#000000");
    expect(resolveTheme({ tokens: { palette: ["#000000"] } }).background).toBe("#ffffff");
    // Without a page, auto is light, on the page's background.
    expect(resolveTheme("auto")).toEqual({ ...resolveTheme("light"), background: "transparent" });
    expect(resolveTheme("auto", { dark: true })).toEqual({
      ...resolveTheme("dark"),
      background: "transparent",
    });
    expect(resolveTheme({ extends: "auto" }).background).toBe("transparent");
    // Any theme can show the page instead.
    expect(
      resolveTheme({ extends: "dark", tokens: { background: "transparent" } }).background,
    ).toBe("transparent");
  });

  it("names the themes there are when given another", () => {
    const names = '"light", "dark", "high-contrast", "high-contrast-dark", "auto"';
    expect(() => resolveTheme("drak" as never)).toThrow(`theme: no theme "drak"; use ${names}`);
    expect(() => resolveTheme({ extends: "toString" as never })).toThrow(
      `theme.extends: no theme "toString"; use ${names}`,
    );
  });

  it("replaces CSS variables by their fallbacks without a page, wherever they appear", () => {
    const theme = resolveTheme(
      {
        tokens: {
          text: "var(--ink, #223344)",
          palette: ["var(--one, #ff8800)", "rgb(0 0 0 / var(--alpha, 0.5))"],
        },
        style: { text: { font: "var(--font, var(--system, system-ui)), sans-serif" } },
      },
      NO_PAGE,
    );
    expect(theme.font).toBe("system-ui, sans-serif");
    expect(theme.text).toBe("#223344");
    expect(theme.palette).toEqual(["#ff8800", "rgb(0 0 0 / 0.5)"]);
    expect(() => resolveTheme({ tokens: { text: "var(--ink)" } }, NO_PAGE)).toThrow(
      /theme.tokens.text .*var\(--ink\).*fallback/,
    );
    // Without an environment, values are used as given.
    expect(resolveTheme({ tokens: { text: "var(--ink)" } }).text).toBe("var(--ink)");
  });

  it("leaves quoted text alone when replacing variables", () => {
    const font = (value: string) =>
      resolveTheme({ style: { text: { font: value } } }, NO_PAGE).font;
    expect(font('var(--font, "Font)Name"), sans-serif')).toBe('"Font)Name", sans-serif');
    expect(font('"var(--font)", serif')).toBe('"var(--font)", serif');
  });

  it("reads colors in other syntaxes through the page, when there is one", () => {
    const read: string[] = [];
    const theme = resolveTheme(
      {
        tokens: {
          text: "oklch(0.3 0 0)",
          background: "transparent",
          palette: ["#3266d6", "rebeccapurple"],
        },
      },
      {
        color(value) {
          read.push(value);
          return "#123456";
        },
      },
    );
    expect([theme.text, theme.background, theme.palette]).toEqual([
      "#123456",
      "transparent",
      ["#3266d6", "#123456"],
    ]);
    // Hex colors and "transparent" are read as they are.
    expect(read).toEqual(["oklch(0.3 0 0)", "rebeccapurple"]);
  });

  it("gives light text a dark tooltip, unless the theme chooses one", () => {
    const dark = resolveTheme("dark");
    const own = resolveTheme({ tokens: { background: "#000000", text: "#ffffff" } });
    expect(own.style.tooltip).toEqual(dark.style.tooltip);
    expect(
      resolveTheme({ tokens: { text: "#ffffff" }, style: { tooltip: { fill: "#333333" } } }).style
        .tooltip.fill,
    ).toBe("#333333");
    const light = resolveTheme({ extends: "dark", tokens: { text: "#111111" } });
    expect(light.style.tooltip.fill).toBe(resolveTheme("light").style.tooltip.fill);
  });

  it("keeps text readable on each built-in theme's tooltip", () => {
    for (const name of ["light", "dark", "high-contrast", "high-contrast-dark"] as const) {
      const theme = resolveTheme(name);
      expect(isLightColor(theme.text)).not.toBe(isLightColor(theme.style.tooltip.fill));
    }
  });

  it("knows which themes read the page", () => {
    expect(themeReadsPage("auto")).toBe(true);
    expect(themeReadsPage("dark")).toBe(false);
    expect(themeReadsPage({ tokens: { text: "#000000", palette: ["red"] } })).toBe(false);
    expect(themeReadsPage({ tokens: { text: "currentColor" } })).toBe(true);
    expect(themeReadsPage({ tokens: { background: "Canvas" } })).toBe(true);
    expect(themeReadsPage({ tokens: { palette: ["light-dark(#000, #fff)"] } })).toBe(true);
    expect(themeReadsPage({ style: { text: { font: "var(--font, serif)" } } })).toBe(true);
    expect(themeReadsPage({ style: { tickLabel: { color: "var(--muted, #555)" } } })).toBe(true);
    expect(themeReadsPage({ style: { title: { background: { fill: "Canvas" } } } })).toBe(true);
  });
});

describe("role styles", () => {
  it("make every role from the tokens, so changing a token changes the roles using it", () => {
    const theme = resolveTheme({ tokens: { muted: "#555555", axis: "#000000", grid: "#eeeeee" } });
    expect(theme.style.tickLabel.color).toBe("#555555");
    expect(theme.style.axisLine.stroke).toBe("#000000");
    expect(theme.style.tick.stroke).toBe("#000000");
    expect(theme.style.grid).toEqual({ stroke: "#eeeeee", strokeWidth: 1, dash: [], opacity: 1 });
    // Titles and labels are the text color.
    expect(theme.style.title.color).toBe(theme.text);
    expect(theme.style.legendLabel.color).toBe(theme.text);
  });

  it("give custom marks the plot's style as an object, whatever the theme sets", () => {
    // Drawings read `theme.style.plot.fill ?? theme.background`.
    expect(resolveTheme("light").style.plot).toEqual({});
    expect(resolveTheme({ style: { plot: { fill: "#fafafa" } } }).style.plot).toEqual({
      fill: "#fafafa",
    });
  });

  it("give the built-in themes' sizes, weights, widths, and radii", () => {
    const light = resolveTheme("light");
    expect([light.style.title.size, light.style.title.weight]).toEqual([15, 600]);
    expect([light.fontSize, light.style.tickLabel.size]).toEqual([12, 12]);
    expect(light.style.panelTitle.weight).toBe(600);
    expect(light.style.line.strokeWidth).toBe(2);
    expect(light.style.bar.radius).toBe(4);
    expect(light.style.text.lineHeight).toBe(15);
    const contrast = resolveTheme("high-contrast");
    expect([contrast.fontSize, contrast.style.title.size]).toEqual([13, 16]);
    expect(contrast.style.line.strokeWidth).toBe(2.5);
    expect(contrast.style.tooltip.stroke).toBe("#000000");
  });

  it("start text roles from the base text, role by role, property by property", () => {
    const theme = resolveTheme({
      style: {
        text: { font: "Inter", fontSize: 14, color: "#ff0000" },
        title: { fontSize: 20, align: "center" },
        tickLabel: { fontWeight: 700 },
      },
    });
    // The base text's font and size reach every role that does not set its own.
    expect(theme.font).toBe("Inter");
    expect([theme.style.tickLabel.font, theme.style.tickLabel.size]).toEqual(["Inter", 14]);
    expect(theme.style.tickLabel.css).toBe("700 14px Inter");
    // A role's own defaults (the title's size and weight, tick labels' muted
    // color) come after the base text, so they hold unless set themselves.
    expect(theme.style.title.size).toBe(20);
    expect(theme.style.title.weight).toBe(600);
    expect(theme.style.title.align).toBe("center");
    expect(theme.style.tickLabel.color).toBe(theme.muted);
    // Roles without a color of their own take the base text's.
    expect(theme.style.axisTitle.color).toBe("#ff0000");
    expect(theme.style.title.color).toBe("#ff0000");
    expect(theme.style.legendLabel.align).toBeUndefined();
  });

  it("resolve dash styles, line widths, and box colors", () => {
    const theme = resolveTheme(
      {
        style: {
          grid: { dash: "--", strokeWidth: 2, stroke: "var(--grid, #dddddd)" },
          line: { strokeWidth: 3 },
          bar: { radius: 0 },
          title: { background: { fill: "var(--paper, #fafafa)" }, padding: { left: 4 } },
        },
      },
      NO_PAGE,
    );
    expect(theme.style.grid.dash).toEqual([7.4, 3.2]);
    expect(theme.style.grid.stroke).toBe("#dddddd");
    expect(theme.style.line.strokeWidth).toBe(3);
    expect(theme.style.bar.radius).toBe(0);
    expect(theme.style.title.background).toEqual({ fill: "#fafafa" });
    expect(theme.style.title.padding).toEqual([0, 0, 0, 4]);
  });
});
