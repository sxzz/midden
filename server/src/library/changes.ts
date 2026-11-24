import { sql } from 'drizzle-orm'
import { assertSaved } from './read.ts'
import {
  assetsById,
  iso,
  list,
  parseJson,
  type AssetView,
  type Reader,
} from './views.ts'

/** A text field of a profile's header: before or after is absent when empty. */
export interface TextChange {
  field: 'name' | 'username' | 'bio'
  before?: string
  after?: string
}

export interface ProtectedChange {
  field: 'protected'
  before: boolean
  after: boolean
}

/** An image of the profile: absent before when added, after when removed. */
export interface ImageChange {
  field: 'avatar' | 'banner'
  before?: AssetView
  after?: AssetView
}

export type ProfileFieldChange = TextChange | ProtectedChange | ImageChange

/** A capture that first saw the profile look different from before. */
export interface ProfileChange {
  capture_id: string
  revision_id: string
  /** When that capture finished, as `observed_at` shows it. */
  observed_at: string
  /** Name, username, bio, protection, avatar, banner, as far as each changed. */
  fields: ProfileFieldChange[]
}

export interface ProfileChanges {
  /** Newest first. */
  items: ProfileChange[]
  /** Older revisions were not compared, so earlier changes may be missing. */
  truncated?: boolean
}

/**
 * Revisions compared at most, newest first: years of daily changes, and
 * little enough to read for every visit to the page.
 */
export const CHANGES_WINDOW = 1000

/** An image as last seen; `undefined` in a state means "not known". */
interface Image {
  hash: string
  asset: string
}

interface Seen {
  name: string
  username: string
  bio: string
  protected?: boolean
  avatar?: Image | null
  banner?: Image | null
}

