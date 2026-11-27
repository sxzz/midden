import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { backup } from 'node:sqlite'
import { cac, type Command } from 'cac'
import { mediaCommand } from '#blob/migrate.ts'
import { maintainDatabase } from '#db/maintain.ts'
import { rawGetCommand } from '#raw/get.ts'
import {
  tokenCreate,
  tokenExpires,
  tokenList,
  tokenRevoke,
} from '#tokens/cli.ts'
import type { BucketBlobStore } from '#blob/bucket-store.ts'
import type { Config } from '#config.ts'
import type { Database } from '#db/client.ts'
import type { RawStore } from '#raw/store.ts'
import type { Buffer } from 'node:buffer'

/**
 * What the commands need from outside. Everything that touches the
 * environment is lazy, so `--help` and a mistyped command work without a
 * configuration, and tests pass their own.
 */
export interface CliContext {
  /** Data, for stdout: what a script captures. */
  out: (line: string) => void
  /** Messages for people, for stderr. */
  err: (line: string) => void
  /** Raw bytes to stdout. */
  write: (bytes: Buffer) => void
  /** Throws when the configuration is invalid. */
  config: () => Config
  /** The database, migrated and opened on first use; the caller closes it. */
  db: () => Database
  /** The R2 media bucket, or undefined when MEDIA_STORE is not r2. */
  mediaStore: () => Promise<BucketBlobStore | undefined>
  /** The bucket of raw responses, or undefined when they are kept in the database. */
  rawStore: () => Promise<RawStore | undefined>
  now: () => number
  version: string
}

/** A mistake in the command line: exit code 2, not a failed operation. */
class UsageError extends Error {}

const TOKEN_COMMANDS = ['create', 'list', 'revoke', 'expires']

/** An option that must be a whole number of at least 1, or be left out. */
function count(value: unknown, flag: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 1)
    throw new UsageError(`${flag} must be a whole number of at least 1`)
  return n
}

/** An option given but without a value (`--label` last) is `true`. */
function text(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'boolean' || Array.isArray(value))
    throw new UsageError(`${flag} needs one value`)
  return String(value)
}

/**
 * cac matches a command by the first word only. `token create` is one
 * command whose name has a space: join the two words before parsing.
 */
function joinTokenCommand(argv: string[]): string[] {
  const [first, second, ...rest] = argv
  return first === 'token' && second && !second.startsWith('-')
    ? [`token ${second}`, ...rest]
    : argv
}

