/**
 * Growable buffer of polyline points in CSS pixels, reused across frames so
 * steady-state rendering does not allocate. A polyline can have gaps: each
 * entry of `starts` is the index of the first point of a run.
 */
export class Polyline {
  coords = new Float32Array(256);
  count = 0;
  starts: number[] = [];
  /**
   * While `curved`, the cubic Bezier control points of the segment into each
   * point from the one before it, four per point (x, y of each); NaN for
   * straight segments.
   */
  controls = new Float32Array(0);
  curved = false;
  /**
   * Set by the tracers (marks/trace.ts): there is a point for every row
   * traced, none left out by level of detail, a missing value, or an axis
   * break. Value transitions move only lines and areas traced whole.
   */
  whole = false;

  reset(): void {
    this.count = 0;
    this.starts.length = 0;
    this.curved = false;
  }

  /** Begins a new run; the next point is not connected to the previous one. */
  break(): void {
    if (this.starts[this.starts.length - 1] !== this.count) this.starts.push(this.count);
  }

  push(x: number, y: number): void {
    if (this.starts.length === 0) this.starts.push(0);
    const at = this.count * 2;
    if (at + 2 > this.coords.length) {
      const grown = new Float32Array(this.coords.length * 2);
      grown.set(this.coords);
      this.coords = grown;
    }
    this.coords[at] = x;
    this.coords[at + 1] = y;
    if (this.curved) {
      this.#reserveControls();
      this.controls[this.count * 4] = Number.NaN;
    }
    this.count++;
  }

  /** Adds a point reached from the previous one by a cubic curve with control points a and b. */
  curveTo(ax: number, ay: number, bx: number, by: number, x: number, y: number): void {
    if (!this.curved) {
      this.curved = true;
      this.#reserveControls();
      // Segments so far are straight.
      for (let i = 0; i < this.count; i++) this.controls[i * 4] = Number.NaN;
    }
    this.push(x, y);
    const at = (this.count - 1) * 4;
    this.controls[at] = ax;
    this.controls[at + 1] = ay;
    this.controls[at + 2] = bx;
    this.controls[at + 3] = by;
  }

  #reserveControls(): void {
    if (this.controls.length >= this.coords.length * 2) return;
    const grown = new Float32Array(this.coords.length * 2);
    grown.set(this.controls);
    this.controls = grown;
  }

  /** End index (exclusive) of run `run`. */
  runEnd(run: number): number {
    return this.starts[run + 1] ?? this.count;
  }

  /** Bytes held by the buffer, for memory accounting. */
  get byteLength(): number {
    return this.coords.byteLength + this.controls.byteLength + this.starts.length * 8;
  }
}
