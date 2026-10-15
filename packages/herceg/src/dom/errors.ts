// What a chart shows when it cannot draw: in place of a frame, a box of the
// chart's size saying so and why; over a last frame that is still right (an
// update it refused), a banner. Both are alerts, read out when they appear,
// with the message as text, never markup. Visible inside a chart hidden
// while it cannot draw (`visibility: hidden`), which hides its drawing from
// the pointer, the keyboard, and assistive technology.

/**
 * Shows `error` in `element`, where a chart could not draw: a box filling
 * it (or `size` CSS pixels, where the element has no size of its own), or
 * with `kept`, a banner over the last frame. Returns what it shows, for
 * the caller to remove once the chart draws.
 */
export function showFailure(
  element: HTMLElement | ShadowRoot,
  error: unknown,
  kept = false,
  size?: { width: number; height: number },
): HTMLElement {
  const shown = element.ownerDocument!.createElement("div");
  shown.setAttribute("role", "alert");
  shown.style.cssText = `visibility:visible;box-sizing:border-box;padding:8px 12px;overflow:auto;white-space:pre-line;font:13px/1.4 system-ui,sans-serif;color:#410e0b;background:#fff8f7;border:1px solid #f2b8b5;${
    size
      ? `width:${size.width}px;height:${size.height}px`
      : `position:absolute;inset:0;${kept ? "bottom:auto;max-height:50%" : ""}`
  }`;
  shown.textContent = `${kept ? "Chart update failed; showing previous data." : "Chart could not be rendered"}\n${
    error instanceof Error ? error.message : String(error)
  }`;
  element.append(shown);
  return shown;
}
