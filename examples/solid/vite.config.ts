import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: [
      {
        find: "effect-machine/atom",
        replacement: new URL("../../src/atom.ts", import.meta.url).pathname,
      },
      {
        find: "effect-machine",
        replacement: new URL("../../src/index.ts", import.meta.url).pathname,
      },
    ],
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.perf.tsx"],
  },
});
