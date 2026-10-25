import * as esbuild from "esbuild";
import { mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const production = !watch && process.env.NODE_ENV !== "development";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "debug",
};

const extension = {
  ...common,
  entryPoints: ["src/extension/extension.ts"],
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
};

const webview = {
  ...common,
  entryPoints: ["src/webview/index.tsx"],
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  loader: { ".svg": "text" },
};

const assets = {
  ...common,
  entryPoints: ["src/webview/style.css"],
  outfile: "dist/webview.css",
};

if (watch) {
  const contexts = await Promise.all([
    esbuild.context(extension),
    esbuild.context(webview),
    esbuild.context(assets),
  ]);
  await Promise.all(contexts.map((context) => context.watch()));
  console.log("DBV build is watching for changes…");
} else {
  await Promise.all([
    esbuild.build(extension),
    esbuild.build(webview),
    esbuild.build(assets),
  ]);
}
