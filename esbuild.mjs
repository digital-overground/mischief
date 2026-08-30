import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const contexts = await Promise.all([
  esbuild.context({
    bundle: true,
    entryPoints: ["src/extension.ts"],
    external: ["vscode"],
    format: "cjs",
    minify: !watch,
    outfile: "dist/extension.cjs",
    platform: "node",
    sourcemap: true,
    target: "node20",
  }),
  esbuild.context({
    bundle: true,
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        watch ? "development" : "production"
      ),
    },
    entryPoints: ["src/webview/index.tsx"],
    format: "iife",
    minify: !watch,
    outfile: "dist/webview.js",
    platform: "browser",
    sourcemap: true,
    target: "es2022",
  }),
]);

if (watch) {
  await Promise.all(contexts.map((context) => context.watch()));
} else {
  await Promise.all(contexts.map((context) => context.rebuild()));
  await Promise.all(contexts.map((context) => context.dispose()));
}
