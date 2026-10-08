import { Chart, Line } from "@herceg/vue";
import { table, time } from "herceg";
import { type Component, createApp, h } from "vue";

// Vue is excluded from this bundle: an application using the adapter already
// ships it. The entry measures herceg plus the adapter. (h() cannot infer the
// schema of a generic component; templates checked by vue-tsc do.)
export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  const data = table({ t: time(x), v: y });
  createApp({
    render: () => h(Chart, null, () => [h(Line as Component, { data, x: "t", y: "v" })]),
  }).mount(element);
}
