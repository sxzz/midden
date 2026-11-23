#!/usr/bin/env node
// Install a LaunchAgent that runs backup.ts from the deployment checkout once
// a day, so the backup always matches the deployed version.
//
//   node scripts/install-backup.ts [--dir ~/midden] [--to ~/backups/midden/auto] [--at 12:00] [--print]
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: path.join(homedir(), 'midden') },
    to: {
      type: 'string',
      default: path.join(homedir(), 'backups', 'midden', 'auto'),
    },
    at: { type: 'string', default: '12:00' },
    print: { type: 'boolean', default: false },
  },
})
const dir = path.resolve(values.dir)
if (!existsSync(path.join(dir, 'compose.yaml')))
  throw new Error(`${dir} is not a deployment checkout`)
const time = /^(\d{1,2}):(\d{2})$/.exec(values.at)
if (!time || Number(time[1]) > 23 || Number(time[2]) > 59)
  throw new Error('--at takes HH:MM')

const LABEL = 'org.midden.backup'

const xml = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const which = (name: string) =>
  path.dirname(execFileSync('which', [name], { encoding: 'utf8' }).trim())

const PATH = [
  ...new Set([
    path.dirname(process.execPath),
    which('docker'),
    which('git'),
    which('rsync'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]),
].join(':')

const logs = path.join(dir, '.local', 'backup')
const args = [
  process.execPath,
  path.join(dir, 'scripts', 'backup.ts'),
  '--to',
  path.resolve(values.to),
]
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>MIDDEN_DIR</key><string>${xml(dir)}</string><key>PATH</key><string>${xml(PATH)}</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>${Number(time[1])}</integer><key>Minute</key><integer>${Number(time[2])}</integer></dict>
<key>WorkingDirectory</key><string>${xml(dir)}</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'stderr.log'))}</string>
</dict></plist>
`

if (values.print) {
  process.stdout.write(plist)
} else {
  mkdirSync(logs, { recursive: true, mode: 0o700 })
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
    `Installed ${LABEL}: daily at ${values.at}, backing up ${dir} to ${path.resolve(values.to)}`,
  )
}
