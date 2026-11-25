#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'

// Originals and videos come from the R2 bucket's public domain.
const MEDIA = 'https://midden-media.sxzz.moe'

// Workers routes preserve /app/ in the request path.
const target = new URL('../web/.worker-assets/', import.meta.url)
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(new URL('../web/dist/', import.meta.url), new URL('app/', target), {
  recursive: true,
})
await writeFile(
  new URL('_headers', target),
  `/app/*
  X-Content-Type-Options: nosniff
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
  Cache-Control: no-cache
  Content-Security-Policy: default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://pbs.twimg.com ${MEDIA}; media-src 'self' ${MEDIA}; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' https://web.telegram.org
`,
)
