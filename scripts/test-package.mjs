// Tests installed tarballs. Run `npm run build` first; build tools stay in the workspace.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { npm, root, run, withTempProject, writeJSON } from "./temp-project.mjs";

const require = createRequire(import.meta.url);
const svelteRequire = createRequire(join(root, "packages/svelte/package.json"));
const packages = ["herceg", "react", "vue", "svelte"];
// Fixed API fixtures catch removed subpaths and redirects to unrelated APIs.
const publicAPIs = {
  herceg: ["createChart", "line", "table", "time"],
  "herceg/spec": ["loadSpec"],
  "herceg/pdf": ["renderToPDF"],
  "herceg/grid": ["createGrid"],
  "herceg/grid/model": ["createGridModel"],
  "herceg/grid/pivot": ["createPivotGrid"],
  "herceg/grid/remote": ["createRemoteGrid", "createRemoteGridModel"],
  "herceg/grid/memory": ["memorySource"],
  "herceg/grid/conformance": ["checkGridSource", "GRID_SOURCE_FIXTURES"],
  "herceg/pivot": ["pivotRows"],
  "@herceg/react": ["Chart", "Line"],
  "@herceg/react/grid": ["Grid"],
  "@herceg/vue": ["Chart", "Line"],
  "@herceg/svelte": ["Chart", "Line"],
};
const readJSON = (path) => JSON.parse(readFileSync(path, "utf8"));
const unwanted =
  /(?:^|\/)(?:tests?|__tests__|bench(?:marks|es)?|tmp)(?:\/|\.|$)|\.(?:test|spec|bench|benchmark)\./i;

function targets(value) {
  if (typeof value === "string") return [value];
  if (value === null) return [];
  assert(value && typeof value === "object", "Invalid exports target");
  return Object.values(value).flatMap(targets);
}

function subpaths(manifest) {
  return Object.keys(manifest.exports).map((key) => {
    assert(key === "." || key.startsWith("./"), `Unsupported export key: ${key}`);
    assert(!key.includes("*"), `Add wildcard expansion for export key: ${key}`);
    return key === "." ? manifest.name : `${manifest.name}${key.slice(1)}`;
  });
}

