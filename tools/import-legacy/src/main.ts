import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { parseArgs, parseEnv, promisify } from 'node:util'
import { parseCredentialKey } from './convert.ts'
import { importLegacy, type ImportReport } from './importer.ts'
import { directorySource, s3Source, type ObjectSource } from './media.ts'
import { TemporaryPostgres, type Connection } from './postgres.ts'

const USAGE = `Import the old (Go) Midden's data into a new data directory.

Usage: SECRET_KEY=... node tools/import-legacy/src/main.ts --out <dir> <source>

Old database, one of:
  --backup <file.tgz>      archive made by the old scripts/backup.sh
                           (database dump, bucket objects and .env)
  --dump <file>            pg_dump -Fc of the old database
  --database-url <url>     the old database itself
  --backup and --dump restore into a temporary PostgreSQL, so initdb,
  pg_ctl and pg_restore must be on PATH (mise exec postgres@17 -- ...).

Old media, unless taken from --backup:
  --objects <dir>          a copy of the bucket (the directory holding objects/)
  --s3                     the bucket itself, with S3_* from the old .env
  --s3-endpoint <url>      replaces S3_ENDPOINT, e.g. http://127.0.0.1:18333

Keys:
  --legacy-env <file>      the old .env, for CREDENTIAL_KEY and S3_*
                           (default: the one in --backup)
  SECRET_KEY               environment: the new service's secret
  CREDENTIAL_KEY           environment: overrides the old .env

Owner:
  --tenant <uuid>          the owner's tenant, when the old database has several;
                           library, notes, tags, accounts and records of other
                           tenants are left out

Output:
  --out <dir>              the DATA_DIR to create
  --force                  replace <dir> when it exists
  --allow-missing-media    finish even when objects are missing
`

function fail(message: string): never {
  throw new UsageError(message)
}

class UsageError extends Error {}

