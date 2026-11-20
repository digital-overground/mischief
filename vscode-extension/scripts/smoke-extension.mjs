import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module from "node:module";

const theme = await readFile(new URL("../media/theme.css", import.meta.url));
assert.deepEqual(
  theme,
  await readFile(new URL("../../shared/theme/tokens.css", import.meta.url))
);
await Promise.all(
  [
    "IBMPlexSans-Regular.woff2",
    "IBMPlexSans-SemiBold.woff2",
    "Lilex-Regular.woff2",
  ].map(async (name) => {
    const [packaged, source] = await Promise.all([
      readFile(new URL(`../media/fonts/${name}`, import.meta.url)),
      readFile(new URL(`../../shared/theme/fonts/${name}`, import.meta.url)),
    ]);
    assert.deepEqual(packaged, source);
  })
);

const load = Module._load;
Module._load = (request, parent, isMain) =>
  request === "vscode" ? {} : load(request, parent, isMain);
try {
  await import(new URL("../dist/extension.cjs", import.meta.url).href);
} finally {
  Module._load = load;
}
