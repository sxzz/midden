// Counts what each write transaction of this process adds to the WAL, for
// the load test's `wal=<file>` (bench-load.ts). Loaded into a server
// process before anything opens the database: it turns off the automatic
// checkpoints of every connection, so the WAL only grows and its size after
// a commit is where that commit's frames end. Each commit is named by the
// code that began it (the first frame of `src/` outside `db/`) and lists the
// statements it ran. Written to the file as JSON when the process exits.
import { statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { DatabaseSync, StatementSync } from 'node:sqlite'

export interface WalCommit {
  /** Index into `labels`. */
  label: number
  /** WAL size after the commit. */
  end: number
  /** Milliseconds since the epoch. */
  at: number
}

export interface WalLog {
  labels: string[]
  /** Statement kinds (`update jobs`) each label's transactions ran, counted. */
  statements: Record<string, number>[]
  commits: WalCommit[]
}

const AT = /^at (?:async )?/
const CALL = /^(.*?) \((.*)\)$/
const PLACE = /^(.*):(\d+):\d+$/
const QUOTES = /["`]/g
const WRITE =
  /^(?:with .*?\)\s*)?(insert|replace|update|delete)(?: or \w+)?(?: into| from)?\s+(\w+)/s
const SPACE = /\s+/
const WRITE_KIND = /^(?:insert|update|delete|replace) /

const file = process.env.BENCH_WAL_LOG
if (file) install(file)

function install(out: string): void {
  Error.stackTraceLimit = 40
  const exec = DatabaseSync.prototype.exec
  const SRC = `${path.sep}src${path.sep}`
  const labels: string[] = []
  const byLabel = new Map<string, number>()
  const statements: Record<string, number>[] = []
  const commits: WalCommit[] = []
  const seen = new WeakSet<DatabaseSync>()
  const owner = new WeakMap<StatementSync, DatabaseSync>()
  const kinds = new Map<string, string>()
  let current: number | undefined
  let walFile: string | undefined

  const labelOf = (): number => {
    const frames = (new Error('trace').stack ?? '').split('\n').slice(1)
    const ours = frames.filter(
      (f) =>
        f.includes(SRC) &&
        !f.includes(`${SRC}db${path.sep}`) &&
        !f.includes('node_modules'),
    )
    const short = (frame: string) => {
      const text = frame.trim().replace(AT, '')
      const call = CALL.exec(text)
      const [fn, at] = call ? [call[1]!, call[2]!] : ['', text]
      const place = PLACE.exec(at)
      if (!place) return text
      return `${place[1]!.split(SRC).at(-1)}:${place[2]} ${fn}`.trim()
    }
    const name = ours.length
      ? ours.slice(0, 2).map(short).join(' < ')
      : short(frames.find((f) => !f.includes('wal-meter')) ?? '?')
    let id = byLabel.get(name)
    if (id === undefined) {
      id = labels.push(name) - 1
      byLabel.set(name, id)
      statements.push({})
    }
    return id
  }

  const kindOf = (text: string): string => {
    let kind = kinds.get(text)
    if (kind) return kind
    const sql = text.trim().toLowerCase().replaceAll(QUOTES, '')
    const match = WRITE.exec(sql)
    kind = match
      ? `${match[1]} ${match[2]}`
      : sql.split(SPACE, 2).join(' ').slice(0, 40)
    kinds.set(text, kind)
    return kind
  }

  const walSize = (): number => {
    try {
      return statSync(walFile!).size
    } catch {
      return 0
    }
  }

  const before = (db: DatabaseSync, text: string) => {
    if (!seen.has(db)) {
      seen.add(db)
      const location = db.location()
      if (location) {
        walFile ??= `${location}-wal`
        exec.call(db, 'PRAGMA wal_autocheckpoint = 0')
      }
    }
    const kind = kindOf(text)
    if (!db.isTransaction) {
      if (kind.startsWith('select')) return
      current = labelOf()
    }
    if (current === undefined) current = labelOf()
    if (!WRITE_KIND.test(kind)) return
    const counts = statements[current]!
    counts[kind] = (counts[kind] ?? 0) + 1
  }

  const after = (db: DatabaseSync) => {
    if (db.isTransaction || current === undefined) return
    const end = walSize()
    if (end !== (commits.at(-1)?.end ?? 0))
      commits.push({ label: current, end, at: Date.now() })
    current = undefined
  }

  const prepare = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.prepare = function (
    this: DatabaseSync,
    ...args: Parameters<typeof prepare>
  ) {
    const statement = prepare.apply(this, args)
    owner.set(statement, this)
    return statement
  }
  DatabaseSync.prototype.exec = function (this: DatabaseSync, text: string) {
    before(this, text)
    try {
      return exec.call(this, text)
    } finally {
      after(this)
    }
  }
  for (const method of ['run', 'get', 'all'] as const) {
    const original = StatementSync.prototype[method] as (
      ...args: unknown[]
    ) => unknown
    ;(StatementSync.prototype as unknown as Record<string, unknown>)[method] =
      function (this: StatementSync, ...args: unknown[]) {
        const db = owner.get(this)
        if (!db) return original.apply(this, args)
        before(db, this.sourceSQL)
        try {
          return original.apply(this, args)
        } finally {
          after(db)
        }
      }
  }

  process.on('exit', () => {
    const log: WalLog = { labels, statements, commits }
    writeFileSync(out, JSON.stringify(log))
  })
}
