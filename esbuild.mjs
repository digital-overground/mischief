import esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const context = await esbuild.context({
  bundle: true,
  entryPoints: ["src/extension.ts"],
  external: ["vscode"],
  format: "cjs",
  minify: !watch,
  outfile: "dist/extension.cjs",
  platform: "node",
  sourcemap: true,
  target: "node20",
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
