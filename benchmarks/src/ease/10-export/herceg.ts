import { createChart, line, table, time } from "herceg";
import { renderToPDF } from "herceg/pdf";
import { days, p50 } from "../data.ts";

export async function render(container: HTMLElement) {
  const latency = table({ time: time(days), p50 });
  const options = {
    title: "Request latency",
    width: 640,
    height: 320,
    marks: [line(latency, { x: "time", y: "p50" })],
    y: { title: "ms" },
  };
  const chart = createChart(container, options);
  const svg = chart.toSVG();
  const pdf = renderToPDF(options);
  // There is no PNG export in the browser: draw the SVG on a canvas at twice the size.
  const image = new Image();
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    image.src = url;
    await image.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const canvas = Object.assign(document.createElement("canvas"), { width: 1280, height: 640 });
  canvas.getContext("2d")!.drawImage(image, 0, 0, canvas.width, canvas.height);
  const png = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("no PNG"))), "image/png"),
  );
  return { chart, svg, png, pdf };
}