interface MediaRow {
  id: string
  purpose: string
  state: string
  hash: string | null
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const LINE_BREAK = /\r?\n/

/**
 * What the detail page shows of a profile at one revision, read the way the
 * web reads it (presentation.ts, relations.ts). The bio is the profile's
 * description, or for snapshots without one the revision's text without
 * its leading handle line.
 */
function seen(
  data: Record<string, unknown>,
  revisionText: string | null,
  media: MediaRow[],
): Seen {
  const metadata =
    data.metadata && typeof data.metadata === 'object'
      ? (data.metadata as Record<string, unknown>)
      : {}
  const username = text(data.username)
  let bio: string
  if (typeof metadata.description === 'string') bio = text(metadata.description)
  else {
    const lines = (revisionText ?? '').split(LINE_BREAK)
    if (username && lines[0]?.trim() === `@${username}`) lines.shift()
    bio = lines.join('\n').trim()
  }
  return {
    name: text(data.name),
    username,
    bio,
    ...(typeof metadata.protected === 'boolean'
      ? { protected: metadata.protected }
      : {}),
    avatar: image(media, 'avatar'),
    banner: image(media, 'banner'),
  }
}

/**
 * The first ready image for a purpose, compared by content. An image the
 * capture listed but could not save is not known, so it is no change; one
 * the capture did not list at all is gone.
 */
function image(media: MediaRow[], purpose: string): Image | null | undefined {
  const listed = media.filter((m) => m.purpose === purpose)
  const ready = listed.find((m) => m.state === 'ready' && m.hash)
  if (ready) return { hash: ready.hash!, asset: ready.id }
  return listed.length ? undefined : null
}

/**
 * The revision's text, where it is the bio: only for a profile without a
 * description, so the payload is read only then.
 */
const BIO_TEXT = `CASE WHEN json_type(v.data, '$.metadata.description') = 'text'
  THEN NULL ELSE rv.payload ->> '$.text' END`

/**
 * The changes in what a saved profile shows: its name, username, bio,
 * protection, avatar and banner, never its counts or fields the page does not
 * show. Each is a revision whose shown profile differs from the revision
 * before it, newest first; up to `limit` of them, found among the newest
 * CHANGES_WINDOW revisions. A collection about anything but a profile has
 * none.
 */
export function listProfileChanges(
  r: Reader,
  id: string,
  limit = CHANGES_WINDOW,
  /** Revisions compared; tests make it small. */
  span = CHANGES_WINDOW,
): ProfileChanges {
  assertSaved(r, id)
  // Cheap first pass: a revision whose root entity version did not move
  // shows the same profile, since a version is the entity's data together
  // with its media's hashes and states; unless its bio is read from the
  // revision's text, which is then compared too. Only the others are read in
  // full.
  const revisions = r.db.all<{
    id: string
    version: string
    type: string
    text: string | null
  }>(sql`
    SELECT rv.id, re.entity_version_id AS version, e.kind AS type,
      ${sql.raw(BIO_TEXT)} AS text
    FROM revisions rv
    JOIN revision_entities re ON re.revision_id = rv.id AND re.is_root = 1
    JOIN entity_versions v ON v.id = re.entity_version_id
    JOIN entities e ON e.id = v.entity_id
    WHERE rv.collection_id = ${id}
    ORDER BY rv.created_at DESC, rv.id DESC
    -- The window, the revision before it to compare its oldest against,
    -- and one more to tell whether anything was left out.
    LIMIT ${span + 2}`)
  if (!revisions[0]?.type.endsWith('.profile')) return { items: [] }
  const truncated = revisions.length > span + 1
  const window = revisions.slice(0, span + 1).toReversed()
  const moved = window.filter((row, i) => {
    const before = window[i - 1]
    return !before || row.version !== before.version || row.text !== before.text
  })
  if (moved.length < 2) return { items: [], ...(truncated && { truncated }) }
  const rows = r.db.all<{
    id: string
    capture_id: string
    finished_at: number
    data: string
    text: string | null
    media: string
  }>(sql`
    SELECT rv.id, rv.capture_id, coalesce(c.finished_at, rv.created_at)
        AS finished_at, v.data, ${sql.raw(BIO_TEXT)} AS text,
      -- The root's own images, in the order the capture listed them.
      (SELECT json_group_array(json_object('id', a.id, 'purpose', a.purpose,
          'state', a.state, 'hash', b.hash) ORDER BY a.position)
        FROM json_each(rv.payload, '$.graph.entities') ge
        JOIN json_each(ge.value, '$.resource_indices') gi
        JOIN assets a ON a.capture_id = rv.capture_id AND a.position = gi.value
          AND a.purpose IN ('avatar', 'banner')
        LEFT JOIN blobs b ON b.id = a.blob_id
        WHERE ge.value ->> 'key' = re.entity_key) AS media
    FROM json_each(${list(moved.map((row) => row.id))}) wanted
    JOIN revisions rv ON rv.id = wanted.value
    JOIN revision_entities re ON re.revision_id = rv.id AND re.is_root = 1
    JOIN entity_versions v ON v.id = re.entity_version_id
    LEFT JOIN captures c ON c.id = rv.capture_id
    ORDER BY wanted.key`)
  const changes: (Omit<ProfileChange, 'fields'> & {
    fields: RawFieldChange[]
  })[] = []
  let last: Seen | undefined
  for (const row of rows) {
    const now = seen(
      parseJson<Record<string, unknown>>(row.data),
      row.text,
      parseJson<MediaRow[]>(row.media),
    )
    if (last) {
      const fields = compare(last, now)
      if (fields.length)
        changes.push({
          capture_id: row.capture_id,
          revision_id: row.id,
          observed_at: iso(row.finished_at),
          fields,
        })
    }
    // What is not known now keeps what was seen before.
    last = {
      ...now,
      protected: now.protected ?? last?.protected,
      avatar: now.avatar === undefined ? last?.avatar : now.avatar,
      banner: now.banner === undefined ? last?.banner : now.banner,
    }
  }
  const items = changes.toReversed().slice(0, limit)
  const assets = assetsById(
    r,
    items
      .flatMap((item) =>
        item.fields.flatMap((f) =>
          'image' in f ? [f.image.before, f.image.after] : [],
        ),
      )
      .filter((asset): asset is string => !!asset),
  )
  return {
    items: items.map((item) => ({
      ...item,
      fields: item.fields.map((f): ProfileFieldChange => {
        if (!('image' in f)) return f
        const before = f.image.before && assets.get(f.image.before)
        const after = f.image.after && assets.get(f.image.after)
        return {
          field: f.field,
          ...(before ? { before } : {}),
          ...(after ? { after } : {}),
        }
      }),
    })),
    ...(truncated && { truncated }),
  }
}

/** A field change before its images are read: images by asset id. */
type RawFieldChange =
  | TextChange
  | ProtectedChange
  | {
      field: 'avatar' | 'banner'
      image: { before?: string; after?: string }
    }

function compare(before: Seen, after: Seen): RawFieldChange[] {
  const fields: RawFieldChange[] = []
  for (const field of ['name', 'username', 'bio'] as const)
    if (before[field] !== after[field])
      fields.push({
        field,
        ...(before[field] ? { before: before[field] } : {}),
        ...(after[field] ? { after: after[field] } : {}),
      })
  // Protection known on both sides; a capture that did not say is no change.
  if (
    before.protected !== undefined &&
    after.protected !== undefined &&
    before.protected !== after.protected
  )
    fields.push({
      field: 'protected',
      before: before.protected,
      after: after.protected,
    })
  for (const field of ['avatar', 'banner'] as const) {
    const was = before[field]
    const is = after[field]
    // Not known on either side; an image shown both times compares by hash.
    if (was === undefined || is === undefined || was?.hash === is?.hash)
      continue
    fields.push({
      field,
      image: {
        ...(was ? { before: was.asset } : {}),
        ...(is ? { after: is.asset } : {}),
      },
    })
  }
  return fields
}
