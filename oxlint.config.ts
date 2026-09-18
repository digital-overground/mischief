import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  extends: [core, vitest],
  ignorePatterns: core.ignorePatterns,
  options: {
    typeAware: true,
  },
  overrides: [
    {
      files: ["**/*.test.ts", "**/*.test.tsx"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/no-unsafe-type-assertion": "off",
        "typescript/strict-boolean-expressions": "off",
        "typescript/strict-void-return": "off",
        "typescript/unbound-method": "off",
      },
    },
    {
      files: ["**/*.mjs"],
      rules: {
        "typescript/no-unsafe-assignment": "off",
        "typescript/no-unsafe-call": "off",
        "typescript/no-unsafe-member-access": "off",
        "typescript/no-unsafe-return": "off",
        "typescript/strict-boolean-expressions": "off",
      },
    },
  ],
  rules: {
    "require-await": "off",
    "typescript/await-thenable": "off",
    "typescript/consistent-return": "off",
    "typescript/no-base-to-string": "off",
    "typescript/no-confusing-void-expression": "off",
    "typescript/no-deprecated": "off",
    "typescript/no-misused-spread": "off",
    "typescript/no-non-null-assertion": "off",
    "typescript/no-unsafe-assignment": "off",
    "typescript/no-unsafe-call": "off",
    "typescript/no-unsafe-member-access": "off",
    "typescript/no-unsafe-return": "off",
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/prefer-nullish-coalescing": "off",
    "typescript/promise-function-async": "off",
    "typescript/return-await": "off",
    "typescript/strict-boolean-expressions": "off",
    "typescript/strict-void-return": "off",
    "typescript/unbound-method": "off",
  },
});
