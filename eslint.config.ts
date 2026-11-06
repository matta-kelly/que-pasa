import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores(["**/node_modules", "dist"]),
  {
    files: ["**/*.ts"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: globals.node },
  },
  tseslint.configs.recommended,
  // Code that is not used is deleted, not commented out: git keeps the history.
  {
    files: ["**/*.ts"],
    plugins: { sonarjs },
    rules: { "sonarjs/no-commented-code": "error" },
  },
  // `in` also finds the names of the object prototype, so a field named `constructor` is found where there is none.
  {
    files: ["**/*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "BinaryExpression[operator='in']",
          message:
            "Use Object.hasOwn: `in` also finds the object prototype's names.",
        },
      ],
    },
  },
]);
