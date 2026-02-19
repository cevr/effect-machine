import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src-v3/**/*.ts"],
  format: "esm",
  dts: true,
  clean: true,
  unbundle: true,
  platform: "neutral",
  target: "esnext",
  outDir: "dist-v3",
});
