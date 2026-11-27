#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises'
import process from 'node:process'
import { PROFILE_PATH, PROFILE_TYPE, webClipProfile } from './web-clip.ts'

// Originals and videos come from the R2 bucket's public domain, the same
// as the server's MEDIA_PUBLIC_URL. It belongs to the deployment, so the
// build must be given it.
const mediaUrl = process.env.MIDDEN_MEDIA_URL
if (!mediaUrl) {
  throw new Error(
    "MIDDEN_MEDIA_URL is not set: the origin of the R2 bucket's public domain (https://media.example.com), allowed in the web app's CSP",
  )
}
const MEDIA = new URL(mediaUrl).origin
// The API the build calls (`VITE_API_URL`, web/src/api.ts): its JSON, and
// the thumbnails and downloads it signs. Empty when it is this origin.
const API = process.env.VITE_API_URL
  ? new URL(process.env.VITE_API_URL).origin
  : ''

// The web app's own host (midden.example.com), which iOS's home screen
// profile opens (web-clip.ts). The deploy routes the Worker to it too.
function webOrigin() {
  const hostname = process.env.MIDDEN_WEB_HOSTNAME
  if (!hostname) {
    throw new Error(
      "MIDDEN_WEB_HOSTNAME is not set: the web app's host (midden.example.com), opened by the iOS home screen profile",
    )
  }
  return `https://${hostname}`
}
const ORIGIN = webOrigin()

const target = new URL('../web/.worker-assets/', import.meta.url)
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
// The app's addresses are plain paths at the root (/settings/admin): any
// that is no file gets the app, which Cloudflare's single-page-application
// handling (wrangler.json) serves from index.html.
await cp(new URL('../web/dist/', import.meta.url), target, { recursive: true })
const sources = (...extra: string[]) =>
  [...extra, API].filter(Boolean).join(' ')
const headers = `  X-Content-Type-Options: nosniff
  X-Robots-Tag: noindex, nofollow
  Referrer-Policy: no-referrer
  Cache-Control: no-cache
  Content-Security-Policy: default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src ${sources("'self'", 'data:', 'https://pbs.twimg.com', MEDIA)}; media-src ${sources("'self'", MEDIA)}; connect-src ${sources("'self'")}; manifest-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' https://web.telegram.org
`
await writeFile(new URL(PROFILE_PATH.slice(1), target), webClipProfile(ORIGIN))
// Safari offers to install a profile only when it comes as one, a type
// Wrangler need not know the extension of.
await writeFile(
  new URL('_headers', target),
  `/*\n${headers}${PROFILE_PATH}\n  Content-Type: ${PROFILE_TYPE}\n`,
)
// The app was under /app/ before: shared links, bot messages and bookmarks
// move to the same path at the root, for good. The API's old paths on this
// host are not redirected: a client drops its token on a redirect to
// another origin, so they must be changed where they are called.
await writeFile(
  new URL('_redirects', target),
  '/app / 301\n/app/* /:splat 301\n',
)
