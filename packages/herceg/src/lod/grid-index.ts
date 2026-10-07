/**
 * Uniform grid over pixel positions for nearest-point queries. Points are
 * bucketed by cell with a counting sort (two Uint32Arrays, no per-point
 * objects); a query visits rings of cells around the target until no closer
 * point can exist.
 */
export class GridIndex {
  readonly #cell: number;
  readonly #columns: number;
  readonly #rows: number;
  readonly #x0: number;
  readonly #y0: number;
  readonly #starts: Uint32Array;
  readonly #items: Uint32Array;
  readonly #coords: Float32Array;
  readonly #ids: Uint32Array;

  /**
   * Indexes `count` points whose pixel coordinates are `coords[2i], coords[2i+1]`,
   * within the rectangle `x0, y0, width, height`. Item `i` is reported as `ids[i]`.
   */
  constructor(
    coords: Float32Array,
    ids: Uint32Array,
    count: number,
    bounds: { x: number; y: number; width: number; height: number },
    cell = 16,
  ) {
    this.#cell = cell;
    this.#x0 = bounds.x;
    this.#y0 = bounds.y;
    this.#columns = Math.max(1, Math.ceil(bounds.width / cell));
    this.#rows = Math.max(1, Math.ceil(bounds.height / cell));
    const cells = this.#columns * this.#rows;
    this.#starts = new Uint32Array(cells + 1);
    this.#coords = coords;
    const cellOf = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const c = this.#cellOf(coords[i * 2]!, coords[i * 2 + 1]!);
      cellOf[i] = c;
      this.#starts[c + 1]!++;
    }
    for (let c = 0; c < cells; c++) this.#starts[c + 1]! += this.#starts[c]!;
    const fill = this.#starts.slice(0, cells);
    this.#items = new Uint32Array(count);
    for (let i = 0; i < count; i++) this.#items[fill[cellOf[i]!]!++] = i;
    this.#ids = ids;
  }

  #cellOf(x: number, y: number): number {
    const column = Math.min(
      this.#columns - 1,
      Math.max(0, Math.floor((x - this.#x0) / this.#cell)),
    );
    const row = Math.min(this.#rows - 1, Math.max(0, Math.floor((y - this.#y0) / this.#cell)));
    return row * this.#columns + column;
  }

  /** The id of the point nearest (x, y) within `maxDistance` pixels, with its distance. */
  nearest(
    x: number,
    y: number,
    maxDistance = Infinity,
  ): { id: number; distance: number } | undefined {
    const column = Math.min(
      this.#columns - 1,
      Math.max(0, Math.floor((x - this.#x0) / this.#cell)),
    );
    const row = Math.min(this.#rows - 1, Math.max(0, Math.floor((y - this.#y0) / this.#cell)));
    let best = -1;
    let bestDistance = maxDistance * maxDistance;
    const rings = Math.max(this.#columns, this.#rows);
    for (let ring = 0; ring <= rings; ring++) {
      // Points in ring r are at least (r - 1) cells away from the target.
      const reach = (ring - 1) * this.#cell;
      if (ring > 0 && reach > 0 && reach * reach > bestDistance) break;
      for (let r = row - ring; r <= row + ring; r++) {
        if (r < 0 || r >= this.#rows) continue;
        const edge = r === row - ring || r === row + ring;
        for (let c = column - ring; c <= column + ring; c += edge || ring === 0 ? 1 : 2 * ring) {
          if (c < 0 || c >= this.#columns) continue;
          const cell = r * this.#columns + c;
          for (let k = this.#starts[cell]!; k < this.#starts[cell + 1]!; k++) {
            const i = this.#items[k]!;
            const dx = this.#coords[i * 2]! - x;
            const dy = this.#coords[i * 2 + 1]! - y;
            const d = dx * dx + dy * dy;
            if (d < bestDistance) {
              bestDistance = d;
              best = i;
            }
          }
        }
      }
    }
    return best < 0 ? undefined : { id: this.#ids[best]!, distance: Math.sqrt(bestDistance) };
  }

  /** Bytes held by the index, for memory accounting. */
  get byteLength(): number {
    return this.#starts.byteLength + this.#items.byteLength;
  }
}
