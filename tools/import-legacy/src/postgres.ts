import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import pg from 'pg'

const run = promisify(execFile)

/** How to reach a PostgreSQL database; passed straight to `pg.Client`. */
export type Connection = pg.ClientConfig

/**
 * A throwaway PostgreSQL cluster in a temp directory, reachable only through
 * a Unix socket. Needs `initdb`, `pg_ctl` and `pg_restore` on PATH, for
 * example through `mise exec postgres@17 -- ...`.
 */
export class TemporaryPostgres {
  readonly dir: string
  readonly #data: string
  #running = false
  readonly #onSignal = () => {
    this.#stopSync()
    process.exit(130)
  }

  private constructor(dir: string) {
    this.dir = dir
    this.#data = path.join(dir, 'data')
  }

  static async start(): Promise<TemporaryPostgres> {
    // Short base path: Unix socket paths are limited to about 100 bytes.
    const dir = await mkdtemp(path.join(tmpdir(), 'midden-pg-'))
    const server = new TemporaryPostgres(dir)
    try {
      await tool('initdb', [
        '--pgdata',
        server.#data,
        '--username',
        'postgres',
        '--auth',
        'trust',
        '--encoding',
        'utf8',
        '--locale',
        'C',
        '--no-sync',
      ])
      await tool('pg_ctl', [
        '--pgdata',
        server.#data,
        '--wait',
        '--log',
        path.join(dir, 'postgres.log'),
        '--options',
        `-c listen_addresses='' -k '${dir}' -c fsync=off`,
        'start',
      ])
      server.#running = true
      process.once('SIGINT', server.#onSignal)
      process.once('SIGTERM', server.#onSignal)
      return server
    } catch (error) {
      await server.stop()
      throw error
    }
  }

  connection(database: string): Connection {
    return { host: this.dir, port: 5432, user: 'postgres', database }
  }

  /** Create `database` and load a `pg_dump -Fc` archive into it. */
  async restore(database: string, dump: string): Promise<void> {
    const client = new pg.Client(this.connection('postgres'))
    await client.connect()
    try {
      await client.query(`CREATE DATABASE ${database}`)
      // Policies and grants in the dump name the old application role.
      await client.query('CREATE ROLE monitor_app')
    } finally {
      await client.end()
    }
    await tool('pg_restore', [
      '--host',
      this.dir,
      '--username',
      'postgres',
      '--dbname',
      database,
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      dump,
    ])
  }

  async stop(): Promise<void> {
    process.off('SIGINT', this.#onSignal)
    process.off('SIGTERM', this.#onSignal)
    if (this.#running) {
      this.#running = false
      await tool('pg_ctl', [
        '--pgdata',
        this.#data,
        '--mode',
        'fast',
        '--wait',
        'stop',
      ])
    }
    await rm(this.dir, { recursive: true, force: true })
  }

  #stopSync(): void {
    if (!this.#running) return
    spawnSync('pg_ctl', ['--pgdata', this.#data, '--mode', 'immediate', 'stop'])
  }
}

async function tool(command: string, args: string[]): Promise<void> {
  try {
    await run(command, args, { maxBuffer: 64 << 20 })
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string }
    if (failure.code === 'ENOENT')
      throw new Error(
        `${command} not found; run with PostgreSQL on PATH, e.g. mise exec postgres@17 -- node ...`,
        { cause: error },
      )
    throw new Error(`${command} failed: ${failure.stderr?.trim() || error}`, {
      cause: error,
    })
  }
}

/** Whether the PostgreSQL server tools are on PATH. */
export function hasPostgresTools(): boolean {
  return ['initdb', 'pg_ctl', 'pg_restore'].every(
    (command) => spawnSync(command, ['--version']).status === 0,
  )
}
