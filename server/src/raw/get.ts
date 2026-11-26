import { captureResponses, sourceBody } from './responses.ts'
import type { Database } from '#db/client.ts'
import type { RawStore } from './store.ts'
import type { Buffer } from 'node:buffer'

/**
 * `raw-get <capture> [position]`: a capture's raw responses, or one body
 * written out as fetched, wherever it is kept.
 */
export async function rawGetCommand(
  db: Database,
  raw: RawStore | undefined,
  captureId: string,
  position: number | undefined,
  out: { print: (line: string) => void; write: (bytes: Buffer) => void },
): Promise<number> {
  const rows = captureResponses(db, captureId)
  if (position === undefined) {
    if (!rows.length) out.print(`no raw responses for capture ${captureId}`)
    for (const row of rows)
      out.print(
        `${row.position}\t${row.local ? 'database' : 'bucket'}\t${row.size}\t${row.contentType}\t${row.sourceUrl}`,
      )
    return rows.length ? 0 : 1
  }
  const row = rows.find((r) => r.position === position)
  if (!row) {
    out.print(`no raw response ${position} for capture ${captureId}`)
    return 1
  }
  out.write(await sourceBody(db, raw, row))
  return 0
}
