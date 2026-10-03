// @ts-check
import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// 04 §4 / 01 §4.6: data reaches the DOM through text nodes only. These sinks parse strings as
// HTML (or code), so they're banned everywhere, not just in the viewer. `no-restricted-syntax`
// is configured only here; a later override of that rule must keep these selectors.
const HTML_PROPERTIES = "/^(innerHTML|outerHTML|srcdoc)$/";
const HTML_METHODS = "/^(insertAdjacentHTML|createContextualFragment|setHTMLUnsafe|parseHTMLUnsafe)$/";
const htmlSinkMessage = "HTML string sinks are banned (04 §4). Build DOM with text nodes.";

const htmlSinkSelectors = [
  {
    selector: `MemberExpression[computed=false][property.name=${HTML_PROPERTIES}]`,
    message: htmlSinkMessage,
  },
  {
    selector: `MemberExpression[computed=true][property.value=${HTML_PROPERTIES}]`,
    message: htmlSinkMessage,
  },
  {
    selector: `ObjectPattern > Property[key.name=${HTML_PROPERTIES}]`,
    message: htmlSinkMessage,
  },
  {
    selector: `CallExpression[callee.property.name=${HTML_METHODS}]`,
    message: htmlSinkMessage,
  },
  {
    selector: "CallExpression[callee.object.name='document'][callee.property.name=/^(write|writeln)$/]",
    message: htmlSinkMessage,
  },
];

export default defineConfig(
  globalIgnores([
    "node_modules/",
    "coverage/",
    "dist/",
    ".tools/",
    ".reference/",
    // Generated static validators are checked by reproducibility and fixture-equivalence tests.
    "packages/schemas/src/generated/viewer-validators.js",
    // Deliberately bad lint fixtures; tools/eslint-smoke.test.ts lints them with `ignore: false`.
    "testdata/",
  ]),
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-restricted-syntax": ["error", ...htmlSinkSelectors],
      "no-eval": "error",
      "no-new-func": "error",
      "@typescript-eslint/no-implied-eval": "error",
    },
  },
);
