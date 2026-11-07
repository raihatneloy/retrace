import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [{ find: /^@\//, replacement: path.resolve(dir, "src") + "/" }],
  },
  test: {
    // The conversion logic is pure and must stay that way: if a test ever needs
    // a DOM, something browser-only has leaked into the wrong module.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
