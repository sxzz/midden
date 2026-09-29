#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from "node:fs/promises";

// Workers routes preserve /app/ in the request path.
const target = new URL("../web/.worker-assets/", import.meta.url);
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(new URL("../web/dist/", import.meta.url), new URL("app/", target), {
  recursive: true,
});
await writeFile(
  new URL("_headers", target),
  `/app/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Cache-Control: no-cache
  Content-Security-Policy: default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' https://web.telegram.org
`,
);