await withTempProject("test:package", async (consumer, step) => {
  // npm run can inherit selectors for the workspace that launched this script.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !/^npm_config_(?:workspace.*|include[_-]workspace[_-]root|w|ws)$/i.test(name),
    ),
  );
  const license = readFileSync(join(root, "LICENSE"));
  const packed = [];
  const peers = {};
  await step("Pack four packages; check files, export targets, and licenses", () => {
    for (const folder of packages) {
      const directory = join(root, "packages", folder);
      const workspace = readJSON(join(directory, "package.json"));
      for (const peer of Object.keys(workspace.peerDependencies ?? {})) {
        // Resolve from the package, including dependencies installed in a nested node_modules.
        const resolve = createRequire(join(directory, "package.json"));
        const version = readJSON(resolve.resolve(`${peer}/package.json`)).version;
        assert(
          !peers[peer] || peers[peer] === version,
          `Workspace peer versions disagree: ${peer}`,
        );
        peers[peer] = version;
      }
      const [pack] = JSON.parse(
        run(
          npm,
          [
            "pack",
            directory,
            "--workspaces=false",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            consumer,
          ],
          {
            cwd: consumer,
            env,
          },
        ),
      );
      const tarball = join(consumer, pack.filename);
      const manifest = JSON.parse(run("tar", ["-xOf", tarball, "package/package.json"]));
      const files = new Set(pack.files.map(({ path }) => path));
      assert(files.size > 0, `${manifest.name}: empty tarball`);
      for (const file of files) {
        assert(!unwanted.test(file), `${manifest.name}: unwanted file ${file}`);
      }
      const licenses = [...files].filter((file) => /^LICENSE(?:\..*)?$/i.test(file));
      assert(licenses.length > 0, `${manifest.name}: no LICENSE`);
      for (const file of licenses) {
        const contents = run("tar", ["-xOf", tarball, `package/${file}`], { encoding: null });
        assert(contents.equals(license), `${manifest.name}: ${file} differs from root LICENSE`);
      }
      for (const target of targets(manifest.exports)) {
        assert(target.startsWith("./"), `${manifest.name}: invalid export target ${target}`);
        assert(files.has(target.slice(2)), `${manifest.name}: missing export target ${target}`);
      }
      packed.push({
        manifest,
        tarball,
        declarations: [...files].filter((file) => file.endsWith(".d.ts")),
      });
      console.log(`  ${manifest.name}: ${files.size} files, ${subpaths(manifest).length} subpaths`);
    }
  });

  const entrypoints = packed.flatMap(({ manifest }) => subpaths(manifest));
  for (const path of Object.keys(publicAPIs)) {
    // TypeScript can otherwise fall back to an ancestor's node_modules.
    assert(entrypoints.includes(path), `Missing public entrypoint: ${path}`);
  }

  await step("Install tarballs and workspace peer versions into a fresh consumer", () => {
    const dependencies = Object.fromEntries(
      packed.map(({ manifest, tarball }) => [manifest.name, tarball]),
    );
    Object.assign(dependencies, peers);
    for (const name of ["@types/react", "@types/react-dom"]) {
      dependencies[name] = readJSON(require.resolve(`${name}/package.json`)).version;
    }
    writeJSON(join(consumer, "package.json"), { private: true, type: "module", dependencies });
    run(npm, ["install", "--workspaces=false", "--prefer-offline", "--no-audit", "--no-fund"], {
      cwd: consumer,
      env,
    });
    console.log(
      `  peers: ${Object.entries(peers)
        .map(([name, version]) => `${name}@${version}`)
        .join(", ")}`,
    );
    for (const { manifest } of packed) {
      const installed = realpathSync(join(consumer, "node_modules", manifest.name));
      const path = relative(consumer, installed);
      assert(!path.startsWith("..") && !isAbsolute(path), `${manifest.name}: workspace link`);
    }
  });

  await step("Import every Node subpath, resolve default conditions, and render static SVG", () => {
    const imports = packed
      .filter(({ manifest }) => manifest.name !== "@herceg/svelte")
      .flatMap(({ manifest }) => subpaths(manifest));
    writeFileSync(
      join(consumer, "smoke.mjs"),
      `import assert from "node:assert/strict";
import { createRequire } from "node:module";
const resolve = createRequire(import.meta.url);
const publicAPIs = ${JSON.stringify(publicAPIs)};
for (const path of ${JSON.stringify(imports)}) {
  // require.resolve selects default when neither import nor types is active.
  resolve.resolve(path);
  const module = await import(path);
  assert(Object.keys(module).length > 0, path + ": empty module");
  for (const name of publicAPIs[path] ?? []) {
    assert(module[name] !== undefined, path + ": missing " + name);
  }
}
const { createChart, table, line, renderToSVG } = await import("herceg");
assert.equal(typeof createChart, "function");
for (const name of ["@herceg/react", "@herceg/vue"]) {
  const module = await import(name);
  assert(module.Chart && module.Line, name + ": missing chart components");
}
assert.equal(typeof (await import("@herceg/react/grid")).Grid, "function");
const svg = renderToSVG({
  marks: [line(table({ x: [1, 2, 3], y: [3, 1, 2] }), { x: "x", y: "y" })],
  width: 300, height: 150,
});
assert(svg.startsWith("<svg"), "static SVG output");
`,
    );
    run(process.execPath, ["smoke.mjs"], { cwd: consumer });
    console.log(
      `  ${imports.length} imports; Svelte uses its svelte condition in the bundler check`,
    );
  });

  // NodeNext may resolve .svelte imports through Svelte's ambient wildcard.
  // Include the emitted declarations explicitly so none escape validation.
  const svelteDeclarations = packed
    .filter(({ manifest }) => manifest.name === "@herceg/svelte")
    .flatMap(({ manifest, declarations }) =>
      declarations.map((file) => join("node_modules", manifest.name, file)),
    );
  assert(svelteDeclarations.length > 0, "Svelte: no emitted declarations");
  writeFileSync(
    join(consumer, "entrypoints.ts"),
    entrypoints
      .map(
        (path, i) =>
          `import type * as entry${i} from ${JSON.stringify(path)};\nexport type Entry${i} = typeof entry${i};\n`,
      )
      .join("\n"),
  );
  writeFileSync(
    join(consumer, "api.ts"),
    Object.entries(publicAPIs)
      .map(
        ([path, names], i) =>
          `export { ${names.map((name) => `${name} as api${i}_${name}`).join(", ")} } from ${JSON.stringify(path)};\n`,
      )
      .join(""),
  );
  writeFileSync(
    join(consumer, "types.ts"),
    `import { line, table, time } from "herceg";
import type { ChartProps } from "@herceg/svelte";
const data = table({ t: time([0, 1]), v: [1, 2] });
line(data, { x: "t", y: "v" });
// @ts-expect-error a misspelled field must remain a compile error
line(data, { x: "t", y: "missing" });
export const svelteChartProps: ChartProps = { title: "Package test", renderer: "svg" };
`,
  );
  writeFileSync(
    join(consumer, "types.tsx"),
    `import { Chart, Line } from "@herceg/react";
import { table, time } from "herceg";
const data = table({ t: time([0, 1]), v: [1, 2] });
export const view = <Chart><Line data={data} x="t" y="v" /></Chart>;
// @ts-expect-error a misspelled field must remain a compile error through Line
export const wrong = <Line data={data} x="t" y="missing" />;
`,
  );
  const compilerOptions = {
    target: "ES2022",
    strict: true,
    noEmit: true,
    skipLibCheck: false,
    jsx: "react-jsx",
    types: ["react", "react-dom"],
  };
  const tsDirectory = dirname(require.resolve("typescript/package.json"));
  const tsc = join(tsDirectory, readJSON(join(tsDirectory, "package.json")).bin.tsc);
  for (const resolution of ["nodenext", "bundler"]) {
    await step(
      `Type-check all ${entrypoints.length} entrypoints, public APIs, and field errors (${resolution}, skipLibCheck: false)`,
      () => {
        writeJSON(join(consumer, "tsconfig.json"), {
          compilerOptions: {
            ...compilerOptions,
            module: resolution === "nodenext" ? "NodeNext" : "ESNext",
            moduleResolution: resolution,
          },
          files: ["entrypoints.ts", "api.ts", "types.ts", "types.tsx", ...svelteDeclarations],
        });
        run(process.execPath, [tsc, "-p", "tsconfig.json"], { cwd: consumer });
      },
    );
  }

  await step("Type-check Vue usage when vue-tsc is available offline", () => {
    const tools = join(consumer, "vue-tools");
    mkdirSync(tools);
    writeJSON(join(tools, "package.json"), { private: true });
    // vue-tsc needs the JavaScript compiler API, which TypeScript 7 no longer ships.
    const tsVersion = readJSON(join(root, "packages/svelte/package.json")).devDependencies
      .typescript;
    try {
      run(
        npm,
        [
          "install",
          "--workspaces=false",
          "--offline",
          "--no-audit",
          "--no-fund",
          "vue-tsc",
          `typescript@${tsVersion}`,
        ],
        {
          cwd: tools,
          env,
        },
      );
    } catch (error) {
      console.log(`  SKIPPED: vue-tsc or its dependencies unavailable offline\n${error.message}`);
      return false;
    }
    writeFileSync(
      join(consumer, "App.vue"),
      `<script setup lang="ts">
import { Chart, Line } from "@herceg/vue";
import { table, time } from "herceg";
const data = table({ t: time([0, 1]), v: [1, 2] });
</script>
<template><Chart><Line :data="data" x="t" y="v" /></Chart></template>
`,
    );
    writeJSON(join(consumer, "tsconfig.vue.json"), {
      compilerOptions: { ...compilerOptions, module: "ESNext", moduleResolution: "bundler" },
      vueCompilerOptions: { strictTemplates: true },
      files: ["App.vue"],
    });
    const vueRequire = createRequire(join(tools, "package.json"));
    const vueDirectory = dirname(vueRequire.resolve("vue-tsc/package.json"));
    const vueTsc = join(vueDirectory, readJSON(join(vueDirectory, "package.json")).bin["vue-tsc"]);
    run(process.execPath, [vueTsc, "-p", "tsconfig.vue.json"], { cwd: consumer });
  });

  function checkInput(input) {
    if (input.startsWith("\0")) return;
    const file = input.split("?")[0];
    // Bundlers also report virtual modules. Check every real filesystem input,
    // including dependencies outside Herceg and symlinks out of the consumer.
    if (!isAbsolute(file) && !existsSync(resolve(consumer, file))) return;
    const path = relative(consumer, realpathSync(resolve(consumer, file)));
    assert(!path.startsWith("..") && !isAbsolute(path), `Input outside consumer: ${input}`);
    const normalized = path.replaceAll("\\", "/");
    assert(!unwanted.test(normalized), `Test/bench/tmp code bundled: ${input}`);
  }
  const dataSource = "const data = table({ x: [1, 2, 3], y: [3, 1, 2] });";
  const apps = {
    herceg: `import { table, line, renderToSVG } from "herceg";
${dataSource}
document.body.innerHTML = renderToSVG({ marks: [line(data, { x: "x", y: "y" })] });`,
    react: `import { createRoot } from "react-dom/client";
import { Chart, Line } from "@herceg/react";
import { table } from "herceg";
${dataSource}
createRoot(document.body).render(<Chart><Line data={data} x="x" y="y" /></Chart>);`,
    vue: `import { createApp, h } from "vue";
import { Chart, Line } from "@herceg/vue";
import { table } from "herceg";
${dataSource}
createApp({ render: () => h(Chart, {}, { default: () => h(Line, { data, x: "x", y: "y" }) }) }).mount(document.body);`,
  };
  for (const [name, source] of Object.entries(apps)) {
    await step(`Bundle the installed ${name} consumer with workspace esbuild`, async () => {
      const entry = join(consumer, `${name}.${name === "react" ? "tsx" : "js"}`);
      writeFileSync(entry, source);
      const result = await esbuild.build({
        absWorkingDir: consumer,
        entryPoints: [entry],
        bundle: true,
        format: "esm",
        platform: "browser",
        jsx: "automatic",
        metafile: true,
        write: false,
        outfile: join(consumer, "dist", `${name}.js`),
      });
      for (const input of Object.keys(result.metafile.inputs)) checkInput(resolve(consumer, input));
      assert(
        result.outputFiles.some((file) => file.contents.length > 0),
        `${name}: no bundle output`,
      );
      for (const file of result.outputFiles) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.contents);
      }
    });
  }

  await step("Bundle every Svelte subpath with workspace Vite and its Svelte plugin", async () => {
    const { build } = await import("vite");
    const { svelte } = await import(
      pathToFileURL(svelteRequire.resolve("@sveltejs/vite-plugin-svelte")).href
    );
    const app = join(consumer, "svelte-app");
    mkdirSync(app);
    writeFileSync(
      join(app, "index.html"),
      '<div id="app"></div><script type="module" src="/main.js"></script>',
    );
    const sveltePaths = subpaths(
      packed.find(({ manifest }) => manifest.name === "@herceg/svelte").manifest,
    );
    writeFileSync(
      join(app, "main.js"),
      `import { mount } from "svelte";
import App from "./App.svelte";
mount(App, { target: document.getElementById("app") });
${sveltePaths.map((path, i) => `import * as subpath${i} from ${JSON.stringify(path)};\nconsole.log(subpath${i});`).join("\n")}
`,
    );
    writeFileSync(
      join(app, "App.svelte"),
      `<script>
import { Chart, Line } from "@herceg/svelte";
import { table } from "herceg";
${dataSource}
</script>
<Chart><Line {data} x="x" y="y" /></Chart>
`,
    );
    await build({
      root: app,
      configFile: false,
      logLevel: "warn",
      plugins: [
        svelte({ configFile: false }),
        {
          name: "check-package-inputs",
          generateBundle(_options, bundle) {
            for (const input of this.getModuleIds()) {
              checkInput(input);
            }
            assert(
              Object.values(bundle).some((file) => file.type === "chunk" && file.code.length > 0),
              "Svelte: no bundle output",
            );
          },
        },
      ],
      // Importing every subpath keeps the whole engine, so the default chunk warning is noise.
      build: {
        outDir: join(consumer, "dist", "svelte"),
        emptyOutDir: true,
        chunkSizeWarningLimit: 4096,
      },
    });
  });
});
