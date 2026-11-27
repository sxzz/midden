import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import {
  PROFILE_PATH,
  PROFILE_TYPE,
  webClipProfile,
} from '../scripts/web-clip.ts'
import type { Plugin } from 'vite'
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
// The agent API's guide, served by the web app as /agent.md: an agent is
// pointed at it, and at the API's own address separately.
const AGENT_DOC = new URL('../docs/agent.md', import.meta.url)
function agentDoc(): Plugin {
  return {
    name: 'midden:agent-doc',
    configureServer(server) {
      server.middlewares.use('/agent.md', (_req, res) => {
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8')
        res.end(readFileSync(AGENT_DOC))
      })
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'agent.md',
        source: readFileSync(AGENT_DOC, 'utf8'),
      })
    },
  }
}
// iOS's home screen profile (scripts/web-clip.ts), for the address the dev
// server is opened at, so 添加到桌面 can be tried from a phone. The deploy
// writes its own for the web app's host (scripts/prepare-web-assets.ts).
function webClip(): Plugin {
  return {
    name: 'midden:web-clip',
    configureServer(server) {
      server.middlewares.use(PROFILE_PATH, (req, res) => {
        const proto =
          req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'
        res.setHeader('Content-Type', PROFILE_TYPE)
        res.end(webClipProfile(`${proto}://${req.headers.host}`))
      })
    },
  }
}

export default defineConfig({
  plugins: [vue(), agentDoc(), webClip()],
  optimizeDeps: {
    // The dev server's scan starts from index.html and never reaches a
    // worker's imports. Found later, they make Vite re-bundle and reload
    // every open page, which in e2e lands in the middle of other tests.
    entries: ['index.html', 'src/**/*.worker.ts'],
  },
  define: {
    __VUE_OPTIONS_API__: false,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
    __BUILD_VERSION__: JSON.stringify(buildVersion()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:8080',
      '/media': 'http://127.0.0.1:8080',
    },
  },
  test: {
    alias: testAliases,
    server: { deps: { inline: ['vue-router'] } },
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
})
