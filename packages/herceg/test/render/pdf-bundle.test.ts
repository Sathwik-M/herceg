import { resolve } from "node:path";
import { build } from "esbuild";
import { expect, it } from "vitest";

const fontModules = [
  "pdf-font-resolver.ts",
  "pdf-truetype.ts",
  "pdf-font-subset.ts",
  "pdf-font-binary.ts",
  "pdf-text.ts",
];

it.each(["pdf.ts", "from-spec.ts"])(
  "%s excludes embedded font code from plain PDF exports",
  async (entry) => {
    const path = resolve(import.meta.dirname, "../../src", entry);
    const result = await build({
      stdin: {
        resolveDir: import.meta.dirname,
        contents: `export { ${entry === "pdf.ts" ? "renderToPDF" : "specToPDF"} } from ${JSON.stringify(path)};`,
      },
      bundle: true,
      format: "esm",
      target: "es2022",
      outdir: "out",
      splitting: true,
      write: false,
      metafile: true,
    });
    const included = Object.values(result.metafile!.outputs).flatMap((output) =>
      Object.entries(output.inputs)
        .filter(([, input]) => input.bytesInOutput > 0)
        .map(([path]) => path),
    );
    for (const name of fontModules)
      expect(
        included.some((path) => path.endsWith(name)),
        name,
      ).toBe(false);
  },
);

it("pdfFonts includes the parser and subsetter when embedded fonts are requested", async () => {
  const path = resolve(import.meta.dirname, "../../src/pdf.ts");
  const result = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `export { pdfFonts, renderToPDF } from ${JSON.stringify(path)};`,
    },
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    metafile: true,
  });
  const included = Object.values(result.metafile!.outputs).flatMap((output) =>
    Object.entries(output.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([path]) => path),
  );
  for (const name of fontModules)
    expect(
      included.some((path) => path.endsWith(name)),
      name,
    ).toBe(true);
});

it("renderToPDF includes paper sizing without retaining unused embedded-font code", async () => {
  const path = resolve(import.meta.dirname, "../../src/pdf.ts");
  const result = await build({
    stdin: {
      resolveDir: import.meta.dirname,
      contents: `export { renderToPDF } from ${JSON.stringify(path)};`,
    },
    bundle: true,
    format: "esm",
    target: "es2022",
    write: false,
    metafile: true,
  });
  const included = Object.entries(Object.values(result.metafile!.outputs)[0]!.inputs)
    .filter(([, input]) => input.bytesInOutput > 0)
    .map(([path]) => path);
  expect(included.some((path) => path.endsWith("render/pdf-paper.ts"))).toBe(true);
  for (const name of fontModules)
    expect(
      included.some((path) => path.endsWith(name)),
      name,
    ).toBe(false);
});
