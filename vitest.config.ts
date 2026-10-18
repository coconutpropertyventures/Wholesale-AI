import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Mirror the "@/*" path alias from tsconfig.json so tests can import
// lib modules that use it internally.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
  test: {
    env: {
      // The store must never reach for Postgres in tests: an empty
      // DATABASE_URL forces the JSON-file backend even if the surrounding
      // shell has one exported.
      DATABASE_URL: "",
    },
  },
});
