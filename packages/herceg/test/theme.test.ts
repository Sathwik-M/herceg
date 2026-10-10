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
    expect(resolveTheme({ palette: ["#000000"] }).background).toBe("#ffffff");
    // Without a page, auto is light, on the page's background.
    expect(resolveTheme("auto")).toEqual({ ...resolveTheme("light"), background: "transparent" });
    expect(resolveTheme("auto", { dark: true })).toEqual({
      ...resolveTheme("dark"),
      background: "transparent",
    });
    expect(resolveTheme({ extends: "auto" }).background).toBe("transparent");
    // Any theme can show the page instead.
    expect(resolveTheme({ extends: "dark", background: "transparent" }).background).toBe(
      "transparent",
    );
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
        font: "var(--font, var(--system, system-ui)), sans-serif",
        text: "var(--ink, #223344)",
        palette: ["var(--one, #ff8800)", "rgb(0 0 0 / var(--alpha, 0.5))"],
      },
      NO_PAGE,
    );
    expect(theme.font).toBe("system-ui, sans-serif");
    expect(theme.text).toBe("#223344");
    expect(theme.palette).toEqual(["#ff8800", "rgb(0 0 0 / 0.5)"]);
    expect(() => resolveTheme({ text: "var(--ink)" }, NO_PAGE)).toThrow(
      /theme.text .*var\(--ink\).*fallback/,
    );
    // Without an environment, values are used as given.
    expect(resolveTheme({ text: "var(--ink)" }).text).toBe("var(--ink)");
  });

  it("leaves quoted text alone when replacing variables", () => {
    const font = (value: string) => resolveTheme({ font: value }, NO_PAGE).font;
    expect(font('var(--font, "Font)Name"), sans-serif')).toBe('"Font)Name", sans-serif');
    expect(font('"var(--font)", serif')).toBe('"var(--font)", serif');
  });

  it("reads colors in other syntaxes through the page, when there is one", () => {
    const read: string[] = [];
    const theme = resolveTheme(
      { text: "oklch(0.3 0 0)", background: "transparent", palette: ["#3266d6", "rebeccapurple"] },
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
    const own = resolveTheme({ background: "#000000", text: "#ffffff" });
    expect([own.tooltipBackground, own.tooltipBorder]).toEqual([
      dark.tooltipBackground,
      dark.tooltipBorder,
    ]);
    expect(resolveTheme({ text: "#ffffff", tooltipBackground: "#333333" }).tooltipBackground).toBe(
      "#333333",
    );
    const light = resolveTheme({ extends: "dark", text: "#111111" });
    expect(light.tooltipBackground).toBe(resolveTheme("light").tooltipBackground);
  });

  it("keeps text readable on each built-in theme's tooltip", () => {
    for (const name of ["light", "dark", "high-contrast", "high-contrast-dark"] as const) {
      const theme = resolveTheme(name);
      expect(isLightColor(theme.text)).not.toBe(isLightColor(theme.tooltipBackground));
    }
  });

  it("knows which themes read the page", () => {
    expect(themeReadsPage("auto")).toBe(true);
    expect(themeReadsPage("dark")).toBe(false);
    expect(themeReadsPage({ text: "#000000", palette: ["red"] })).toBe(false);
    expect(themeReadsPage({ text: "currentColor" })).toBe(true);
    expect(themeReadsPage({ background: "Canvas" })).toBe(true);
    expect(themeReadsPage({ palette: ["light-dark(#000, #fff)"] })).toBe(true);
    expect(themeReadsPage({ font: "var(--font, serif)" })).toBe(true);
  });
});
