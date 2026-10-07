import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  globalIgnores(["node_modules/**", "src/generated/**"]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
]);
