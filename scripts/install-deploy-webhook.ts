#!/usr/bin/env node
// Install deploy-webhook.ts as a macOS LaunchAgent, copied outside the
// checkout that deployments switch between revisions. The GitHub webhook
// (workflow runs, to https://<host>/hooks/deploy) and the tunnel route to the
// port are configured separately.
//
//   node scripts/install-deploy-webhook.ts [--dir ~/midden] [--port 18090] [--print]
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: path.join(homedir(), 'midden') },
    port: { type: 'string', default: '18090' },
    print: { type: 'boolean', default: false },
  },
})
const dir = path.resolve(values.dir)
if (!existsSync(path.join(dir, 'compose.yaml')))
  throw new Error(`${dir} is not a deployment checkout`)

const LABEL = 'org.midden.deploy-webhook'

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const which = (name: string) =>
  path.dirname(execFileSync('which', [name], { encoding: 'utf8' }).trim())

// Deployments call these; git also runs credential helpers written for node.
const PATH = [
  ...new Set([
    path.dirname(process.execPath),
    which('docker'),
    which('git'),
    which('curl'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]),
].join(':')

const installed = path.join(homedir(), '.local', 'share', 'midden')
const script = path.join(installed, 'deploy-webhook.ts')
const logs = path.join(dir, '.local', 'deploy-webhook')
const env: Record<string, string> = {
  MIDDEN_DIR: dir,
  DEPLOY_WEBHOOK_PORT: values.port,
  PATH,
}
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(script)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(env)
  .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
  .join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${xml(dir)}</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'stderr.log'))}</string>
</dict></plist>
`

if (values.print) {
  process.stdout.write(plist)
} else {
  mkdirSync(installed, { recursive: true })
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  copyFileSync(
    fileURLToPath(new URL('deploy-webhook.ts', import.meta.url)),
    script,
  )
  const secret = path.join(dir, '.local', 'deploy-webhook.secret')
  if (!existsSync(secret)) {
    writeFileSync(secret, `${randomBytes(32).toString('hex')}\n`, {
      mode: 0o600,
    })
    console.info(
      `Created ${secret}; use it as the GitHub webhook secret (content type application/json, workflow runs).`,
    )
  }
  const file = path.join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`)
  writeFileSync(file, plist)
  const domain = `gui/${process.getuid!()}`
  try {
    execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], {
      stdio: 'ignore',
    })
  } catch {}
  execFileSync('launchctl', ['bootstrap', domain, file])
  console.info(
    `Installed ${LABEL}: ${script}, listening on 127.0.0.1:${values.port}`,
  )
}
