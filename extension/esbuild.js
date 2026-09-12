// Bundles two independent targets:
//   1. src/extension.ts   -> dist/extension.js   (Node, runs in the extension host, 'vscode' external)
//   2. media/main.ts      -> dist/webview/main.js (+ main.css) (browser, runs inside the webview)
// A single script (not two npm scripts) so both stay in sync under one --watch/--production flag.
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

const common = {
  bundle: true,
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

async function build() {
  const extensionCtx = await esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.js",
    platform: "node",
    format: "cjs",
    external: ["vscode"],
  });

  const webviewCtx = await esbuild.context({
    ...common,
    entryPoints: ["media/main.ts"],
    outdir: "dist/webview",
    entryNames: "[name]",
    platform: "browser",
    format: "iife",
    loader: { ".ttf": "file" },
  });

  if (watch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
