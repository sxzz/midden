import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { deploymentDir, type Run } from './deploy.ts'
import {
  activate,
  service,
  systemdUnit,
  type Service,
  type Setup,
} from './install-deploy-webhook.ts'

const SETUP: Setup = {
  dir: '/opt/midden',
  port: '18090',
  node: '/usr/local/bin/node',
  script: '/root/.local/share/midden/deploy-webhook.ts',
  PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
}

/** A run that records its calls; `fail` makes a call throw. */
function recorder(fail: (call: string) => boolean = () => false) {
  const calls: string[] = []
  const run: Run = (command, args) => {
    const call = [command, ...args].join(' ')
    calls.push(call)
    if (fail(call)) throw new Error(`${call} failed`)
    return ''
  }
  return { calls, run }
}

describe('service', () => {
  test('macOS gets the LaunchAgent in the gui domain', () => {
    const definition = service(
      { platform: 'darwin', uid: 501, home: '/Users/me' },
      { ...SETUP, dir: '/Users/me/midden' },
    )
    assert.equal(definition.manager, 'launchd')
    assert.equal(
      definition.file,
      '/Users/me/Library/LaunchAgents/org.midden.deploy-webhook.plist',
    )
    assert.equal(
      definition.manager === 'launchd' && definition.domain,
      'gui/501',
    )
    assert.match(
      definition.content,
      /<key>StandardErrorPath<\/key><string>\/Users\/me\/midden\/\.local\/deploy-webhook\/stderr\.log</,
    )
    assert.match(
      definition.content,
      /<key>MIDDEN_DIR<\/key><string>\/Users\/me\/midden</,
    )
  })

  test('root on Linux gets a system unit', () => {
    const definition = service(
      { platform: 'linux', uid: 0, home: '/root' },
      SETUP,
    )
    assert.deepEqual(
      { manager: definition.manager, file: definition.file },
      {
        manager: 'systemd',
        file: '/etc/systemd/system/midden-deploy-webhook.service',
      },
    )
    assert.equal(definition.manager === 'systemd' && definition.user, false)
  })

  test('another Linux user gets a user unit, under XDG_CONFIG_HOME if set', () => {
    const target = { platform: 'linux', uid: 1000, home: '/home/me' } as const
    const definition = service(target, SETUP)
    assert.equal(
      definition.file,
      '/home/me/.config/systemd/user/midden-deploy-webhook.service',
    )
    assert.equal(definition.manager === 'systemd' && definition.user, true)
    assert.equal(
      service({ ...target, configHome: '/home/me/conf' }, SETUP).file,
      '/home/me/conf/systemd/user/midden-deploy-webhook.service',
    )
  })

  test('other platforms are refused', () => {
    assert.throws(
      () => service({ platform: 'win32', uid: 0, home: 'C:\\' }, SETUP),
      /no service manager for win32/,
    )
  })
})

describe('systemdUnit', () => {
  test('a system unit runs the copy after Docker and the network', () => {
    assert.equal(
      systemdUnit(SETUP, { user: false, home: '/root' }),
      `# Written by scripts/install-deploy-webhook.ts; run it again instead of editing.
[Unit]
Description=midden deploy webhook
Wants=network-online.target docker.service
After=network-online.target docker.service

[Service]
ExecStart="/usr/local/bin/node" "/root/.local/share/midden/deploy-webhook.ts"
WorkingDirectory=/opt/midden
Environment="MIDDEN_DIR=/opt/midden"
Environment="DEPLOY_WEBHOOK_PORT=18090"
Environment="PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
Environment="HOME=/root"
Restart=always
RestartSec=10
StandardOutput=append:/opt/midden/.local/deploy-webhook/stdout.log
StandardError=append:/opt/midden/.local/deploy-webhook/stderr.log

[Install]
WantedBy=multi-user.target
`,
    )
  })

  test('a user unit has no system dependencies and no HOME', () => {
    const unit = systemdUnit(SETUP, { user: true, home: '/home/me' })
    assert.doesNotMatch(unit, /docker\.service|network-online|HOME=/)
    assert.match(unit, /^Description=midden deploy webhook\n\n\[Service\]$/m)
    assert.match(unit, /^WantedBy=default\.target$/m)
  })

  test('escapes specifiers, quotes and $', () => {
    const unit = systemdUnit(
      {
        ...SETUP,
        dir: '/srv/100%',
        script: '/srv/a "b"/$x.ts',
      },
      { user: false, home: '/root' },
    )
    assert.match(
      unit,
      /^ExecStart="\/usr\/local\/bin\/node" "\/srv\/a \\"b\\"\/\$\$x\.ts"$/m,
    )
    assert.match(unit, /^WorkingDirectory=\/srv\/100%%$/m)
    assert.match(unit, /^Environment="MIDDEN_DIR=\/srv\/100%%"$/m)
    assert.match(
      unit,
      /^StandardOutput=append:\/srv\/100%%\/\.local\/deploy-webhook\/stdout\.log$/m,
    )
  })
})

describe('activate', () => {
  const systemd = (user: boolean): Service => ({
    manager: 'systemd',
    file: '/etc/systemd/system/midden-deploy-webhook.service',
    content: '',
    user,
  })

  test('systemd reloads, enables and restarts the unit', () => {
    const { calls, run } = recorder()
    activate(systemd(false), run)
    assert.deepEqual(calls, [
      'systemctl daemon-reload',
      'systemctl enable midden-deploy-webhook.service',
      'systemctl restart midden-deploy-webhook.service',
    ])
  })

  test('a user unit goes to the user manager', () => {
    const { calls, run } = recorder()
    activate(systemd(true), run)
    assert.deepEqual(calls, [
      'systemctl --user daemon-reload',
      'systemctl --user enable midden-deploy-webhook.service',
      'systemctl --user restart midden-deploy-webhook.service',
    ])
  })

  test('a failing systemctl fails the install', () => {
    const { calls, run } = recorder((call) => call.includes('enable'))
    assert.throws(() => activate(systemd(false), run), /enable/)
    assert.equal(calls.length, 2)
  })

  test('launchd boots out the old agent, if any, then bootstraps', () => {
    const definition: Service = {
      manager: 'launchd',
      file: '/Users/me/Library/LaunchAgents/org.midden.deploy-webhook.plist',
      content: '',
      domain: 'gui/501',
    }
    const { calls, run } = recorder((call) => call.includes('bootout'))
    activate(definition, run)
    assert.deepEqual(calls, [
      'launchctl bootout gui/501/org.midden.deploy-webhook',
      `launchctl bootstrap gui/501 ${definition.file}`,
    ])
  })
})

describe('deploymentDir', () => {
  test('MIDDEN_DIR wins, resolved', () => {
    assert.equal(
      deploymentDir({ MIDDEN_DIR: '/srv/midden/' }, 'linux', 0, '/root'),
      '/srv/midden',
    )
  })

  test('root on Linux defaults to /opt/midden', () => {
    assert.equal(deploymentDir({}, 'linux', 0, '/root'), '/opt/midden')
  })

  test('otherwise ~/midden, as before on macOS', () => {
    assert.equal(
      deploymentDir({}, 'darwin', 501, '/Users/me'),
      '/Users/me/midden',
    )
    assert.equal(
      deploymentDir({}, 'darwin', 0, '/var/root'),
      '/var/root/midden',
    )
    assert.equal(
      deploymentDir({}, 'linux', 1000, '/home/me'),
      '/home/me/midden',
    )
  })
})
