import { expect, it } from "vitest";
import { RowSet } from "../../src/data/row-set.ts";
import { selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { legendKey } from "../../src/marks/mark.ts";
import { point } from "../../src/marks/point.ts";
import { Highlighter } from "../../src/model/highlight.ts";
import { ChartModel } from "../../src/model/model.ts";
import type { PointGeometry, RectGeometry } from "../../src/scene/scene.ts";

it("keeps hidden legend groups' placement when selection splits their series", () => {
  const source = table({ day: ["thu", "thu"], sex: ["f", "m"], value: [1, 2] }) as unknown as Table;
  const store = selectionStore(source);
  const highlighter = new Highlighter([{ table: source, store, channel: "focus" }]);
  const model = new ChartModel({
    marks: [
      bar(source, { x: "day", y: "value", series: "sex", legendGroup: "sex" }),
      point(source, { x: "day", y: "value", series: "sex", dodge: true, legendGroup: "sex" }),
    ],
    locale: "en-US",
    timeZone: "UTC",
  });
  model.setSize(600, 400, 1);
  model.highlight = (mark, series, frame, key) =>
    highlighter.geometry(mark, series, frame, key) ?? mark.geometry(series, frame, key);
  const positions = () =>
    model.scene(estimateText).panels[0]!.marks.flatMap((geometry) => {
      if (geometry.kind !== "rect" && geometry.kind !== "point") return [];
      const shape = geometry as RectGeometry | PointGeometry;
      if (!shape.count) return [];
      return [
        Array.from(
          shape.kind === "rect"
            ? shape.rects.subarray(0, shape.count * 4)
            : shape.coords.subarray(0, shape.count * 2),
        ),
      ];
    });
  model.hidden.add(legendKey("sex", "f"));
  const before = positions();
  expect(before).toHaveLength(2);
  store.set("focus", selectRows(new RowSet(source).add(1)));
  expect(positions()).toEqual(before);
  model.dispose();
});
