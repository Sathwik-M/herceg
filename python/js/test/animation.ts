// Deterministic clock for value animations through the notebook widget.
import { vi } from "vitest";

export async function controlTime(host: HTMLElement): Promise<void> {
  await vi.dynamicImportSettled();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "performance"] });
  // Refresh the shared scheduler's frame cost on the controlled clock.
  host.querySelector('[role="figure"]')!.dispatchEvent(new PointerEvent("pointerleave"));
  vi.advanceTimersByTime(32);
}

export function pointPath(host: ParentNode): string {
  return host.querySelector('[data-kind="point"]')!.getAttribute("d")!;
}
