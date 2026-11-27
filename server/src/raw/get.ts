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
  out: {
    /** The listing: data, for stdout. */
    print: (line: string) => void
    /** Why nothing was found: for stderr. */
    error: (line: string) => void
    write: (bytes: Buffer) => void
  },
  options: { json?: boolean } = {},
): Promise<number> {
  const rows = captureResponses(db, captureId)
  if (position === undefined) {
    if (!rows.length) out.error(`no raw responses for capture ${captureId}`)
    if (options.json)
      out.print(
        JSON.stringify(
          rows.map((row) => ({
            position: row.position,
            location: row.local ? 'database' : 'bucket',
            size: row.size,
            content_type: row.contentType,
            source_url: row.sourceUrl,
          })),
        ),
      )
    else
      for (const row of rows)
        out.print(
          `${row.position}\t${row.local ? 'database' : 'bucket'}\t${row.size}\t${row.contentType}\t${row.sourceUrl}`,
        )
    return rows.length ? 0 : 1
  }
  const row = rows.find((r) => r.position === position)
  if (!row) {
    out.error(`no raw response ${position} for capture ${captureId}`)
    return 1
  }
  out.write(await sourceBody(db, raw, row))
  return 0
}
