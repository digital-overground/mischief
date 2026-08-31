import Module from "node:module";

const load = Module._load;
Module._load = (request, parent, isMain) =>
  request === "vscode" ? {} : load(request, parent, isMain);
try {
  await import("../dist/extension.cjs");
} finally {
  Module._load = load;
}
