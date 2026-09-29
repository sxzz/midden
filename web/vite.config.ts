import { defineConfig } from "vitest/config";
import vue from "@vitejs/plugin-vue";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const vueRequire = createRequire(require.resolve("vue/package.json"));
// Vapor is only shipped in the bundler runtime. Keep one reactive runtime in tests.
const testAliases = Object.fromEntries(
  [
    "vue",
    "@vue/runtime-dom",
    "@vue/runtime-core",
    "@vue/runtime-vapor",
    "@vue/reactivity",
    "@vue/shared",
  ].map((name) => [
    name,
    name === "vue"
      ? require.resolve("vue/dist/vue.runtime.esm-bundler.js")
      : vueRequire.resolve(`${name}/dist/${name.split("/")[1]}.esm-bundler.js`),
  ]),
);
export default defineConfig({
  base: "/app/",
  plugins: [vue()],
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  server: { proxy: { "/v1": "http://127.0.0.1:8080" } },
  test: {
    alias: testAliases,
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
  },
});
