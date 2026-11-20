import "node:module";

declare module "node:module" {
  namespace Module {
    let _load: (request: string, parent: unknown, isMain: boolean) => unknown;
  }
}
