// The frames a network's layout takes (see marks/node-positions.ts): a
// large network is laid out a slice of each frame, in frames of their own
// that do not draw it, and a frame draws how far the layout has come every
// so often (every frame for small networks, and while nodes ease into
// place). Every chart drawing a network loads this: its node-dragging
// controls use it, and so does `Controls` here, for charts without them.

import type { Controls as ChartControls, ControlsHost } from "./controls.ts";

/** Works on a chart's layouts in the frames after one that drew them. */
export class LayoutFrames {
  readonly #host: ControlsHost;
  #frame = 0;

  constructor(host: ControlsHost) {
    this.#host = host;
  }

  /** A frame drew the chart: layout work left goes on in the frames after it. */
  drew(): void {
    if (this.#frame || !this.#host.model.items?.pending) return;
    this.#frame = requestAnimationFrame(() => this.#next());
  }

  #next(): void {
    this.#frame = 0;
    const items = this.#host.model.items;
    if (!items?.pending) return;
    if (items.workLayouts()) this.#host.invalidate();
    else this.#frame = requestAnimationFrame(() => this.#next());
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
    this.#frame = 0;
  }
}

/** The controls of a chart whose network has no other controls: only its layout's frames. */
export class Controls implements ChartControls {
  readonly #frames: LayoutFrames;

  constructor(host: ControlsHost) {
    this.#frames = new LayoutFrames(host);
  }

  get busy(): boolean {
    return false;
  }

  update(): void {}

  draw(): void {
    this.#frames.drew();
  }

  dispose(): void {
    this.#frames.dispose();
  }
}
