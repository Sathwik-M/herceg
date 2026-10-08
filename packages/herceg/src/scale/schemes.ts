// Named color schemes: ramps for continuous color (sequential, from low to
// high; diverging, through a neutral middle) and lists for categories. Each
// is a separate export so a chart bundles only the schemes it imports; specs
// name them, and the spec loader resolves names through `schemes`.

// Perceptually uniform ramps (matplotlib's viridis family, and turbo), sampled.
export const viridis = [
  "#440154",
  "#482878",
  "#3e4989",
  "#31688e",
  "#26828e",
  "#1f9e89",
  "#35b779",
  "#6ece58",
  "#b5de2b",
  "#fde725",
];
export const magma = [
  "#000004",
  "#180f3d",
  "#440f76",
  "#721f81",
  "#9e2f7f",
  "#cd4071",
  "#f1605d",
  "#fd9668",
  "#feca8d",
  "#fcfdbf",
];
export const inferno = [
  "#000004",
  "#1b0c41",
  "#4a0c6b",
  "#781c6d",
  "#a52c60",
  "#cf4446",
  "#ed6925",
  "#fb9b06",
  "#f7d13d",
  "#fcffa4",
];
export const plasma = [
  "#0d0887",
  "#46039f",
  "#7201a8",
  "#9c179e",
  "#bd3786",
  "#d8576b",
  "#ed7953",
  "#fb9f3a",
  "#fdca26",
  "#f0f921",
];
export const cividis = [
  "#00224e",
  "#123570",
  "#3b496c",
  "#575d6d",
  "#707173",
  "#8a8678",
  "#a59c74",
  "#c3b369",
  "#e1cc55",
  "#fee838",
];
export const turbo = [
  "#30123b",
  "#4145ab",
  "#4675ed",
  "#39a2fc",
  "#1bcfd4",
  "#24eca6",
  "#61fc6c",
  "#a4fc3b",
  "#d1e834",
  "#f3c63a",
  "#fe9b2d",
  "#f36315",
  "#d93806",
  "#b11901",
  "#7a0403",
];

// ColorBrewer sequential ramps (9 classes).
export const blues = [
  "#f7fbff",
  "#deebf7",
  "#c6dbef",
  "#9ecae1",
  "#6baed6",
  "#4292c6",
  "#2171b5",
  "#08519c",
  "#08306b",
];
export const greens = [
  "#f7fcf5",
  "#e5f5e0",
  "#c7e9c0",
  "#a1d99b",
  "#74c476",
  "#41ab5d",
  "#238b45",
  "#006d2c",
  "#00441b",
];
export const greys = [
  "#ffffff",
  "#f0f0f0",
  "#d9d9d9",
  "#bdbdbd",
  "#969696",
  "#737373",
  "#525252",
  "#252525",
  "#000000",
];
export const oranges = [
  "#fff5eb",
  "#fee6ce",
  "#fdd0a2",
  "#fdae6b",
  "#fd8d3c",
  "#f16913",
  "#d94801",
  "#a63603",
  "#7f2704",
];
export const purples = [
  "#fcfbfd",
  "#efedf5",
  "#dadaeb",
  "#bcbddc",
  "#9e9ac8",
  "#807dba",
  "#6a51a3",
  "#54278f",
  "#3f007d",
];
export const reds = [
  "#fff5f0",
  "#fee0d2",
  "#fcbba1",
  "#fc9272",
  "#fb6a4a",
  "#ef3b2c",
  "#cb181d",
  "#a50f15",
  "#67000d",
];
export const ylgnbu = [
  "#ffffd9",
  "#edf8b1",
  "#c7e9b4",
  "#7fcdbb",
  "#41b6c4",
  "#1d91c0",
  "#225ea8",
  "#253494",
  "#081d58",
];
export const ylorrd = [
  "#ffffcc",
  "#ffeda0",
  "#fed976",
  "#feb24c",
  "#fd8d3c",
  "#fc4e2a",
  "#e31a1c",
  "#bd0026",
  "#800026",
];

