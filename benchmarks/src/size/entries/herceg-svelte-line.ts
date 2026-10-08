import { mount } from "svelte";
import LineChart from "./herceg-svelte-line.svelte";

// Svelte's runtime is excluded from this bundle: an application using the
// adapter already ships it. The entry measures herceg, the adapter, and the
// compiled component that uses it.
export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  mount(LineChart, { target: element, props: { x, y } });
}
