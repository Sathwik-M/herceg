import { describe, expect, it } from "vitest";
import { facesDrawing, traceFace } from "../../src/draw/faces.ts";
import { FaceBuffer, FaceIndex, radixSort } from "../../src/three/faces.ts";

const BOUNDS = { x: 0, y: 0, width: 200, height: 200 };

function buffer(): FaceBuffer {
  const faces = new FaceBuffer();
  faces.reset();
  return faces;
}

/** A flat square of a side at (x, y), with a sort key and depth. */
function square(
  faces: FaceBuffer,
  x: number,
  y: number,
  style: number,
  key: number,
  depth: number,
  side = 10,
) {
  const v = [
    faces.vertex(x, y, depth),
    faces.vertex(x + side, y, depth),
    faces.vertex(x + side, y + side, depth),
    faces.vertex(x, y + side, depth),
  ];
  faces.begin();
  for (const i of v) faces.corner(i);
  faces.face(style, key, depth, faces.count);
}

/** A disc centered at (x, y). */
function disc(faces: FaceBuffer, x: number, y: number, style: number, key: number, depth: number) {
  faces.begin();
  faces.corner(faces.vertex(x, y, depth));
  faces.face(style, key, depth, faces.count);
}

/** What the faces are, in drawing order: each one's local value. */
function drawn(faces: FaceBuffer): number[] {
  return Array.from(faces.drawn.subarray(0, faces.count), (f) => faces.local[f]!);
}

describe("radix sorting", () => {
  it("orders by key, stable among equal keys", () => {
    const n = 5000;
    const keys = new Uint32Array(n);
    let seed = 1;
    for (let i = 0; i < n; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      keys[i] = seed % 97 === 0 ? 7 : seed;
    }
    const order = Uint32Array.from({ length: n }, (_, i) => i);
    radixSort(order, n, keys, new Uint32Array(n));
    const expected = Array.from({ length: n }, (_, i) => i).sort(
      (a, b) => keys[a]! - keys[b]! || a - b,
    );
    expect(Array.from(order)).toEqual(expected);
  });
});

