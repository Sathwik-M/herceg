// One animation-frame loop for every chart on the page. Updates requested
// during a frame (data appends, resizes, pointer moves) are coalesced into a
// single render per chart on the next frame, and charts outside the viewport
// wait until they scroll into view.

export interface Scheduled {
  /** Renders pending changes. Called at most once per frame. */
  flush(): void;
  /** False while the chart is outside the viewport. */
  readonly visible: boolean;
}

const pending = new Set<Scheduled>();
let frame = 0;
let frames = 0;
let lastFrame = 0;

function run() {
  frame = 0;
  frames++;
  const started = performance.now();
  const due = [...pending];
  pending.clear();
  for (const item of due) {
    // Invisible charts stay dirty and render when they become visible.
    if (!item.visible) continue;
    // One failing chart must not stop the others from rendering.
    try {
      item.flush();
    } catch (error) {
      report(error);
    }
  }
  lastFrame = performance.now() - started;
}

/** How many frames have run: work asked for between two frames shares the count. */
export function frameCount(): number {
  return frames;
}

/** How long every chart's rendering took in the last frame, in milliseconds. */
export function lastFrameTime(): number {
  return lastFrame;
}

/** Reports an error without stopping the code that ran into it. */
export function report(error: unknown): void {
  if (typeof reportError === "function") reportError(error);
  else console.error(error);
}

export function schedule(item: Scheduled): void {
  pending.add(item);
  if (frame === 0) frame = requestAnimationFrame(run);
}

export function unschedule(item: Scheduled): void {
  pending.delete(item);
}

type VisibilityListener = (visible: boolean) => void;
let observer: IntersectionObserver | undefined;
const listeners = new Map<Element, VisibilityListener>();

/** Reports when `element` enters or leaves the viewport. Returns a stop function. */
export function observeVisibility(element: Element, listener: VisibilityListener): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  observer ??= new IntersectionObserver((entries) => {
    for (const entry of entries) listeners.get(entry.target)?.(entry.isIntersecting);
  });
  listeners.set(element, listener);
  observer.observe(element);
  return () => {
    listeners.delete(element);
    observer?.unobserve(element);
  };
}
