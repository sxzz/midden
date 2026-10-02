import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
const require = createRequire(import.meta.url)
const vueRequire = createRequire(require.resolve('vue/package.json'))
// Vapor is only shipped in the bundler runtime. Keep one reactive runtime in tests.
const testAliases = Object.fromEntries(
  [
    'vue',
    '@vue/runtime-dom',
    '@vue/runtime-core',
    '@vue/runtime-vapor',
    '@vue/reactivity',
    '@vue/shared',
  ].map((name) => [
    name,
    name === 'vue'
      ? require.resolve('vue/dist/vue.runtime.esm-bundler.js')
      : vueRequire.resolve(
          `${name}/dist/${name.split('/', 2)[1]}.esm-bundler.js`,
        ),
  ]),
)
// Matches the bot's buildinfo.Version: the commit, marked dirty when the
// checkout has local changes, or "dev" outside a git checkout.
function buildVersion() {
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  try {
    const revision = git('rev-parse', 'HEAD')
    return git('status', '--porcelain') ? `${revision}-dirty` : revision
  } catch {
    return 'dev'
  }
}
export default defineConfig({
  base: '/app/',
  plugins: [vue()],
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    __BUILD_VERSION__: JSON.stringify(buildVersion()),
  },
  server: { proxy: { '/v1': 'http://127.0.0.1:8080' } },
  test: {
    alias: testAliases,
    server: { deps: { inline: ['vue-router'] } },
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
