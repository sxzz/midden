#!/usr/bin/env node
// Install deploy-webhook.ts as a service, copied outside the checkout that
// deployments switch between revisions: a LaunchAgent on macOS, a systemd
// unit on Linux (a system unit as root, a user unit otherwise). The GitHub
// webhook (workflow runs, to https://<API host>/hooks/deploy) and the tunnel
// route to the port are configured separately.
//
//   node scripts/install-deploy-webhook.ts [--dir <checkout>] [--port 18090] [--print]
/* eslint-disable unicorn/no-exports-in-scripts -- for install-deploy-webhook.test.ts */
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { deploymentDir, type Run } from './deploy.ts'

const LABEL = 'org.midden.deploy-webhook'
const UNIT = 'midden-deploy-webhook.service'

/** Where the service is installed, and as whom. */
export interface Target {
  platform: NodeJS.Platform
  uid: number
  home: string
  /** XDG_CONFIG_HOME, for a systemd user unit. */
  configHome?: string
}

/** What the service runs. */
export interface Setup {
  /** The deployment checkout. */
  dir: string
  port: string
  /** The Node binary, process.execPath of the installer. */
  node: string
  /** The installed copy of deploy-webhook.ts. */
  script: string
  PATH: string
}

export type Service =
  | { manager: 'launchd'; file: string; content: string; domain: string }
  | { manager: 'systemd'; file: string; content: string; user: boolean }

/** stdout and stderr of the service; deployments log beside them. */
export function logDir(dir: string): string {
  return path.join(dir, '.local', 'deploy-webhook')
}

function environment(setup: Setup): Record<string, string> {
  return {
    MIDDEN_DIR: setup.dir,
    DEPLOY_WEBHOOK_PORT: setup.port,
    PATH: setup.PATH,
  }
}

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

export function launchdPlist(setup: Setup): string {
  const logs = logDir(setup.dir)
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${xml(setup.node)}</string><string>${xml(setup.script)}</string></array>
<key>EnvironmentVariables</key><dict>${Object.entries(environment(setup))
    .map(([key, value]) => `<key>${key}</key><string>${xml(value)}</string>`)
    .join('')}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${xml(setup.dir)}</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'stderr.log'))}</string>
</dict></plist>
`
}

// systemd expands % specifiers in most settings, and $ in ExecStart.
const specifiers = (value: string) => value.replaceAll('%', '%%')
const quoted = (value: string) =>
  `"${specifiers(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('"', String.raw`\"`)}"`

/**
 * The unit runs the copy with this Node and appends to the same log files
 * as the LaunchAgent. A system unit gets HOME, which systemd sets only for
 * units with a User=: git and docker read their configuration from it. A
 * user manager cannot order itself after system units such as Docker.
 */
export function systemdUnit(
  setup: Setup,
  { user, home }: { user: boolean; home: string },
): string {
  const logs = logDir(setup.dir)
  const env = user ? environment(setup) : { ...environment(setup), HOME: home }
  return `# Written by scripts/install-deploy-webhook.ts; run it again instead of editing.
[Unit]
Description=midden deploy webhook
${user ? '' : 'Wants=network-online.target docker.service\nAfter=network-online.target docker.service\n'}
[Service]
ExecStart=${[setup.node, setup.script].map((arg) => quoted(arg).replaceAll('$', '$$$$')).join(' ')}
WorkingDirectory=${specifiers(setup.dir)}
${Object.entries(env)
  .map(([key, value]) => `Environment=${quoted(`${key}=${value}`)}`)
  .join('\n')}
Restart=always
RestartSec=10
StandardOutput=append:${specifiers(path.join(logs, 'stdout.log'))}
StandardError=append:${specifiers(path.join(logs, 'stderr.log'))}

[Install]
WantedBy=${user ? 'default.target' : 'multi-user.target'}
`
}

/** The service definition for this platform and user. */
export function service(target: Target, setup: Setup): Service {
  if (target.platform === 'darwin')
    return {
      manager: 'launchd',
      file: path.join(target.home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
      content: launchdPlist(setup),
      domain: `gui/${target.uid}`,
    }
  if (target.platform === 'linux') {
    const user = target.uid !== 0
    return {
      manager: 'systemd',
      file: user
        ? path.join(
            target.configHome || path.join(target.home, '.config'),
            'systemd',
            'user',
            UNIT,
          )
        : path.join('/etc/systemd/system', UNIT),
      content: systemdUnit(setup, { user, home: target.home }),
      user,
    }
  }
  throw new Error(`no service manager for ${target.platform}`)
}

/** Load the written definition and (re)start the service. */
export function activate(definition: Service, run: Run): void {
  if (definition.manager === 'launchd') {
    try {
      run('launchctl', ['bootout', `${definition.domain}/${LABEL}`])
    } catch {}
    run('launchctl', ['bootstrap', definition.domain, definition.file])
    return
  }
  const systemctl = (...args: string[]) =>
    run('systemctl', [...(definition.user ? ['--user'] : []), ...args])
  systemctl('daemon-reload')
  systemctl('enable', UNIT)
  // Restart, not start: a reinstall must pick up the new copy.
  systemctl('restart', UNIT)
}

/** The name the service manager knows it by. */
export function serviceName(definition: Service): string {
  return definition.manager === 'launchd' ? LABEL : UNIT
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dir: { type: 'string', default: deploymentDir() },
      port: { type: 'string', default: '18090' },
      print: { type: 'boolean', default: false },
    },
  })
  const dir = path.resolve(values.dir)
  if (!existsSync(path.join(dir, 'compose.yaml')))
    throw new Error(`${dir} is not a deployment checkout`)

  const which = (name: string) => {
    try {
      return path.dirname(
        execFileSync('which', [name], { encoding: 'utf8' }).trim(),
      )
    } catch {
      throw new Error(`${name} is not on PATH; deployments need it`)
    }
  }
  const home = homedir()
  const installed = path.join(home, '.local', 'share', 'midden')
  const setup: Setup = {
    dir,
    port: values.port,
    node: process.execPath,
    script: path.join(installed, 'deploy-webhook.ts'),
    // Deployments call these; git also runs credential helpers written for
    // node.
    PATH: [
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
    ].join(':'),
  }
  const definition = service(
    {
      platform: process.platform,
      uid: process.getuid!(),
      home,
      configHome: process.env.XDG_CONFIG_HOME,
    },
    setup,
  )

  if (values.print) {
    process.stdout.write(definition.content)
  } else {
    mkdirSync(installed, { recursive: true })
    mkdirSync(logDir(dir), { recursive: true, mode: 0o700 })
    copyFileSync(
      fileURLToPath(new URL('deploy-webhook.ts', import.meta.url)),
      setup.script,
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
    mkdirSync(path.dirname(definition.file), { recursive: true })
    writeFileSync(definition.file, definition.content)
    activate(definition, (command, args) =>
      execFileSync(command, args, {
        encoding: 'utf8',
        // A failure carries stderr in its message; bootout of a service
        // that is not loaded is expected and stays quiet.
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim(),
    )
    console.info(
      `Installed ${serviceName(definition)} (${definition.file}): ${setup.script}, listening on 127.0.0.1:${values.port}`,
    )
    if (definition.manager === 'systemd' && definition.user)
      console.info(
        'A user unit runs only while you are logged in, unless lingering is on: loginctl enable-linger',
      )
  }
}