// ColorBrewer diverging ramps (11 classes), low end first.
export const rdbu = [
  "#67001f",
  "#b2182b",
  "#d6604d",
  "#f4a582",
  "#fddbc7",
  "#f7f7f7",
  "#d1e5f0",
  "#92c5de",
  "#4393c3",
  "#2166ac",
  "#053061",
];
export const rdylbu = [
  "#a50026",
  "#d73027",
  "#f46d43",
  "#fdae61",
  "#fee090",
  "#ffffbf",
  "#e0f3f8",
  "#abd9e9",
  "#74add1",
  "#4575b4",
  "#313695",
];
export const brbg = [
  "#543005",
  "#8c510a",
  "#bf812d",
  "#dfc27d",
  "#f6e8c3",
  "#f5f5f5",
  "#c7eae5",
  "#80cdc1",
  "#35978f",
  "#01665e",
  "#003c30",
];
export const piyg = [
  "#8e0152",
  "#c51b7d",
  "#de77ae",
  "#f1b6da",
  "#fde0ef",
  "#f7f7f7",
  "#e6f5d0",
  "#b8e186",
  "#7fbc41",
  "#4d9221",
  "#276419",
];
export const prgn = [
  "#40004b",
  "#762a83",
  "#9970ab",
  "#c2a5cf",
  "#e7d4e8",
  "#f7f7f7",
  "#d9f0d3",
  "#a6dba0",
  "#5aae61",
  "#1b7837",
  "#00441b",
];
export const puor = [
  "#7f3b08",
  "#b35806",
  "#e08214",
  "#fdb863",
  "#fee0b6",
  "#f7f7f7",
  "#d8daeb",
  "#b2abd2",
  "#8073ac",
  "#542788",
  "#2d004b",
];
export const spectral = [
  "#9e0142",
  "#d53e4f",
  "#f46d43",
  "#fdae61",
  "#fee08b",
  "#ffffbf",
  "#e6f598",
  "#abdda4",
  "#66c2a5",
  "#3288bd",
  "#5e4fa2",
];

// Categorical palettes (Tableau 10, d3's category10, ColorBrewer Set2 and Dark2).
export const tableau10 = [
  "#4e79a7",
  "#f28e2c",
  "#e15759",
  "#76b7b2",
  "#59a14f",
  "#edc949",
  "#af7aa1",
  "#ff9da7",
  "#9c755f",
  "#bab0ab",
];
export const category10 = [
  "#1f77b4",
  "#ff7f0e",
  "#2ca02c",
  "#d62728",
  "#9467bd",
  "#8c564b",
  "#e377c2",
  "#7f7f7f",
  "#bcbd22",
  "#17becf",
];
export const set2 = [
  "#66c2a5",
  "#fc8d62",
  "#8da0cb",
  "#e78ac3",
  "#a6d854",
  "#ffd92f",
  "#e5c494",
  "#b3b3b3",
];
export const dark2 = [
  "#1b9e77",
  "#d95f02",
  "#7570b3",
  "#e7298a",
  "#66a61e",
  "#e6ab02",
  "#a6761d",
  "#666666",
];

/** Every scheme by name, as specs name them. */
export const schemes: Readonly<Record<string, readonly string[]>> = {
  viridis,
  magma,
  inferno,
  plasma,
  cividis,
  turbo,
  blues,
  greens,
  greys,
  oranges,
  purples,
  reds,
  ylgnbu,
  ylorrd,
  rdbu,
  rdylbu,
  brbg,
  piyg,
  prgn,
  puor,
  spectral,
  tableau10,
  category10,
  set2,
  dark2,
};

/** The colors of a scheme named in a spec, or an error listing the names. */
export function scheme(name: string): readonly string[] {
  const colors = Object.hasOwn(schemes, name) ? schemes[name] : undefined;
  if (!colors) {
    throw new RangeError(
      `Unknown color scheme "${name}"; use one of ${Object.keys(schemes).join(", ")}`,
    );
  }
  return colors;
}
