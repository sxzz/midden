import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const app = new Hono()
app.get('/healthz', (c) => c.text('ok'))

serve({ fetch: app.fetch, port: 8080, hostname: '0.0.0.0' })
