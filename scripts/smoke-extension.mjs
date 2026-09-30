import Module from "node:module";

const load = Module._load;
Module._load = (request, parent, isMain) =>
  request === "vscode" ? {} : load(request, parent, isMain);
try {
  await import(new URL("../dist/extension.cjs", import.meta.url).href);
} finally {
  Module._load = load;
}