describe("face buffers", () => {
  it("draw far faces first, then by key when keyed", () => {
    const faces = buffer();
    const style = faces.styleOf("#000000", 1, 0);
    square(faces, 0, 0, style, 2, -0.5);
    square(faces, 0, 0, style, 1, 0.75);
    square(faces, 0, 0, style, 1, -2);
    expect(Array.from(faces.geometry("faces", false, BOUNDS).starts.slice(0, 4))).toEqual([
      0, 4, 8, 12,
    ]);
    faces.geometry("faces", false, BOUNDS);
    expect(Array.from(faces.drawn.subarray(0, 3))).toEqual([2, 0, 1]);
    faces.geometry("faces", true, BOUNDS);
    expect(Array.from(faces.drawn.subarray(0, 3))).toEqual([2, 1, 0]);
  });

  it("draw a disc before a nearer polygon its edge reaches, and after polygons behind it", () => {
    const faces = buffer();
    const cell = faces.styleOf("#000000", 1, 0);
    const dot = faces.styleOf("#ff0000", 1, 5);
    // Faces 0 and 1: a rectangle nearer than a disc left of it, which it cuts.
    square(faces, 20, 20, cell, 0, 1, 20);
    disc(faces, 18, 30, dot, 0, 0);
    // Faces 2 to 4: an opaque square behind a disc and a translucent one in front.
    square(faces, 100, 100, cell, 0, -1, 20);
    disc(faces, 110, 110, dot, 0, 0);
    square(faces, 100, 100, faces.styleOf("#00ff00", 0.5, 0), 0, 1, 20);
    const mark = faces.geometry("faces", false, BOUNDS);
    // Discs go as early as they can: the first overlaps nothing behind it.
    expect(drawn(faces)).toEqual([1, 2, 3, 0, 4]);
    expect(mark.count).toBe(5);
    // The rectangle is in front where it overlaps the disc.
    const index = new FaceIndex(mark, BOUNDS);
    expect(faces.local[faces.drawn[index.find(21, 30)]!]).toBe(0);
    expect(faces.local[faces.drawn[index.find(15, 30)]!]).toBe(1);
  });

  it("draw a disc after the cells behind it that its edge reaches, and before cells over its center", () => {
    const faces = buffer();
    const cell = faces.styleOf("#000000", 1, 0);
    const dot = faces.styleOf("#ff0000", 1, 4);
    // Two flat cells, drawn in key order, and two discs above them between
    // in that order: one over the first cell, its edge reaching the second,
    // and one the second covers the center of (the order says it is in front).
    square(faces, 0, 0, cell, 0, -1);
    disc(faces, 8, 5, dot, 1, 0);
    disc(faces, 15, 5, dot, 1, 0);
    square(faces, 10, 0, cell, 2, -1);
    faces.geometry("faces", true, BOUNDS);
    expect(drawn(faces)).toEqual([0, 2, 3, 1]);
  });

  it("draw overlapping discs by depth whatever cells they are in", () => {
    const faces = buffer();
    const cell = faces.styleOf("#000000", 1, 0);
    const dot = faces.styleOf("#ff0000", 1, 4);
    // Seen from above: a flat surface of two cells, a near disc over the
    // first and a far one over the second, the far one later by its key.
    square(faces, 0, 0, cell, 0, -1);
    disc(faces, 5, 9, dot, 1, 0.8);
    square(faces, 0, 10, cell, 2, -1);
    disc(faces, 5, 11, dot, 3, -0.8);
    faces.geometry("faces", true, BOUNDS);
    expect(drawn(faces)).toEqual([0, 2, 3, 1]);
  });

  it("judge a disc against a segment by the segment's depth under it, in perspective too", () => {
    // A segment from far (depth -1.5) to near (1.5) across the screen, and a
    // disc over its middle at depth 0.3: orthographically the segment's depth
    // there is 0, so the disc is in front; in perspective (the eye 5 away)
    // the middle on screen is nearer the near end, about 0.43 deep.
    for (const [eye, order] of [
      [Number.POSITIVE_INFINITY, [0, 1]],
      [5, [1, 0]],
    ] as const) {
      const faces = buffer();
      faces.begin();
      faces.corner(faces.vertex(20, 50, -1.5));
      faces.corner(faces.vertex(180, 50, 1.5));
      faces.face(faces.styleOf("#000000", 1, 0, "#000000", 8), 0, 0, 0);
      disc(faces, 100, 50, faces.styleOf("#ff0000", 1, 3), 0, 0.3);
      faces.geometry("faces", false, BOUNDS, eye);
      expect(drawn(faces)).toEqual(order);
    }
  });

  it("strokes segments round-capped, and finds them within reach of their stroke", () => {
    const faces = buffer();
    faces.begin();
    faces.corner(faces.vertex(10, 10, 0));
    faces.corner(faces.vertex(90, 10, 0));
    faces.face(faces.styleOf("#00aa00", 1, 0, "#00aa00", 4), 0, 0, 5);
    const mark = faces.geometry("faces", false, BOUNDS);
    expect(facesDrawing.svg(mark, { theme: undefined as never, encodeRaster: undefined })).toBe(
      '<path d="M10 10L90 10" fill="none" stroke="#00aa00" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"/>',
    );
    const index = new FaceIndex(mark, BOUNDS);
    // Half the width and 3 pixels of reach past it.
    expect(index.find(50, 14.9)).toBe(0);
    expect(index.find(50, 15.1)).toBe(-1);
    expect(index.find(94.5, 10)).toBe(0);
  });

  it("share styles by value", () => {
    const faces = buffer();
    expect(faces.styleOf("#000000", 1, 3)).toBe(0);
    expect(faces.styleOf("#ff0000", 1, 3)).toBe(1);
    expect(faces.styleOf("#000000", 1, 3)).toBe(0);
    expect(faces.styleOf("#000000", 0.5, 3)).toBe(2);
  });
});

