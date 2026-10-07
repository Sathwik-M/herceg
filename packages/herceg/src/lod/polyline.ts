/**
 * Growable buffer of polyline points in CSS pixels, reused across frames so
 * steady-state rendering does not allocate. A polyline can have gaps: each
 * entry of `starts` is the index of the first point of a run.
 */
export class Polyline {
  coords = new Float32Array(256);
  count = 0;
  starts: number[] = [];

  reset(): void {
    this.count = 0;
    this.starts.length = 0;
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
    this.count++;
  }

  /** End index (exclusive) of run `run`. */
  runEnd(run: number): number {
    return this.starts[run + 1] ?? this.count;
  }

  /** Bytes held by the buffer, for memory accounting. */
  get byteLength(): number {
    return this.coords.byteLength + this.starts.length * 8;
  }
}