/** The commands, each with its options, defaults and examples for `--help`. */
function build(ctx: CliContext) {
  const cli = cac('midden')
  const command = (name: string, description: string): Command =>
    cli.command(name, description)

  command(
    'token create',
    'Make an API token; prints the secret alone on stdout, once',
  )
    .option('--ro', 'Read only')
    .option('--rw', 'Read and write (never delete)')
    .option('--label <label>', 'Name, 1 to 64 characters', { default: 'cli' })
    .option(
      '--expires <when>',
      'ISO time, a duration from now (30m, 12h, 7d) or never',
      { default: 'never' },
    )
    .example('  midden token create --ro --label smoke --expires 1h')
    .action((options: Record<string, unknown>) => {
      if (Boolean(options.ro) === Boolean(options.rw))
        throw new UsageError(
          'give one of --ro (read only) or --rw (read and write)',
        )
      return tokenCreate(
        ctx.db(),
        {
          permission: options.ro ? 'ro' : 'rw',
          label: text(options.label, '--label'),
          expires: text(options.expires, '--expires'),
        },
        ctx,
        ctx.now(),
      )
    })

  command('token list', 'List tokens (never their secrets), oldest first')
    .option('--json', 'Print a JSON array')
    .example('  midden token list --json')
    .action((options: Record<string, unknown>) =>
      tokenList(ctx.db(), { json: !!options.json }, ctx, ctx.now()),
    )

  command('token revoke <id|label>', 'Delete a token; its secret stops working')
    .option('--json', 'Print {"revoked": <label>}')
    .example('  midden token revoke smoke')
    .action((ref: unknown, options: Record<string, unknown>) =>
      tokenRevoke(
        ctx.db(),
        String(ref),
        { json: !!options.json },
        ctx,
        ctx.now(),
      ),
    )

  command(
    'token expires <id|label> <when>',
    'Move a token expiry: an ISO time, a duration from now (30m, 12h, 7d) or never',
  )
    .option('--json', 'Print {"label", "expires_at"}')
    .example('  midden token expires smoke 7d')
    .action((ref: unknown, when: unknown, options: Record<string, unknown>) =>
      tokenExpires(
        ctx.db(),
        String(ref),
        String(when),
        { json: !!options.json },
        ctx,
        ctx.now(),
      ),
    )

  command(
    'backup <directory>',
    'Copy the database into <directory> while the server runs; prints the file',
  )
    .option('--json', 'Print {"file": <path>}')
    .action(async (directory: string, options: Record<string, unknown>) => {
      // A consistent copy of the database while the server keeps running.
      // Media files never change once written; copy them with rsync.
      const db = ctx.db()
      mkdirSync(directory, { recursive: true })
      const stamp = new Date(ctx.now()).toISOString().replaceAll(/[:.]/g, '-')
      const file = path.join(directory, `midden-${stamp}.db`)
      await backup(db.$client, file)
      ctx.out(options.json ? JSON.stringify({ file }) : file)
      return 0
    })

  for (const [name, description] of [
    [
      'media-migrate',
      'Upload local media originals to the R2 bucket and record them',
    ],
    [
      'media-prune-local',
      'Delete local originals the bucket holds a verified copy of',
    ],
  ] as const)
    command(name, description)
      .option('--dry-run', 'Report what would happen and change nothing')
      .option('--concurrency <n>', 'Blobs handled at once')
      .option('--verify-download', 'Download objects with no checksum and hash')
      .option('--limit <n>', 'Stop after this many blobs')
      .action(async (options: Record<string, unknown>) => {
        const concurrency = count(options.concurrency, '--concurrency')
        const limit = count(options.limit, '--limit')
        const store = await ctx.mediaStore()
        if (!store) {
          ctx.err(`${name} needs MEDIA_STORE=r2 and the R2 settings`)
          return 1
        }
        return mediaCommand(name, ctx.db(), store, {
          dryRun: !!options.dryRun,
          concurrency,
          verifyDownload: !!options.verifyDownload,
          limit,
          print: ctx.out,
        })
      })

  command(
    'raw-get <capture> [position]',
    'List a capture’s raw responses, or write one body (by position) to stdout',
  )
    .option('--json', 'List as a JSON array')
    .example('  midden raw-get <capture> 0 | head -c 300')
    .action(
      async (
        capture: string,
        position: string | undefined,
        options: Record<string, unknown>,
      ) => {
        const at = position === undefined ? undefined : Number(position)
        if (at !== undefined && (!Number.isSafeInteger(at) || at < 0))
          throw new UsageError('position must be a whole number, 0 or more')
        if (at !== undefined && options.json)
          throw new UsageError('--json is for the listing, not a body')
        return rawGetCommand(
          ctx.db(),
          await ctx.rawStore(),
          capture,
          at,
          { print: ctx.out, error: ctx.err, write: ctx.write },
          { json: !!options.json },
        )
      },
    )

  command(
    'maintain',
    'Check, optionally vacuum, the database; web, worker and Litestream stopped',
  )
    .option('--vacuum', 'Compact the database, keeping the original')
    .option('--rebuild-search', 'Rebuild the search indexes')
    .action((options: Record<string, unknown>) =>
      // Opens the database itself, alone: nothing else may have it open.
      maintainDatabase(ctx.config().databasePath, {
        vacuum: !!options.vacuum,
        rebuildSearch: !!options.rebuildSearch,
        print: ctx.out,
      }),
    )

  cli.help()
  cli.version(ctx.version)
  return cli
}

/**
 * Run one command line (without `node cli.ts`); the exit code: 0 done, 1 the
 * operation failed, 2 the command line is wrong. Data goes to `ctx.out`,
 * everything else to `ctx.err`.
 */
export async function runCli(argv: string[], ctx: CliContext): Promise<number> {
  const cli = build(ctx)
  // cac prints help and version with console.info.
  const info = console.info
  console.info = (...lines: unknown[]) => ctx.out(lines.join(' '))
  try {
    const parsed = cli.parse(['', '', ...joinTokenCommand(argv)], {
      run: false,
    })
    if (parsed.options.help || parsed.options.version) return 0
    if (!cli.matchedCommand) {
      const [name] = cli.args
      if (name === 'token')
        throw new UsageError(
          `token needs a subcommand: ${TOKEN_COMMANDS.join(', ')}`,
        )
      throw new UsageError(
        name ? `unknown command ${JSON.stringify(name)}` : 'no command given',
      )
    }
    console.info = info
    return ((await cli.runMatchedCommand()) as number | undefined) ?? 0
  } catch (error) {
    if (error instanceof UsageError || (error as Error)?.name === 'CACError') {
      ctx.err(`midden: ${(error as Error).message}`)
      ctx.err('run `midden --help` or `midden <command> --help` for usage')
      return 2
    }
    throw error
  } finally {
    console.info = info
  }
}
