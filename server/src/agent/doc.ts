import { readFileSync } from 'node:fs'
import { Hono } from 'hono'

/**
 * The agent API's guide, `docs/agent.md` in the repository; the image keeps
 * it at the same place relative to the server (Dockerfile).
 */
export const AGENT_DOC = new URL('../../../docs/agent.md', import.meta.url)

/**
 * `/agent.md`, public: it holds no data, only how to use the API, so an
 * agent can read it before it has a token.
 */
export function agentDocRoutes(file: URL = AGENT_DOC) {
  let text: string | undefined
  return new Hono().get('/agent.md', (c) => {
    text ??= readFileSync(file, 'utf8')
    c.header('Content-Type', 'text/markdown; charset=utf-8')
    c.header('Cache-Control', 'no-cache')
    return c.body(text)
  })
}