describe("face drawing", () => {
  it("fills a folded cell as its two triangles, turned alike", () => {
    const faces = buffer();
    // A quad whose fan from a has one triangle each way: seen edge on, folded.
    const v = [
      [0, 0],
      [10, 0],
      [5, 5],
      [20, 10],
    ].map(([x, y]) => faces.vertex(x!, y!, 0));
    faces.begin();
    for (const i of v) faces.corner(i);
    faces.face(faces.styleOf("#000000", 1, 0), 0, 0, 0);
    const mark = faces.geometry("faces", false, BOUNDS);
    const calls: string[] = [];
    traceFace(
      {
        moveTo: (x, y) => calls.push(`M${x},${y}`),
        lineTo: (x, y) => calls.push(`L${x},${y}`),
        closePath: () => calls.push("Z"),
        disc: () => calls.push("disc"),
      },
      mark,
      0,
    );
    // Two triangles, both counterclockwise on screen (y down).
    expect(calls).toEqual(["M0,0", "L10,0", "L5,5", "Z", "M0,0", "L20,10", "L5,5", "Z"]);
  });

  it("traces every simple polygon turned the same way, so faces filled together never cancel", () => {
    const faces = buffer();
    const style = faces.styleOf("#000000", 1, 0);
    // One square counterclockwise on screen, one clockwise.
    for (const order of [
      [0, 1, 2, 3],
      [3, 2, 1, 0],
    ]) {
      const v = [
        faces.vertex(0, 0, 0),
        faces.vertex(10, 0, 0),
        faces.vertex(10, 10, 0),
        faces.vertex(0, 10, 0),
      ];
      faces.begin();
      for (const k of order) faces.corner(v[k]!);
      faces.face(style, 0, 0, faces.count);
    }
    const mark = faces.geometry("faces", false, BOUNDS);
    const areas = [0, 1].map((f) => {
      const points: [number, number][] = [];
      traceFace(
        {
          moveTo: (x, y) => points.push([x, y]),
          lineTo: (x, y) => points.push([x, y]),
          closePath: () => {},
          disc: () => {},
        },
        mark,
        f,
      );
      let area = 0;
      for (let k = 0; k < points.length; k++) {
        const [x0, y0] = points[k]!;
        const [x1, y1] = points[(k + 1) % points.length]!;
        area += x0 * y1 - x1 * y0;
      }
      return Math.sign(area);
    });
    expect(areas[0]).toBe(areas[1]);
  });

  it("draws faces of a translucent color one by one", () => {
    const faces = buffer();
    const style = faces.styleOf("rgba(255, 0, 0, 0.5)", 1, 3);
    for (const x of [10, 12]) {
      faces.begin();
      faces.corner(faces.vertex(x, 10, 0));
      faces.face(style, 0, 0, 0);
    }
    const paths = facesDrawing.elements!(faces.geometry("faces", false, BOUNDS), {
      theme: undefined as never,
      encodeRaster: undefined,
    })!;
    expect(paths).toHaveLength(2);
  });

  it("batches opaque faces of a style, and draws translucent and outlined ones one by one", () => {
    const faces = buffer();
    const opaque = faces.styleOf("#000000", 1, 0, "#000000", 0.5);
    const faint = faces.styleOf("#ff0000", 0.5, 0);
    const wired = faces.styleOf("#00ff00", 1, 0, "#888888", 0.6);
    for (const [k, style] of [opaque, opaque, faint, faint, wired, wired].entries())
      square(faces, k * 20, 0, style, 0, k);
    const mark = faces.geometry("faces", false, BOUNDS);
    const paths = facesDrawing.elements!(mark, {
      theme: undefined as never,
      encodeRaster: undefined,
    })!;
    // One fill and its seam outline, two translucent fills, two fills each with its wire.
    expect(paths.map((p) => p.attributes.fill)).toEqual([
      "#000000",
      "none",
      "#ff0000",
      "#ff0000",
      "#00ff00",
      "none",
      "#00ff00",
      "none",
    ]);
    expect(paths[2]!.attributes["fill-opacity"]).toBe("0.5");
  });

  it("writes discs as arcs", () => {
    const faces = buffer();
    faces.begin();
    faces.corner(faces.vertex(10, 20, 0));
    faces.face(faces.styleOf("#123456", 1, 3), 0, 0, 0);
    const svg = facesDrawing.svg(faces.geometry("faces", false, BOUNDS), {
      theme: undefined as never,
      encodeRaster: undefined,
    });
    expect(svg).toBe('<path d="M7 20a3 3 0 1 0 6 0a3 3 0 1 0 -6 0" fill="#123456"/>');
  });
});

describe("face picking", () => {
  it("finds the face drawn last under the pointer, and discs within reach", () => {
    const faces = buffer();
    const style = faces.styleOf("#000000", 1, 0);
    square(faces, 0, 0, style, 0, 0);
    square(faces, 5, 5, style, 0, 1);
    faces.begin();
    faces.corner(faces.vertex(50, 50, 2));
    faces.face(faces.styleOf("#000000", 1, 4), 0, 2, 7);
    const mark = faces.geometry("faces", false, BOUNDS);
    const index = new FaceIndex(mark, { x: 0, y: 0, width: 100, height: 100 });
    const at = (x: number, y: number) => {
      const k = index.find(x, y);
      return k < 0 ? -1 : faces.local[faces.drawn[k]!];
    };
    expect(at(2, 2)).toBe(0);
    expect(at(7, 7)).toBe(1);
    expect(at(30, 30)).toBe(-1);
    expect(at(56, 50)).toBe(7);
    expect(at(58, 50)).toBe(-1);
  });
});
