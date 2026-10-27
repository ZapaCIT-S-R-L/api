// ESLint flat config: recommended + type-aware rules for the Worker (src/) and tests, plain JS for scripts/.
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", ".wrangler/", "worker-configuration.d.ts"] },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: { project: ["tsconfig.json", "tsconfig.node.json"], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // `_name` marks a parameter kept for the signature.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["scripts/**/*.js", "test/scripts/**/*.js", "eslint.config.js"],
    languageOptions: { globals: globals.node },
  },
);