async function main(): Promise<number> {
  const { values: args } = parseArgs({
    options: {
      backup: { type: 'string' },
      dump: { type: 'string' },
      'database-url': { type: 'string' },
      objects: { type: 'string' },
      s3: { type: 'boolean' },
      's3-endpoint': { type: 'string' },
      'legacy-env': { type: 'string' },
      tenant: { type: 'string' },
      out: { type: 'string' },
      force: { type: 'boolean' },
      'allow-missing-media': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const sources = [args.backup, args.dump, args['database-url']].filter(Boolean)
  if (sources.length !== 1)
    fail('give exactly one of --backup, --dump and --database-url')
  if (!args.out) fail('--out is required')
  if (args.objects && args.s3) fail('give only one of --objects and --s3')
  const secretKey = process.env.SECRET_KEY ?? ''
  if (secretKey.length < 32)
    fail('SECRET_KEY must be set to the new secret (at least 32 characters)')
  const out = path.resolve(args.out)
  if (existsSync(out) && !args.force)
    fail(`${out} already exists; pass --force to replace it`)

  const cleanup: (() => Promise<void>)[] = []
  const log = (message: string) => process.stderr.write(`${message}\n`)
  try {
    let unpacked: string | undefined
    if (args.backup) {
      unpacked = await mkdtemp(path.join(tmpdir(), 'midden-backup-'))
      cleanup.push(() => rm(unpacked!, { recursive: true, force: true }))
      log(`unpacking ${args.backup}`)
      await promisify(execFile)('tar', [
        '-xzf',
        path.resolve(args.backup),
        '-C',
        unpacked,
      ])
    }

    const envFile =
      args['legacy-env'] ?? (unpacked && path.join(unpacked, 'config/.env'))
    const legacyEnv: Record<string, string | undefined> = envFile
      ? parseEnv(await readFile(envFile, 'utf8'))
      : {}

    let legacy: Connection
    const dump = args.dump ?? (unpacked && path.join(unpacked, 'database.dump'))
    if (dump) {
      log('starting a temporary PostgreSQL')
      const server = await TemporaryPostgres.start()
      cleanup.push(() => server.stop())
      log(`restoring ${dump}`)
      await server.restore('legacy', path.resolve(dump))
      legacy = server.connection('legacy')
    } else {
      legacy = { connectionString: args['database-url'] }
    }

    let objects: ObjectSource
    if (args.objects) objects = directorySource(path.resolve(args.objects))
    else if (args.s3) {
      const need = (key: string) =>
        legacyEnv[key] || fail(`${key} is missing from the old .env`)
      objects = s3Source({
        endpoint: args['s3-endpoint'] ?? need('S3_ENDPOINT'),
        bucket: need('S3_BUCKET'),
        accessKey: need('S3_ACCESS_KEY'),
        secretKey: need('S3_SECRET_KEY'),
      })
    } else if (unpacked) {
      objects = directorySource(
        await backupBucket(unpacked, legacyEnv.S3_BUCKET),
      )
    } else fail('give --objects or --s3 for the media')

    const encodedKey = process.env.CREDENTIAL_KEY || legacyEnv.CREDENTIAL_KEY
    const credentialKey = encodedKey
      ? parseCredentialKey(encodedKey)
      : undefined

    // Build beside the target and move it in place only when complete.
    const partial = `${out}.partial`
    await rm(partial, { recursive: true, force: true })
    await mkdir(partial, { recursive: true })
    log(`reading media from ${objects.description}`)
    const report = await importLegacy({
      legacy,
      objects,
      dataDir: partial,
      secretKey,
      credentialKey,
      tenant: args.tenant,
      log,
    })
    process.stdout.write(formatReport(report))

    const { media } = report
    if (
      media.mismatched.length ||
      (media.missing.length && !args['allow-missing-media'])
    ) {
      log(
        `\nImport failed: media did not match the database. The incomplete result is in ${partial}.`,
      )
      return 1
    }
    if (existsSync(out)) await rm(out, { recursive: true, force: true })
    await rename(partial, out)
    log(`\nImported into ${out}`)
    return 0
  } finally {
    for (const step of cleanup.toReversed()) await step()
  }
}

/** `s3/<bucket>` inside an unpacked backup. */
async function backupBucket(
  unpacked: string,
  bucket: string | undefined,
): Promise<string> {
  const root = path.join(unpacked, 's3')
  if (bucket) return path.join(root, bucket)
  const entries = existsSync(root) ? await readdir(root) : []
  if (entries.length !== 1)
    fail('cannot tell the bucket in the backup; set S3_BUCKET in the old .env')
  return path.join(root, entries[0])
}

const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

function bytes(value: number): string {
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit ? value.toFixed(1) : value} ${units[unit]}`
}

export function formatReport(report: ImportReport): string {
  const rows = report.tables.map((table) => [
    table.legacy === table.target || table.target === '—'
      ? table.legacy
      : `${table.legacy} → ${table.target}`,
    String(table.legacyRows),
    table.target === '—' ? '—' : String(table.importedRows),
    table.note ?? '',
  ])
  const header = ['table', 'old rows', 'imported', 'note']
  const widths = header.map((title, i) =>
    Math.max(title.length, ...rows.map((row) => row[i].length)),
  )
  const line = (row: string[]) =>
    row
      .map((cell, i) =>
        i === 1 || i === 2 ? cell.padStart(widths[i]) : cell.padEnd(widths[i]),
      )
      .join('  ')
      .trimEnd()
  const { media } = report
  const lines = [
    '',
    line(header),
    ...rows.map(line),
    '',
    `media: ${media.total} blobs, ${media.copied} copied (${bytes(media.bytes)}), each checked against blobs.hash and blobs.size`,
  ]
  for (const { blob, hash, size } of media.mismatched)
    lines.push(
      `  MISMATCH blob ${blob.id} (${blob.objectKey}): expected ${blob.hash} / ${blob.size} B, got ${hash} / ${size} B`,
    )
  for (const blob of media.missing)
    lines.push(`  MISSING  blob ${blob.id} (${blob.objectKey})`)
  if (!media.mismatched.length && !media.missing.length)
    lines.push('  all hashes match')
  return `${lines.join('\n')}\n`
}

if (import.meta.main)
  main().then(
    (code) => (process.exitCode = code),
    (error: unknown) => {
      process.stderr.write(
        error instanceof UsageError
          ? `${error.message}\n\n${USAGE}`
          : `${(error as Error).stack ?? error}\n`,
      )
      process.exitCode = error instanceof UsageError ? 2 : 1
    },
  )
