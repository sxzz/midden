# Capture pipeline: behavioral specification of the Go implementation

This spec describes how the old Go service (`/home/paseo/workspace/midden-go`, branch `golang`) captures content. It is detailed enough to reimplement the pipeline without reading the Go code again. Where the TypeScript rewrite has already decided to differ, the difference is pointed out but not resolved here.

## 0. Conventions and scope

### Citations

- Paths are relative to `/home/paseo/workspace/midden-go`.
- `app/` means `internal/app/`. `adapter/` means `internal/adapter/`. `x/` means `adapters/x/src/`. `ig/` means `adapters/instagram/src/`.
- Migration citations use short keys. Each key stands for `internal/store/migrations/<file>`:

  | key        | file                                             |
  | ---------- | ------------------------------------------------ |
  | `init`     | `0001_initial.sql`                               |
  | `annot`    | `20260930150000_collection_annotations.sql`      |
  | `alias`    | `20261001020000_collection_identity_aliases.sql` |
  | `aliasidx` | `20261001030000_collection_identity_index.sql`   |
  | `shared`   | `20261002020000_shared_content_access.sql`       |
  | `batch`    | `20261002030000_batch_refresh.sql`               |
  | `batchmsg` | `20261002040000_refresh_batch_messages.sql`      |
  | `srcstate` | `20261003010000_collection_source_state.sql`     |
  | `thumbs`   | `20261003020000_blob_thumbnails.sql`             |
  | `nolimits` | `20261003040000_drop_media_size_limits.sql`      |
  | `lookup`   | `20261004010000_lookup_indexes.sql`              |
  | `maint`    | `20261011010000_maintenance.sql`                 |
  | `records`  | `20261014010000_capture_records.sql`             |
  | `prefetch` | `20261015020000_capture_prefetch.sql`            |
  | `metrics`  | `20261015040000_capture_metrics.sql`             |
  | `single`   | `20261015050000_single_update_mode.sql`          |
  | `prune`    | `20261015060000_prune_source_responses.sql`      |
  | `options`  | `20261015070000_capture_options.sql`             |

### Dropped features

Each line says only how a dropped feature touches control flow.

- **Tenants and RLS.** Every DB transaction sets `app.tenant_id` (`internal/store/store.go:51-63`), and RLS filters rows by it.
  - In a single-user app, every "this tenant can read" check becomes "true".
  - `visible_head(c)` becomes "newest revision by `created_at DESC, id DESC`".
- **`lockTenant`.** `SELECT … FROM tenants FOR UPDATE` (`app/service.go:70-73`) serializes most mutations per tenant.
  - The rewrite still needs one writer lock around the same critical sections. SQLite's single writer gives this, but see invariant I-3: the "last asset settles finalize" rule depends on serialization.
- **Quota, reservations, rate limit and unlimited entitlement.**
  - These are `ErrQuota` and `ErrRate` checks and `reserved_bytes` / `content_reserved` bookkeeping in Submit, capture, download, reuseMedia, finalize and fail.
  - Examples: `app/service.go:312-320,347-367`, `app/worker.go:520-526,690-695`, `app/download.go:175-207,300-323`, `app/media_cache.go:43-58`.
  - All of it is dropped. **There is then no media size limit at all**, because the per-kind byte limits were already dropped in `nolimits:2-3`.
- **Tenant concurrency slots.** `slot()` (`app/worker.go:164-191`) took advisory locks to cap captures per tenant. Dropped.
- **Access control.**
  - `access_grants`: `grantAccess` (`app/worker.go:507-516`) and `revokeAccess` on PermissionDenied/NotFound (`app/worker.go:353-357`).
  - `revision_access_requirements` (`app/worker.go:677-681`).
  - `publish_revision` (`app/worker.go:666-670`) and `publish_subject` (`app/worker.go:501-506`).
  - `private_subject` / `public_subjects` validation (`app/visibility_subject.go:9-31`, called at `app/worker.go:371-378`).
  - The `check` capture mode and `CheckAccess` RPC (`app/service.go:338-340`, `app/worker.go:315-318`, `app/access.go:74-191`).
  - `has_hidden_revision`.
  - All dropped. With them, `captures.mode` is always `fetch`.
- **Visibility checks.** These are dropped together with visibility:
  - "Provider visibility does not match capture policy" (`app/worker.go:379-390`).
  - "Account source response must be private" (`app/sources.go:46-48`).
  - Public/private visibility on captures, revisions and source responses.
  - Keep the generic validation of source responses (§2.3).
- **Adapter registry and discovery.** `forAdapter` / `forURL` / `forConnection` (`app/adapters.go`), `AdapterRegistry`, `CaptureAvailable` and `ErrAdapterUnavailable`.
  - Adapter selection becomes "pick the in-process platform whose `hosts` contain the URL hostname, case-insensitive". More than one match is an error, `ambiguous adapter URL`, and no match is `ErrInvalidTarget` (`app/adapters.go:59-90`).
- **gRPC, TLS and bearer auth** to adapters (`adapter/client.go`).
  - `AdapterTLS` gates account features (`app/service.go:243`, `app/connections.go:28`); treat it as always true.
  - The 8 MiB gRPC receive limit is dropped (`adapter/client.go:40`).
- **Prometheus metrics** (`app/metrics.go`, `app/maintenance.go:16-21,171-197`). Dropped.
  - These are not the "observed metrics" (entity counts) in `app/observed_metrics.go`, which are core behavior and stay.
- **Internal channel API.** This covers `deliver`/`status` enqueueing (`app/service.go:58-64,418-423`), `capture_deliveries` (`app/worker.go:741-763`), `channel_work`, and the `chat_id` / `channel_id` / `identity_id` / `message_id` columns.
  - The Telegram bot is rebuilt separately. The hook points are "capture reached a terminal state" (§3.10, `deliveries`) and "submission created".

---

## 1. Data model (final schema after all migrations)

The schema was PostgreSQL. **[MT]** marks columns that exist only for multi-tenancy, visibility, quota or channel delivery and will be dropped. IDs are UUIDs; the plan keeps them as text.

### 1.1 Table map

| table                                                                                                                                                                                                                         | role                                                                                                    | kept?                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `collections`                                                                                                                                                                                                                 | One row per adapter object (post, profile) identified by `(platform, kind, object_scope, external_id)`. | yes                                                |
| `collection_identity_aliases`                                                                                                                                                                                                 | Maps an alternate external id (such as `handle:foo`) to the canonical collection.                       | yes                                                |
| `captures`                                                                                                                                                                                                                    | One fetch job of a collection. Also the "job" users see.                                                | yes                                                |
| `revisions`                                                                                                                                                                                                                   | Immutable content snapshot of a collection, produced by exactly one capture.                            | yes                                                |
| `revision_entities`, `entity_relations`                                                                                                                                                                                       | Entity graph of a revision.                                                                             | yes                                                |
| `entities`, `entity_versions`                                                                                                                                                                                                 | Global entity identities and their content-hash-deduplicated versions.                                  | yes                                                |
| `assets`                                                                                                                                                                                                                      | A media item of a capture at a position.                                                                | yes                                                |
| `blobs`                                                                                                                                                                                                                       | Stored media bytes, deduplicated by sha256.                                                             | yes                                                |
| `blob_thumbnails`                                                                                                                                                                                                             | One thumbnail result per blob.                                                                          | yes                                                |
| `objects`                                                                                                                                                                                                                     | Ledger of object-store keys, used for GC.                                                               | yes; simpler with content-addressed keys, see §4.6 |
| `source_responses`                                                                                                                                                                                                            | Raw upstream responses per capture.                                                                     | yes                                                |
| `submissions`                                                                                                                                                                                                                 | A request for a capture: user input, a member of a collection, or a continuation page.                  | yes                                                |
| `refresh_batches`                                                                                                                                                                                                             | Batch refresh of many saved collections.                                                                | yes                                                |
| `tenant_collections`                                                                                                                                                                                                          | "Saved in the library" plus note and the source used to save.                                           | **table dropped, semantics kept**, see §1.2.14     |
| `tags`, `collection_tags`                                                                                                                                                                                                     | Tags on saved collections.                                                                              | yes, without `tenant_id`                           |
| `connections`, `account_credentials`, `tenant_preferences`                                                                                                                                                                    | Accounts, encrypted credentials, and the per-adapter account selection.                                 | yes, without `tenant_id`                           |
| `tenants`, `tenant_entitlements`, `tokens`, `web_sessions`, `access_grants`, `revision_access_requirements`, `channels`, `identities`, `inbox`, `replies`, `channel_work`, `channel_media_cache`, `config`, `schema_versions` | —                                                                                                       | dropped. `config` becomes env vars (§1.4).         |

### 1.2 Tables

#### 1.2.1 `collections`

| column                                                           | type                         | notes                                                                                                                       |
| ---------------------------------------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                             | uuid PK                      | `init:655`                                                                                                                  |
| `platform`, `kind`, `object_scope` (default `''`), `external_id` | text NN                      | The identity. UNIQUE `collections_identity_key (platform, kind, object_scope, external_id)` (`shared:594`).                 |
| `url`                                                            | text NN                      | Canonical URL from Resolve, later updated to `CanonicalTarget.url`.                                                         |
| `provider_id`                                                    | text NN                      | Provider of the first submission that created the row. Informational.                                                       |
| `current_revision`                                               | uuid null                    | FK `(id, current_revision) → revisions(collection_id, id)` (`shared:595`). Set on every new revision (`app/worker.go:686`). |
| `unreferenced_at`                                                | timestamptz null             | GC clock. Set by `mark_unreferenced` when nothing saves the collection; cleared when a submission targets it.               |
| `created_at`, `observed_at`                                      | timestamptz NN default now() | `observed_at = now()` at every finalize (`app/worker.go:703`). It drives the freshness window (§3.2 step 11).               |
| `source_state`                                                   | text null                    | CHECK `IN ('deleted','suspended')`, plus `source_state_at` with CHECK that both are null or both are set (`srcstate:5-7`).  |

- Index `(platform, kind, object_scope, external_id, observed_at DESC, id DESC)` (`aliasidx:2`) and a partial index on `unreferenced_at` (`lookup:11`).
- **[MT] dropped earlier:** `tenant_id`, `visibility`, `scope`, `data_scope` (`shared:589-593`).

**Lifecycle**

- **Created** by Submit's upsert `INSERT … ON CONFLICT (identity) DO UPDATE SET unreferenced_at = collections.unreferenced_at RETURNING id`. This is a no-op update that returns the id (`app/service.go:299`).
- **Created** also when a canonical target appears (`app/capture_scope.go:33`).
- **Deleted** only by retention GC (§6.6).

#### 1.2.2 `collection_identity_aliases`

- **Columns:** `platform, kind, object_scope, external_id` (PK) and `collection_id` (FK → collections ON DELETE CASCADE) (`alias:9-14`, `shared:671`).
- **Written only** in `resolveCaptureScope` when a fetch returns a canonical id that differs from the requested one. It stores the requested external id → canonical collection, with `ON CONFLICT (pk) DO UPDATE SET collection_id = excluded.collection_id` (`app/capture_scope.go:38-41`).
- **Read** when linking entities to saved collections (§6.1) and by the library's related-collection filters.
- **[MT] dropped:** `tenant_id`, `visibility`, `scope`, `data_scope` (`shared:666-670`).

#### 1.2.3 `captures`

| column                                                                           | type / default        | meaning                                                                                                                                                                      |
| -------------------------------------------------------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                             | uuid PK               | Exposed as the "job id".                                                                                                                                                     |
| `collection_id`                                                                  | uuid NN FK            | Can be moved to a canonical collection while still `queued` (`app/capture_scope.go:47-51`).                                                                                  |
| `provider_id`, `adapter_id`                                                      | text NN               | —                                                                                                                                                                            |
| `connection_id`                                                                  | uuid null             | The account used. Null means the anonymous provider.                                                                                                                         |
| `credential_revision`                                                            | bigint null           | `connections.revision` used at fetch time (`app/worker.go:498`). Later steps abort if it changed (§6.5).                                                                     |
| `refresh_from`                                                                   | uuid null             | The `RefreshID` collection this capture refreshes (no FK).                                                                                                                   |
| `scope`                                                                          | text NN               | **Access scope** sent to the adapter: `public` or `connection:<connection uuid>` (`app/service.go:263-266`). The X adapter validates it (`x/server.ts:160-174`), so keep it. |
| `state`                                                                          | text default `queued` | CHECK `IN ('queued','downloading','complete','partial','failed')` (`init:633`).                                                                                              |
| `error`                                                                          | text default `''`     | Failure message shown to users (§7).                                                                                                                                         |
| `payload`                                                                        | jsonb null            | Staged `Payload` (§3.6.1) between capture and finalize. Set to NULL at finalize or fail.                                                                                     |
| `adapter_version`                                                                | text default `''`     | —                                                                                                                                                                            |
| `created_at`, `finished_at`                                                      | timestamptz           | `finished_at` is set at complete, partial or failed.                                                                                                                         |
| `revision_id`                                                                    | uuid null             | The revision this capture produced **or reused**. FK `(collection_id, revision_id) → revisions(collection_id, id)` (`shared:603`).                                           |
| `automatic`                                                                      | bool default false    | Created by a related-target fan-out. Never expands collections.                                                                                                              |
| `related_targets`                                                                | jsonb default `[]`    | `FetchResponse.related_targets` as stored JSON. The `prefetch` keys are removed after fan-out (`app/related.go:221`).                                                        |
| `page_size`                                                                      | int default 0         | Requested target size for a collection page.                                                                                                                                 |
| `page_cursor`                                                                    | text default `''`     | Cursor this capture fetched (≤4096).                                                                                                                                         |
| `next_page_cursor`                                                               | text default `''`     | Cursor returned by the adapter. Empty means the end.                                                                                                                         |
| `is_collection`                                                                  | bool default false    | `target.Collection && !automatic` (`app/service.go:374`).                                                                                                                    |
| `max_batch_size`                                                                 | int default 0         | From the adapter. Must be ≥1000 for "more1000".                                                                                                                              |
| `paused`                                                                         | bool default false    | Paused captures' tasks snooze for 1 min (`app/worker.go:46-52,860-875`). **Nothing in the code sets it**; it is vestigial.                                                   |
| `mode`                                                                           | text default `fetch`  | CHECK `IN ('fetch','check')`. `check` is dropped.                                                                                                                            |
| `prefetch`                                                                       | bytea null            | Prefetch from the listing that created this automatic capture (`prefetch:5`). Cleared at capture commit (`app/worker.go:498`) and at fail (`app/worker.go:811`).             |
| `metrics`                                                                        | jsonb null            | Observed counts of this capture: `{ "<entityType>/<externalId>": { "/json/pointer": <value> } }` (`metrics:5`, `app/worker.go:700`).                                         |
| `visibility`, `content_reserved`, `restricted_targets`, `subject_*`, `tenant_id` | —                     | **[MT]**.                                                                                                                                                                    |

- **UNIQUE partial `one_active_capture`** (`shared:674-680`): `(collection_id, adapter_id, provider_id, coalesce(connection_id, <public-zero-uuid or tenant>), md5(page_cursor), page_size, automatic, mode) WHERE state IN ('queued','downloading')`.
  - Single-user equivalent: `(collection_id, adapter_id, provider_id, coalesce(connection_id,''), page_cursor, page_size, automatic) WHERE state IN ('queued','downloading')`.
- **Index** `captures_latest_metrics (collection_id, finished_at DESC, id DESC) WHERE metrics IS NOT NULL AND state IN ('complete','partial')` (`metrics:7-9`).

**Lifecycle**

- Inserted by Submit (§3.2).
- `queued` → `downloading` at capture commit.
- `downloading` → `complete`/`partial` at finalize.
- `queued`/`downloading` → `failed` via `failCaptureTx`.
- Deleted only by collection GC.

#### 1.2.4 `revisions`

- **Columns:**
  - `id`
  - `collection_id`
  - `capture_id` (UNIQUE, `shared:608`)
  - `content_hash` (text, sha256 hex of the revision signature, §3.6.3)
  - `payload` (jsonb, the full `Payload` with graph and ids)
  - `content_bytes` (= byte length of the payload JSON)
  - `created_at`
- **FK** `(collection_id, capture_id) → captures(collection_id, id)` (`shared:609`).
- **Index** `revisions_head (collection_id, created_at DESC, id DESC)` (`shared:686`). "Head" always means newest by `created_at DESC, id DESC`.
- **[MT]:** `visibility` and `subject_*`.
- **Lifecycle:** inserted only by finalize when content differs from the head (§3.6). Never updated in single-user. Deleted by collection GC, which cascades to `revision_entities` and `entity_relations`.

#### 1.2.5 `revision_entities`

- **Columns:** `revision_id` (FK ON DELETE CASCADE), `entity_key` (local graph key), `entity_version_id` (FK → entity_versions) and `is_root` bool.
- **PK** `(revision_id, entity_key)`.
- **UNIQUE partial** `(revision_id) WHERE is_root`: exactly one root (`init:1133,1206-1208,1370-1373`).

#### 1.2.6 `entity_relations`

- **Columns:** `revision_id`, `source_key`, `target_key`, `kind`.
- **PK** `(revision_id, source_key, kind, target_key)`.
- **FKs** `(revision_id, source_key)` and `(revision_id, target_key)` → `revision_entities` ON DELETE CASCADE (`init:1085`, `shared:653-654`).

#### 1.2.7 `entities`

- **Columns:** `id`, `platform`, `kind` (= entity **type**, for example `x.post`), `external_id` and `observed_at`.
- **UNIQUE** `(platform, kind, external_id)`. Note that this identity has **no `object_scope`** (`shared:637`).
- **Lifecycle:** upserted at every finalize, where `ON CONFLICT DO UPDATE SET observed_at = now()` (`app/entities.go:141`). Deleted by GC when no versions remain.

#### 1.2.8 `entity_versions`

- **Columns:** `id`, `entity_id` (FK ON DELETE CASCADE), `content_hash`, `data` (jsonb, entity data **with metric paths removed**), `schema` (jsonb, the full JSON Schema of the type) and `created_at`.
- **UNIQUE** `(entity_id, content_hash)` (`init:1091`).
- **Lifecycle:**
  - Created by `ensure_entity_version` (§1.3).
  - **Data is never overwritten on a hash hit.**
  - Deleted by GC when no `revision_entities` reference it.

#### 1.2.9 `assets`

| column                  | notes                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `id`, `capture_id` (FK) | —                                                                                                                  |
| `position`              | Index into the capture's **kept** resources. UNIQUE `(capture_id, position)`.                                      |
| `source_url`            | Download URL from the adapter.                                                                                     |
| `purpose`               | Default `''`, CHECK `length ≤ 128`. `''` means content media. Otherwise it is a role such as `avatar` or `banner`. |
| `alt_text`, `sensitive` | From the resource.                                                                                                 |
| `cache_key`             | `''`, or the sha256 of `JSON(["<platform>", immutable_key])` (`app/worker.go:533-537`).                            |
| `kind`                  | CHECK `IN ('image','video')`.                                                                                      |
| `state`                 | Default `pending`, CHECK `IN ('pending','ready','failed')`.                                                        |
| `error`                 | —                                                                                                                  |
| `blob_id`               | FK → blobs, set when ready.                                                                                        |
| `object_id`             | FK → objects, the upload slot reserved for this download.                                                          |
| `reserved_bytes`        | **[MT]**.                                                                                                          |

- **Indexes:** `assets_cache (cache_key) WHERE state='ready' AND cache_key<>''` (`shared:682-684`), `(blob_id)` and `(object_id)`.
- **Lifecycle:**
  - Inserted at capture commit, one per kept resource (`app/worker.go:530-545`).
  - `pending` → `ready` (download or cache reuse).
  - `pending` → `failed` (download fail, or the capture failing).
  - Deleted by collection GC.

#### 1.2.10 `blobs`

- **Columns:** `id`, `hash` (sha256 hex, UNIQUE `shared:624`), `object_key` (UNIQUE), `size` and `mime`.
- **Lifecycle:**
  - Inserted on the first download of new bytes (`app/download.go:295`).
  - Deleted by collection GC when no asset references it, which also marks its object as garbage.

#### 1.2.11 `blob_thumbnails`

- **Columns:**
  - `blob_id` (PK, FK ON DELETE CASCADE)
  - `state` (CHECK `IN ('ready','failed')`)
  - `object_key` (UNIQUE)
  - `size`, `mime`
  - `error` (default `''`)
  - `created_at`
- **CHECK** `(state='ready') = (object_key, size, mime all NOT NULL)` (`thumbs:5-12`).
- **Trigger** `discard_thumbnail_object`: AFTER DELETE with a non-null `object_key` → `UPDATE objects SET state='garbage' WHERE object_key = OLD.object_key` (`thumbs:24-45`).
- **Effect of a `failed` row:** it is permanent and stops all further attempts.

#### 1.2.12 `objects`

- **Columns:**
  - `id`
  - `object_key` (UNIQUE)
  - `state` (CHECK `IN ('pending','attached','garbage','deleting')`)
  - `created_at`
  - `gc_attempts` (default 0)
  - `gc_after`
  - `uploaded_by` **[MT]**
- **Lifecycle:** see §4.6. Go keys are `objects/<random uuid>` (`app/download.go:121`, `app/thumbnail.go:165`).

#### 1.2.13 `source_responses`

- **Columns:**
  - `id`, `capture_id` (FK ON DELETE CASCADE), `position`
  - `body` (bytea; CHECK `size = octet_length(body)`)
  - `content_type`, `source_url`
  - `sha256` (hex of the body)
  - `size`
  - `unreferenced_at`, `created_at`
  - `tenant_id` and `visibility` **[MT]**
- **UNIQUE** `(capture_id, position)` (`init:881-894,1154`).
- **Lifecycle:**
  - Inserted at capture commit, with `ON CONFLICT (capture_id, position) DO NOTHING` (`app/sources.go:57-68`).
  - Deleted when the capture fails (`app/worker.go:808`).
  - Deleted by superseded-raw pruning (§6.6) and by collection GC (cascade).
  - `unreferenced_at` is only for private raw of unsaved collections ([MT]). In single-user, raw lives as long as its capture.

#### 1.2.14 `tenant_collections` (the "saved" relation): table dropped, semantics needed

- **Columns:**
  - `tenant_id` [MT], `collection_id` (PK `(tenant_id, collection_id)`)
  - `provider_id`, `connection_id`, `adapter_id`: the source used to save it, reused by refresh
  - `created_at`: the save time, used for Recent ordering and the DeleteAll cutoff
  - `note` (CHECK `char_length ≤ 10000`, `annot:2`)
- **Trigger** `private_source_retention` [MT] (`init:1247`).

What "saved" means and where it is used. A single-user port needs an equivalent, for example `collections.saved_at` plus `note`, `source_provider_id`, `source_connection_id` and `source_adapter_id`.

- **Becomes saved:**
  - Every successful Submit of a non-refresh request, **including automatic related children** (`app/service.go:308`, with the condition `WHERE $RefreshID='' OR $RefreshID = collection_id`). Members of a profile page and referenced profiles all become saved library entries.
  - A canonical move copies the save to the canonical collection when the old one was saved (`app/capture_scope.go:52`).
  - The related task re-saves the moved collection (`app/related.go:96`).
  - `SavePublicCollection` (`app/shared_save.go:14-72`) does the same.
- **Becomes unsaved:**
  - `DeleteCollection` and `DeleteAll` (§6.4).
  - A staging collection that has no `current_revision` after a canonical move (`app/capture_scope.go:63`, `app/related.go:106`, `app/worker.go:713`).
- **Uses of "saved":**
  - Records `Saved` (§5.4).
  - `SavedCollectionID` linking (§6.1).
  - `mark_unreferenced` / GC eligibility (§6.6).
  - Refresh requires saved (`app/service.go:153-163`).
  - `RetryCaptureRecord` re-saves via a new capture if unsaved (`app/capture_records.go:366-368`).
  - The related task's `held` check (`app/related.go:86-92`).

#### 1.2.15 `submissions`

| column                                                                                                                   | meaning                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `capture_id` (FK)                                                                                                  | The capture this request is attached to. **Many submissions can share one capture** (coalescing). A submission can also point to an old finished capture (reuse). |
| `idem_key`                                                                                                               | UNIQUE `(tenant_id, idem_key)`. In single-user it is UNIQUE `(idem_key)`. Its prefixes have meaning (§3.2.3).                                                     |
| `fingerprint`                                                                                                            | sha256 of the request identity (§3.2.3).                                                                                                                          |
| `input`                                                                                                                  | The raw user input. It defaults to the URL if empty (`app/service.go:206-208,270-272`). `''` only for channel "show" rows.                                        |
| `created_at`                                                                                                             | —                                                                                                                                                                 |
| `related_provider`, `related_connection`, `related_adapter`, `related_source_collection`                                 | The source to use for fan-out, and the collection at submit time.                                                                                                 |
| `related_state`                                                                                                          | Default `none`. Values `none` \| `pending` \| `complete` \| `failed` (no CHECK).                                                                                  |
| `related_error`                                                                                                          | —                                                                                                                                                                 |
| `collection_limit`                                                                                                       | Remaining member budget for this page (0 means unlimited when options are set; see §5.2).                                                                         |
| `next_submission`                                                                                                        | The continuation page submission (FK, same tenant).                                                                                                               |
| `collection_stopped`                                                                                                     | bool.                                                                                                                                                             |
| `parent_submission`                                                                                                      | FK ON DELETE SET NULL. Set for members and references (fan-out). Not set for "more" pages, which are new records.                                                 |
| `capture_options`                                                                                                        | jsonb `CaptureOptions` (`options:2`).                                                                                                                             |
| `state`, `progress`, `status_text`, `error`, `message_id`, `reply_to_message_id`, `identity_id`, `channel_id`, `chat_id` | **[MT/channel]**. Telegram delivery state.                                                                                                                        |

- **Index** `submission_records (tenant_id, created_at DESC, id DESC) WHERE parent_submission IS NULL AND input <> ''` (`records:4-5`). These are the capture records.
- **Lifecycle:**
  - Inserted by Submit.
  - `capture_id` is rewritten when a capture joins a running canonical capture (`app/capture_scope.go:95`).
  - `idem_key` is renamed to `retried:<id>` when a failed member is retried (`app/batch.go:302`).
  - Deleted by DeleteAll (cutoff) and by collection GC (all submissions of the collection's captures).

#### 1.2.16 `refresh_batches`

- **Columns:**
  - `id`, `tenant_id` [MT]
  - `collection_ids` uuid[] (CHECK cardinality 1..500)
  - `position`, `reused`, `rejected`: int, default 0
  - `capture_ids` uuid[] (default `{}`)
  - `state` (default `running`, CHECK `IN ('running','complete','failed')`)
  - `error`, `created_at`
  - `channel_id` / `chat_id` [channel] (`batch:9-24`, `batchmsg:4-6`)
- `update_mode` was added and later dropped (`single:4-7`). The API still accepts `update_mode` values `''`, `full` and `append` and ignores them (`internal/httpapi/server.go:469-471`).

#### 1.2.17 `tags` and `collection_tags`

- **`tags`:** `(tenant_id [MT], id)` PK, `name` with CHECK `char_length BETWEEN 1 AND 64 AND name = btrim(name)`, UNIQUE `(tenant_id, name)` (`annot:5-9`).
- **`collection_tags`:** `(tenant_id, collection_id, tag_id)` PK.
  - FK to the saved row ON DELETE CASCADE, so unsaving drops the tag links.
  - FK to tags ON DELETE CASCADE (`annot:13-18`).
- **Pruning:** tags without any `collection_tags` row are deleted after every annotation update and every delete (`app/annotations.go:52-55`).

#### 1.2.18 `connections`, `account_credentials` and `tenant_preferences`

- **`connections`** (`init:719-731`):
  - `id`, `tenant_id` [MT], `adapter_id`, `provider_id`
  - `name` (1–100 bytes), `account_id`, `username`
  - `state` (CHECK `IN ('pending','ready','reauth_required','revoked')`)
  - `credential_ref` (→ account_credentials)
  - `revision` (bigint, default 1)
  - **UNIQUE partial** `(tenant_id, adapter_id, provider_id, account_id) WHERE state <> 'revoked' AND account_id IS NOT NULL AND account_id <> ''` (`init:1217-1218`).
- **`account_credentials`:** `id`, `tenant_id` [MT], `ciphertext` bytea (`init:533-537`).
- **`tenant_preferences`:** `(tenant_id [MT], adapter_id)` PK → `default_connection_id` (null means the anonymous provider) (`init:948-952`). This is the per-platform account selection.

### 1.3 SQL functions that carry business logic

**`ensure_entity_version(eid, body, data, schema)`** (`shared:828-841`)

```sql
INSERT INTO entity_versions(entity_id, content_hash, data, schema)
VALUES (eid, encode(digest(body::text,'sha256'),'hex'), data, schema)
ON CONFLICT (entity_id, content_hash) DO UPDATE SET content_hash = excluded.content_hash
RETURNING id
```

- The hash covers `body`, which the caller builds as `[data, schema, media]` (§3.12), not `data` alone.
- `body::text` is PostgreSQL's canonical jsonb text.
- On a hit, the existing row is returned unchanged.

**`visible_head(cid)`** (`shared:810-825`)

- The newest revision by `created_at DESC, id DESC` that is readable under RLS.
- In single-user, this is simply the head.

**`mark_unreferenced(aid)`** (`shared:1040-1058`)

- `UPDATE collections SET unreferenced_at = coalesce(unreferenced_at, now()) WHERE id = aid AND NOT EXISTS (saved row)`.
- It starts the GC clock and **never resets an existing clock**.

**`collect_unreferenced_collections(grace)`** (`maint:4-189`). It returns the number of removed collections.

- **Candidates:** up to 100 collections with `unreferenced_at < now() - grace`, oldest first, skipping locked rows. A collection is excluded if any of these holds:
  - it is saved again;
  - it has a capture in `queued`/`downloading`;
  - it has a pending chat delivery [channel].
- The conditions are re-checked after locking.
- **Per collection, in this order:**
  1. Remember its assets' blob ids.
  2. Set `current_revision` to NULL.
  3. Set `captures.revision_id` to NULL.
  4. Delete all submissions of its captures.
  5. Set objects referenced by its assets from `pending` to `garbage`.
  6. Delete its assets.
  7. Delete its revisions (this cascades).
  8. Delete its captures (this cascades to source_responses).
  9. Delete the collection (this cascades to aliases).
- **Then, globally:**
  - [MT] Delete private unreferenced source responses.
  - Delete entity versions that no revision references.
  - Delete entities with no versions.
  - Delete candidate blobs that no asset references any more. Their objects become `garbage`, and their thumbnails cascade, which fires the trigger.

**`prune_source_responses(age, n)`** (`prune:6-53`)

- **Selects up to n captures** that meet all of:
  - they have source responses;
  - `state IN ('complete','partial')`;
  - `finished_at < now() - age`;
  - **no revision has `capture_id` = this capture**, meaning it produced no new version;
  - another `complete`/`partial` capture of the same collection is newer by `(finished_at, id)`.
- **Effect:** deletes all their source responses and returns the count of distinct captures.

**`claim_garbage_objects(grace, n)`** (`maint:197-229`)

- Sets `state='deleting'` on up to n rows that meet all of:
  - `state IN ('garbage','deleting')`;
  - `created_at < now() - grace` (**creation time**, not the time the row became garbage);
  - `gc_after IS NULL OR gc_after <= now()`.
- Ordered by `created_at`, skipping locked rows.

**`finish_garbage_object(oid)`** (`shared:1095-1110`)

- `UPDATE assets SET object_id = NULL WHERE object_id = oid`, then delete the objects row if it is still `deleting`.

**`defer_garbage_object(oid)`** (`maint:231-245`)

- `gc_attempts += 1; gc_after = now() + least(1 min × 2^least(old_attempts, 20), 1 day)`.
- The backoff runs 1, 2, 4… minutes and is capped at 1 day.

**`stale_captures(age, n)`** (`maint:253-289`)

- Captures that meet all of:
  - `queued`/`downloading`;
  - `created_at < now() - age`;
  - no live River job (`available`, `pending`, `retryable`, `running`, `scheduled`) of kind `monitor_task` whose `args.id` is the capture id **or one of its asset ids**.

**`blobs_missing_thumbnails(n)`** (`thumbs:49-83`)

- Blobs with no `blob_thumbnails` row, up to n.

**`cached_blob(key)`** (`shared:923-945`)

- The blob of **any** `ready` asset with `cache_key = key`, LIMIT 1 with no ordering.

**Dropped [MT] functions:**

- `publish_revision`, `publish_subject`, `tenant_usage`, `tenant_unlimited`, `tenant_can_read_*`, `access_requirements`, `has_hidden_revision`, `capture_deliveries`, `claim_channel_work`, `resolve_identity`.
- `cleanup_web_sessions` belongs to web sessions, not capture.

### 1.4 Configuration (Go `config` table, `init:1721-1739`)

These become env vars or constants.

| key                                                        | default   | used for                                                                                               |
| ---------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `max_media`                                                | 20        | `Config.MaxMedia`: maximum content resources (`purpose == ''`) kept per capture (`app/service.go:39`). |
| `connection_concurrency`                                   | 1         | Concurrent account-using captures per connection (`app/worker.go:220`).                                |
| `capture_workers` / `download_workers` / `control_workers` | 4 / 8 / 4 | Queue concurrency (`internal/runtime/role.go:9-11`).                                                   |
| `collection_retention_days`                                | 7         | Grace before an unsaved collection is physically removed. The plan removes this, see §6.4.             |
| `object_gc_grace_hours`                                    | 24        | Minimum object age before deletion.                                                                    |
| `capture_rate`, `tenant_quota_bytes`, `tenant_concurrency` | —         | [MT] dropped.                                                                                          |

---

## 2. Adapter contract

The TS rewrite already calls platforms in-process. The interface is `Platform` with `description`, `resolve`, `fetch`, `prepareCredential` and `checkConnection` (`server/src/platforms/platform.ts`). Errors are still gRPC status codes plus string trailers, carried by `ProviderFailure { code, metadata }` (`server/src/platforms/rpc.ts`). `CheckAccess` is dropped. The field semantics below are from `api/adapter/v1/adapter.proto`.

### 2.1 Describe → `DescribeResponse` (`adapter.proto:44-53`)

**Fields**

- `protocol_version`: strict `major.minor` with major 1 (`adapter/protocol.go:25,42-52`).
- `adapter_id`: non-empty. Used as `captures.adapter_id`, the account-selection key and the platform id in the UI.
- `version`
- `hosts`: unique case-insensitively. These route URLs to the adapter.
- `display_name`: falls back to `adapter_id` (`app/channel_actions.go:326-331`).
- `entity_types[]`: `{ name, json_schema bytes, metric_paths[] }`.
- `providers[]`: `{ id, authentication ("none" | "session"), visibilities[], capabilities[] {name, major, minor}, entity_types[], default_provider, credential_help }`.

**Validation rules** (`adapter/protocol.go:38-102`, `adapter/entities.go:33-92`, `adapter/metrics.go:13-125`)

- Provider ids are unique and non-empty.
- At most one `default_provider` per `authentication` value.
- A capability needs a non-empty name and major ≥ 1, unique per `name/major`.
- A provider with `capture.fetch` must declare ≥1 visibility, each PUBLIC or PRIVATE with no duplicates.
- Entity types:
  - at most 128 types;
  - names match `^[a-z][a-z0-9_.-]{0,127}$` (the same regex validates graph keys and relation types);
  - schema ≤ 256 KiB, a JSON object with `$schema == "https://json-schema.org/draft/2020-12/schema"`, compiled with format assertion and **no external `$ref`** ("entity schemas must be self-contained");
  - at most 32 `metric_paths`, each starting with `/`, ≤200 chars, with no `//`.
- Provider `entity_types` must be declared and unique.
- A provider with `entity.graph` must list ≥1 entity type.
- **`Supports(provider, name, major, minor)`** is true when a capability has the same name, equal major and minor ≥ the requested minor (`adapter/protocol.go:29-36`). The core always asks for major 1, minor 0.

**Capabilities the core checks**

| name                                                       | effect                                                                                                                                                                         |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capture.fetch`                                            | The provider can capture. Submit and capture require it (`app/service.go:185`, `app/worker.go:295`).                                                                           |
| `capture.related`                                          | `related_targets` is allowed. Without it a non-empty list is a permanent error (`app/related.go:28-30`), and Submit does not schedule a `related` task (`app/service.go:397`). |
| `capture.page`                                             | `next_page_cursor`, `max_batch_size`, `page_size` and `page_cursor` are allowed (`app/related.go:20-22`, `app/service.go:203`).                                                |
| `capture.canonical`                                        | `canonical_target` is allowed (`app/related.go:23-27`).                                                                                                                        |
| `capture.prefetch`                                         | `RelatedTarget.prefetch` is allowed, at most 64 KiB (`app/related.go:39-41`).                                                                                                  |
| `credential.deferred`                                      | First fetch without the credential (§3.4).                                                                                                                                     |
| `credential.prepare`, `connection.check`                   | Account import (§6.5).                                                                                                                                                         |
| `entity.graph`                                             | The graph's entity types must come from providers that declare `entity.graph` (`app/entities.go:48-55`).                                                                       |
| `capture.access`                                           | Dropped.                                                                                                                                                                       |
| `content.text`, `source.raw`, `media.image`, `media.video` | Declared by X but ignored by the core.                                                                                                                                         |

**Concrete descriptors**

- **X** (`x/server.ts:77-132`): `adapterId "x"`, `displayName "X"`, version `0.4.0`. Providers:
  - `fxtwitter`: default, `authentication: none`, visibility PUBLIC.
  - `x-session`: default, `authentication: session`, visibilities PUBLIC and PRIVATE; adds `capture.access`, `connection.check`, `credential.prepare`, `credential.deferred`. Its `credentialHelp` is `Base64 Cookie，需包含 auth_token 和 ct0。`.
- **Instagram** (`ig/server.ts:79-107`): `adapterId "instagram"`. One provider, `instagram-session`: default, `authentication: session`, visibility PRIVATE, with `credential.deferred`. There is **no anonymous provider**, so anonymous submission gives `ErrAccountRequired` (§3.2 step 3).

### 2.2 Resolve(url) → `ResolveResponse` (`adapter.proto:159-168`)

- **Fields:** `url` (canonical), `platform`, `kind`, `object_scope`, `external_id`, `collection` (an explicit capture expands members) and `refresh_on_submit` (explicit submissions always refetch).
- **Core behavior** (`app/discovery.go:70-109`):
  - First generic validation: `http`/`https`, non-empty host, no userinfo; otherwise `ErrInvalidTarget` (`internal/domain/domain.go:33-39`).
  - Adapter INVALID_ARGUMENT → `ErrInvalidTarget`.
  - A response with an invalid `url`, or empty `platform`/`kind`/`external_id`, gives `adapter returned invalid target`.
  - A 5 s timeout over gRPC (dropped in-process).
- **X** (`x/resolve.ts:18-89`):
  - **Hosts:** `x.com`, `twitter.com`, each with `www.` and `mobile.`; and `fxtwitter.com`, `fixupx.com`, each with `www.`, `d.`, `dl.`, `g.` and `t.`.
  - On mirror hosts a trailing language segment after `/status/<id>[/photo|video/<n>]` is stripped.
  - Ports and userinfo are rejected.
  - **Post:** `/<user>/status/<id>[/(photo|video)/<n>]` or `/i/web/status/<id>` gives `url = https://x.com/<user or i/web>/status/<id>`, `platform x`, `kind post`, `externalId <id>`, `collection=false`, `refresh=false`. The query string is dropped.
  - **Profile:** `/i/user/<id>` gives `externalId <id>`. `/<handle>` (1–15 chars, lowercased, not reserved: home, explore, search, settings, messages, notifications, compose, intent, share, i, login, logout, signup, tos, privacy, about, jobs, download) gives `externalId "handle:<handle>"`. Both have `kind profile`, `collection=true`, `refreshOnSubmit=true`.
- **Instagram** (`ig/resolve.ts:6-75`):
  - **Hosts:** `instagram.com`, `www.`, `m.`.
  - **Post:** `/(p|reel|tv)/<shortcode>` gives `url https://www.instagram.com/p/<shortcode>/`, `kind post`, and `externalId` = the decimal media pk decoded from the shortcode.
  - **Profile:** `/<handle>` (pattern `^[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?$`, no `..`, not reserved) gives `externalId "handle:<handle>"`, `collection` and `refresh` true.

### 2.3 Fetch

**`FetchRequest`** (`adapter.proto:55-71`, filled at `app/worker.go:325`)

- `url`, `external_id`, `platform`, `kind`, `object_scope`: from the collection.
- `provider_id`, `connection_id`, `access_scope`: from the capture (`public` or `connection:<id>`).
- `request_id`: the capture id.
- `credential`: decrypted bytes, or absent.
- `credential_deferred`: true when the credential is withheld (§3.4).
- `page_size`, `page_cursor`, `automatic`.
- `prefetch`: `captures.prefetch`.

**`FetchResponse`** (`adapter.proto:129-155`)

| field                                                                                                                                           | core rule                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `external_id`, `provider_id`                                                                                                                    | Must equal the request's values, otherwise the permanent error `adapter returned mismatched identity` (`app/worker.go:365-367`). The **requested** id is echoed even when canonical differs. |
| `text`, `text_kind`, `text_source`, `summary`, `author_name`, `published_at` (RFC 3339 or empty), `warnings[]`, `adapter_version`, `incomplete` | Copied into the Payload. `text` must be ≤ 1 MiB, otherwise `text exceeds collection limit` (`app/worker.go:391-393`). `incomplete` makes the capture `partial`.                              |
| `resources[]`                                                                                                                                   | Media descriptors (§2.5).                                                                                                                                                                    |
| `graph`                                                                                                                                         | Entity graph (§2.4).                                                                                                                                                                         |
| `source_responses[]`                                                                                                                            | `{ body, content_type, source_url, visibility }`, §4.7.                                                                                                                                      |
| `canonical_target`                                                                                                                              | ResolveResponse. Requires `capture.canonical`; must have the same platform, kind and object_scope, a non-empty external id and a valid URL (`app/related.go:23-27`).                         |
| `related_targets[]`                                                                                                                             | ≤512, otherwise `related capture page exceeds 512 targets`. Each needs a valid URL. See §2.6.                                                                                                |
| `next_page_cursor`                                                                                                                              | ≤4096 bytes. Empty means the end.                                                                                                                                                            |
| `max_batch_size`                                                                                                                                | ≤1000. A non-zero value requires `capture.page`.                                                                                                                                             |
| `visibility`, `restricted_targets`, `private_subject`, `public_subjects`                                                                        | [MT], dropped.                                                                                                                                                                               |

### 2.4 Entity graph format and validation (`app/entities.go:18-114`)

**Shape:** `graph = { root: key, entities: [{ key, type, external_id, data_json, resource_indices[], context_only }], relations: [{ source, target, type }] }`.

**Validation.** Every violation is a **permanent** error with the quoted message.

- 1–512 entities and ≤1024 relations: `invalid entity graph size`.
- Each entity must satisfy all of the following, or the error is `invalid entity identity or undeclared type`:
  - its key matches the entity-name regex and is unique;
  - its type is allowed for the responding provider (`entity.graph`);
  - its `external_id` is non-empty, ≤200 bytes and has no NUL;
  - `(type, external_id)` is unique within the graph;
  - the **root may not be `context_only`**.
- Cumulative `len(data_json) + len(schema JSON)` must be ≤ 2 MiB: `entity graph exceeds limit`.
- Data must validate against the type's schema: `entity data does not match adapter schema`. Big-integer precision is preserved.
- Resource indices must be in range and unique per entity: `invalid entity resource reference`.
- The root entity's `external_id` must equal `canonical_target.external_id` if present, else the response `external_id`: `entity root does not match capture identity`.
- The root key must exist: `missing entity root`.
- Relations need existing source and target keys and a type matching the name regex: `invalid entity relation`. No duplicate `(source, type, target)`: `duplicate entity relation`.

**Normalization**

- Metric values are split out of `data` at the type's `metric_paths` (§3.6.4).
- Entities are sorted by key, and relations by `source|type|target`, because local order is not content (`app/entities.go:107-112`).
- Each core entity gets the type's schema JSON attached, plus the `Metrics`/`MetricPaths` in memory.

**Meaning of `context_only`:** a non-root entity is snapshotted and versioned, but its data, its media and the generic `author_name`/`summary` do not count toward the collection revision (§3.6.3).

**Entity types and relations emitted**

- **X post** (`x/entities.ts:128-190`):
  - Root `post` (`x.post`, owns all content resources).
  - `author` (`x.profile`, **context_only**, owns the avatar resource).
  - `authored_by post→author`.
  - `mentions` edges from post and author.
  - `reposted` from a reposting profile to the post.
  - Quoted and reposted posts are kept **by reference only**: an `x.post` context entity with `{text:""}` and a `quoted`/`reposted` edge, plus a related target (`x/entities.ts:196-231`).
- **X profile** (`x/profile.ts:105-135`):
  - Root `author` (`x.profile`, not context_only, with a `banner` resource, purpose `banner`, immutableKey `x:banner:<url>`).
  - Timeline posts appear only as related targets, plus `reposted` edges from profile to timeline post entities (`x/profile.ts:190-213`).
- **Instagram:** `instagram.post`, `instagram.profile`, `authored_by`, `mentions` (`ig/entities.ts:262-345`).
- **Metric paths:**
  - `x.post`: `/replies`, `/reposts`, `/likes`, `/bookmarks`, `/quotes`.
  - `x.profile`: `/metadata/followers`, `/metadata/following`, `/metadata/statuses`, `/metadata/media_count`, `/metadata/likes` (`x/entity-schemas.ts:58-67`).

### 2.5 Media descriptors (`Resource`, `adapter.proto:73-81`)

- **Fields:** `url`, `kind`, `immutable_key`, `alt_text`, `sensitive`, `purpose`.
  - `kind` is `image` or `video`; anything else is dropped.
  - `immutable_key` is a stable rendition identity used for cross-capture reuse.
  - `purpose` is `''` for content media, otherwise a role such as `avatar` or `banner`.
- **Rendition selection is adapter-side.** For example, Instagram picks the largest image/video by area, then bandwidth/bitrate (`ig/entities.ts:160-205`). The core downloads whatever URL it is given.
- **Core limits** (`app/worker.go:422-463`):
  - `alt_text` ≤ 1 MiB and `purpose` ≤ 128 bytes, otherwise `resource metadata exceeds limit`.
  - A nil resource gives `invalid resource`.
  - Kept: kind image/video; ≤ `max_media` (20) content resources and ≤ 16 purposed resources, counted separately in order.
  - Each dropped resource sets `incomplete = true` and appends the warning `resource omitted: unsupported type or resource limit`, once per dropped resource.
  - Kept resources are renumbered 0..n-1, and each entity's `resource_indices` are remapped. Indices pointing at dropped resources are removed.
- `Payload.media_descriptions[i] = alt_text` and `media_sensitive[i] = sensitive`, per kept resource.

### 2.6 Related targets, pagination and prefetch

- **`RelatedTarget`** (`adapter.proto:117-127`):
  - `url`;
  - `refresh_after_seconds`: 0 reuses any existing content; >0 refetches when `observed_at` is older;
  - `updated_at` (unused by the core);
  - `prefetch` (≤64 KiB, opaque);
  - `published_at`, `media_types[]` (`image`/`video`) and `post_type` (`post`/`quote`/`repost`/empty): listing metadata for the capture-option filters (§5.3).
- **X sets:**
  - author `refresh_after_seconds` 60 on posts;
  - quoted and reposted posts 60;
  - mentioned and repost-actor profiles 3600 (`x/entities.ts:153-157,227-230,282-285`).
- **Cursor:** opaque to the core. X encodes `JSON{user, mode: "public"|"private", cursor}`. A cursor that no longer matches gives FAILED_PRECONDITION `collection changed; start again from the profile link` (`x/strategy.ts:247-266`).
  - A `page_cursor` on a non-profile or automatic request is INVALID_ARGUMENT (`x/strategy.ts:234-238`).
  - X returns an empty next cursor if the upstream cursor did not advance and the result is complete (`x/strategy.ts:360-370`).
- **Page size inside an adapter:**
  - X: `target = min(page_size || 100, 100)` posts. It keeps whole upstream pages (it may exceed the target), stops at ≤15 upstream pages (`maxTimelinePages = 15`, warning `已达单次翻页上限。`), stops at a repeated cursor, and **ends the timeline when an upstream page adds no new post** (`x/profile.ts:262-308`).
  - Instagram: `target = min(size, 100)`, ≤12 upstream pages (warning `已达单次 Instagram 翻页上限。`), ≤200 members (`ig/strategy.ts:213-281`).
  - The plan's "最多 12 页" is accurate for Instagram only; X uses 15.
- **`max_batch_size`:** X returns 1000 for public profiles and 0 for protected ones (`x/strategy.ts:246`).

### 2.7 PrepareCredential and CheckConnection

- **PrepareCredential**(`provider_id`, `input` bytes) → `Credential{data}`. The result must be 1..16384 bytes (`internal/credentials/vault.go:48-53`).
- **CheckConnection**(`provider_id`, `credential`) → `{account_id, username}`. The core requires a non-empty `account_id` (`app/connections.go:97-99`).
- Timeouts: 10 s and 40 s respectively (`app/connections.go:66,91`).
- **CheckAccess** is dropped.

### 2.8 Errors from adapters and how the core maps them

Adapters throw `ProviderError(code, message)` and may attach trailers:

- `retry-after`: integer seconds, 1..86400.
- `source-state`: `deleted` or `suspended`.
- `credential-required`: `1`.

Sources: `x/provider.ts:11-94` and `ig/errors.ts:1-69`. Unexpected errors become UNAVAILABLE `provider request failed`, or DEADLINE_EXCEEDED on timeout (`x/server.ts:60-70`; TS `guard()` in `server/src/platforms/platform.ts`).

**Side effects in the capture task, at the fetch error site** (`app/worker.go:344-364`)

1. If a connection is used and the code is UNAUTHENTICATED: set the connection to `reauth_required` when its `revision` matches and its `state='ready'` (`app/connections.go:260-265`).
2. If the trailer `source-state` is `deleted` or `suspended`: set `collections.source_state` and `source_state_at = now()` when the value differs (`app/worker.go:105-110`). The capture still fails. Earlier revisions are untouched.
3. [MT] PermissionDenied/NotFound with a connection revoked the access grant. Dropped.
4. If the trailer `retry-after` is an integer n with 0 < n ≤ 86400: wrap as `RetryError{After: n s}`.

**Worker classification** (`app/worker.go:81-100`)

| error                                                                                                                                                                         | class                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ErrUnsupported`, `ErrNotFound` (also any "row not found" from a transaction, `internal/store/store.go:65-70`), `ErrConnection`, `ErrQuota` [MT]                              | **permanent**                                                                                                                                                |
| status INVALID_ARGUMENT, FAILED_PRECONDITION, UNIMPLEMENTED, PERMISSION_DENIED, UNAUTHENTICATED                                                                               | **permanent**                                                                                                                                                |
| `PermanentError{msg}` (the core's own validation errors)                                                                                                                      | **permanent**                                                                                                                                                |
| `RetryError{After}`                                                                                                                                                           | retry exactly after `After`, keeping the attempt count. `RetryError` has no `Unwrap`, so it is never classified permanent even if it wraps a permanent code. |
| anything else: UNAVAILABLE, RESOURCE_EXHAUSTED without retry-after, DEADLINE_EXCEEDED, **NOT_FOUND**, UNKNOWN, network or DB errors, `ErrInvalidTarget`, `ErrAccountRequired` | retryable, with exponential backoff                                                                                                                          |

Permanent errors, or the last attempt (attempt ≥ 3): call `fail(task, safeError(e))` (§3.10), then cancel the job.

**`safeError(e)`** produces the stored and displayed message (`app/worker.go:135-161`):

1. `RetryError` with an inner error → recurse on the inner error.
2. `ErrAccountRequired` → `此平台需要账号，请先添加并选择自己的采集凭据。`
3. `ErrConnection` → `账号不可用，请在采集账号中选择可用账号或重新授权。`
4. `ErrQuota` → `storage quota exceeded` [MT].
5. `ErrUnsupported` → `provider operation unsupported`.
6. `PermanentError` → its message.
7. A gRPC status error → `status.Message()`, the adapter's own message such as `post not found or deleted`.
8. Otherwise → `operation failed; retry or inspect service health`.

**Adapter error codes in practice**

- **X** (`x/provider.ts:33-94`):
  - 401 → UNAUTHENTICATED `account session expired; authorize again`.
  - 403 → PERMISSION_DENIED `account cannot access this post`.
  - 429/5xx → UNAVAILABLE `provider temporarily unavailable` with retry-after.
  - 404 with reason `suspended` → FAILED_PRECONDITION `account is suspended` plus `source-state: suspended`.
  - 404 → FAILED_PRECONDITION `post not found or deleted` / `profile not found`. **Only the public post API** adds `source-state: deleted`.
  - Others → FAILED_PRECONDITION `provider cannot access this <post|profile>`.
- **Instagram** (`ig/errors.ts:31-69`):
  - 429 → RESOURCE_EXHAUSTED (retryable, with retry-after).
  - 5xx → UNAVAILABLE.
  - 401 → UNAUTHENTICATED with an account, else FAILED_PRECONDITION.
  - 403 → PERMISSION_DENIED with an account, else FAILED_PRECONDITION.
  - 404 → **NOT_FOUND**, which the core _retries_ 3 times before failing.
- **`credential-required`:** X and Instagram raise FAILED_PRECONDITION with this trailer when the credential was withheld and is needed (`x/strategy.ts:224-233`, `ig/errors.ts:22-29`).

---

## 3. Capture lifecycle

### 3.1 Entry points

| entry                                             | what it submits                                                                                                                                                                                                                                                         | file                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `CaptureURL(raw, key, options)` (web "save link") | `Resolve(raw)`, then the **currently selected account** for that adapter (`DefaultConnection`), then `Submit{URL: target.URL, Input: raw, ConnectionID, Key, Options}`.                                                                                                 | `app/capture_records.go:311-325`   |
| `POST /v1/captures` (API)                         | A `CaptureInput` JSON (≤16 KiB, unknown fields rejected). The key comes from the `Idempotency-Key` header. `update_mode` must be `''`/`full`/`append` and is ignored. Web sessions may not set `connection_id`/`provider_id`/`update_mode` and go through `CaptureURL`. | `internal/httpapi/server.go:33-89` |
| Telegram "save" (multi-link message)              | ≤200 URLs, otherwise `ErrUnsupported`. Each is resolved; unresolvable ones are **silently skipped**; duplicates by `platform                                                                                                                                            | kind                               | object_scope | external_id`are skipped. Key`<work id>:<sha256(identity)>`. Per-URL errors are collected as `safeError`strings, and`Count` counts successes. | `app/channel_actions.go:96-121` |
| Refresh a saved collection                        | `Submit{RefreshID: id}`                                                                                                                                                                                                                                                 | §3.2                               |
| Retry or refresh (bot) / `recaptureInput`         | If `restart` is false and the latest capture is not `failed`: `{RefreshID}`. Otherwise `{URL, Input: URL, ConnectionID: current selection}` (start over with the source selected **now**).                                                                              | `app/capture_records.go:330-346`   |
| Record retry, record page, member retry           | §5.4                                                                                                                                                                                                                                                                    | —                                  |
| Related fan-out (children)                        | §3.7                                                                                                                                                                                                                                                                    | —                                  |
| Refresh batch                                     | §6.3                                                                                                                                                                                                                                                                    | —                                  |

### 3.2 Submit (`app/service.go:111-427`)

#### 3.2.1 Pre-transaction validation and resolution

1. **Options:** `MaxPosts > 100000` gives `ErrInvalidTarget`. A non-RFC 3339 `Since` gives `ErrInvalidTarget` (`:131-140`).
2. **Refresh:**
   - `ConnectionID`, if given, must parse as a UUID, else `ErrConnection` (`:146-152`).
   - If `RefreshID` is set, load the saved row's `url`, `provider_id` and `connection_id` into the input. If it is not saved: `ErrNotFound` (`:153-163`).
3. **Provider choice** (`:164-184`):
   - **With a connection:** the connection's `(adapter_id, provider_id)`. The adapter must match, else `ErrConnection`. A conflicting explicit `ProviderID` gives `ErrConnection`.
   - **Without a connection:** the default provider with `authentication == "none"` (`app/discovery.go:43-68`):
     - If none exists but a default `session` provider exists, return `ErrAccountRequired` (Instagram). This happens even if `ProviderID` was given.
     - If none exists at all, `ErrUnsupported`.
     - More than one default gives `ambiguous default provider`.
4. The provider must support `capture.fetch`. `(ConnectionID == "") != (provider.authentication == "none")` gives `ErrConnection` (`:185-191`).
5. **`target = Resolve(URL)`** (§2.2).
6. **Options-driven paging** (`:196-199`): if `target.Collection && !Automatic && Options != nil && PageCursor == ""`, then `CollectionLimit = Options.MaxPosts` and `PageSize = min(CollectionLimit, 100)`.
7. **Paging validation** (`:200-205`):
   - `(CollectionLimit > 1000 && Options == nil) || PageSize > 1000` gives `ErrUnsupported`.
   - `len(PageCursor) > 4096` gives `ErrUnsupported`.
   - Any of `PageCursor`/`CollectionLimit`/`PageSize` set while `Automatic`, or on a non-collection target, or on a provider without `capture.page`, gives `ErrUnsupported`.
8. **Input fields:**
   - `Input` defaults to the (pre-canonical) URL.
   - `URL = target.URL`, the canonical form.
   - `Key` defaults to a random UUID.
   - `len(Key) > 200` gives `idempotency key too long` (`:206-215`).

#### 3.2.2 Transaction

The transaction is serialized per tenant by `lockTenant`.

9. **Parent submission** (`:227-241`), if `ParentSubmission` is set:
   - Read the parent's `collection_stopped`, its capture's `is_collection` (stored as `recheck`), and its `capture_options`.
   - If `Options` is nil, inherit the parent's options.
   - If the parent is stopped, return `errCollectionStopped`.
10. **Connection state:** the connection must be `ready` for this provider, else `ErrConnection` (`:242-250`). It also requires the credential vault.
11. **Scope:** `scope = "public"` or `"connection:<id>"`. For a refresh without a connection, `aid = RefreshID` (`:263-269`).
12. **Idempotency** (`:273-292`):
    - `fingerprint = sha256(adapterId|platform|kind|objectScope|externalId|providerId|scope|refreshId|pageCursor|pageSize|collectionLimit[|optionsJSON])`. `|optionsJSON` is appended only when `Options != nil`; the JSON uses the `omitempty` field names of §5.3.
    - If a submission with this `idem_key` exists:
      - a different fingerprint gives `ErrConflict` (`idempotency key conflicts with an earlier request`);
      - the same fingerprint returns **that submission's capture as the job**, and nothing else happens.
13. **Identity lock** (`:293-296`): an advisory lock on `platform|kind|object_scope|external_id` serializes all submissions of one object.
14. **Collection:** if `aid` is empty, upsert the collection by identity (§1.2.1). Then lock the collection row (`:297-307`).
15. **Save it:** insert the saved row `(collection, provider, connection, adapter)` unless already saved. Refreshes save only if `RefreshID` equals this collection (`:308`). Clear `unreferenced_at` (`:321`).
16. **Find an active capture to join** (`:327`):
    - Same `collection_id`, `provider_id`, `coalesce(connection_id,'')` and `adapter_id`.
    - `state IN (queued, downloading)`.
    - Same `page_cursor` and same `page_size`.
    - **If this is an explicit (`!Automatic`) request for a `Collection` target, only non-automatic captures qualify.** Otherwise an automatic request can join an explicit capture and vice versa.
17. **Reuse stored content without fetching** (`:328-346`). This applies when no active capture was found **and** all of these hold:
    - `PageCursor == ""`;
    - `!recheck` (the parent is not a collection page; members of a collection page are always observed again);
    - `RefreshID == ""`;
    - `Automatic || !target.RefreshOnSubmit`.

    Then compute `fresh = RefreshAfterSeconds == 0 || collection.observed_at > now - RefreshAfterSeconds`. If `fresh` and the collection has a head revision, the job is **the head revision's capture** (an old, finished capture), and no new capture is made.
    - Consequences:
      - A plain explicit submit of an already-stored post never refetches.
      - Explicit profile submits (`refresh_on_submit`) always refetch.
      - Automatic children refetch only when older than their `refresh_after_seconds`.

18. **New capture** (`:347-380`), when none was joined or reused:
    - Insert a capture with `collection_id`, `provider_id`, `scope`, `connection_id`, `refresh_from = RefreshID`, `adapter_id`, `automatic`, `page_cursor`, `is_collection = target.Collection && !Automatic`, `page_size`, `mode='fetch'`, and `prefetch` (**only if `Automatic`** and a prefetch was given).
    - Enqueue `capture`.
19. **Submission** (`:385`): insert `(capture_id, idem_key, fingerprint, input, collection_limit, parent_submission, capture_options = JSON(Options) or null)`.
20. **Fan-out decision** (`:389-414`):
    - `expandRelated = !Automatic`.
    - For automatic, non-collection, non-refresh-on-submit targets that have a parent, `expandRelated = (parent.parent_submission IS NULL) OR parent's capture.is_collection`. That is, a direct child of a top-level request or of a collection page may hydrate its own references, but references of references never expand.
    - If `expandRelated` and the provider supports `capture.related`:
      - Set the submission's `related_provider`, `related_connection`, `related_adapter`, `related_state='pending'` and `related_source_collection = aid`.
      - Enqueue a `related` task for the submission. If the capture is still `queued`/`downloading`, schedule it **10 s later** (`relatedFallback`, `:68`) as a fallback, because the capture's finalize or fail enqueues it immediately (§3.10). Otherwise enqueue it now.
21. **Return the job** (§3.2.4). [channel] Enqueue deliver/status.

#### 3.2.3 Idempotency key prefixes

The prefixes have meaning; they are matched with `LIKE`.

| prefix                                 | made by                                                                      | meaning                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `related:<parentSubmission>:<index>`   | related fan-out (`app/related.go:181`)                                       | A member or reference of a page. These are counted as "members" everywhere (`LIKE 'related:%'`). |
| `related-expand:<sid>`                 | related task of an automatic capture that must expand (`app/related.go:133`) | —                                                                                                |
| `batch:<sid>`                          | auto-continuation page (`app/related.go:202`)                                | Linked via `next_submission`.                                                                    |
| `more:<recordId>`                      | "more" / "more1000" (`app/capture_records.go:433`)                           | A second press returns the same job.                                                             |
| `page-retry:<key or uuid>`             | "page_retry" (`app/capture_records.go:436-441`)                              | —                                                                                                |
| `retried:<submissionId>`               | key rename of retried failed members (`app/batch.go:302`)                    | Frees the original `related:` key.                                                               |
| `refresh-batch:<batchId>:<position>`   | refresh batch (`app/batch.go:219`)                                           | —                                                                                                |
| `retry:<w>`, `refresh:<w>`, `show:<w>` | bot (channel)                                                                | —                                                                                                |

Records exclude `related:%`, `related-expand:%`, `batch:%` and `retried:%`, and require no parent and `input <> ''` (`app/capture_records.go:117`).

#### 3.2.4 Job view (`scanJob`, `app/service.go:465-467`; `internal/domain/domain.go:91-103`)

- **Fields:** `{id, collection_id, state, error, provider_id, connection_id, access_scope = captures.scope, created_at, members?}`.
- **`JobProgress`** adds `members` for collection captures (`app/service.go:476-496`). It follows the tenant's newest submission of that capture whose `related_state <> 'none'`, and uses §5.5 progress, where `done = done || stopped`.

### 3.3 Task queue semantics

The TS plan replaces River with its own SQLite queue. The Go behavior is:

- **Task payload:** `{tenant, id, type}`, kind `monitor_task` (`internal/store/store.go:92-98`). In single-user it is `{id, type}`.
- **Queues** (`internal/store/store.go:99-111`):
  - `capture` → queue `capture`;
  - `download` → `download`;
  - `thumbnail` → `download` with **priority 4** (lower than downloads);
  - `finalize`, `related`, `refresh_batch` → `control`.
- **Limits:** `MaxAttempts` 3. Job timeout 10 min (`app/worker.go:35`). Stuck-job rescue after 6 min (`internal/runtime/runtime.go:101`).
- **Retry delay** (`app/worker.go:36-41`): a stored `RetryError` delay if present, else `2^min(attempt, 8)` seconds (2 s after attempt 1, 4 s after attempt 2).
- **Snooze** (`river.JobSnooze(d)`) re-schedules **without consuming an attempt**. Snooze is used for:
  - a paused capture (1 min);
  - a busy connection turn (1 s);
  - a busy asset or cache-key lock (1 s);
  - a related task whose parent is still running (2 s);
  - a rate limit (1 min) [MT];
  - an unavailable adapter in a batch (1 min) [registry].
- An unknown task type is cancelled (`app/worker.go:67-68`).
- **Recovery:** jobs that end discarded or cancelled (including processes killed on the final attempt) are reconciled by maintenance, which calls `fail(task, "job exhausted retries or was interrupted")` once per job (`app/maintenance.go:70-109`).
- **Idempotency:** every handler starts by re-reading state and returns successfully if the work is already done. Duplicate or replayed tasks are therefore harmless (tests: `app/integration_test.go:268-274,366-369`; `app/related_test.go:96-97`).

### 3.4 `capture` task (`app/worker.go:249-549`)

**Phase 1: read state.** Load the capture and collection. If `state != 'queued'`, return OK (`:274-282`).

**Phase 2: account.** If the capture uses a connection (`:283-294`):

- Load and decrypt the credential (§6.5). A connection that is not `ready`, or a missing credential, gives `ErrConnection`.
- The connection's provider must equal the capture's provider, else `ErrConnection`.

**Phase 3: provider checks** (`:295-304`). The provider must support `capture.fetch`. `(connection == "") != (auth == "none")` gives `ErrUnsupported`.

**Phase 4: connection turn** (`:305-314`, `connectionTurn` `:210-247`).

- `deferred = connection && provider supports credential.deferred`.
- If there is a connection and it is not deferred, take a **connection turn** first:
  - up to `connection_concurrency` slots per connection;
  - poll every 25 ms for up to 2 s;
  - otherwise snooze 1 s.
- The turn is held until the task ends.

**Phase 5: fetch** (`:319-343`). One 45 s deadline covers all fetch calls of this task.

- **Deferred:** first `Fetch` without the credential, with `credential_deferred=true`. If it fails **and** carries the `credential-required` trailer, take the connection turn and call `Fetch` again with the credential. Any other result, success or error, is used as is.
- **Not deferred:** a single `Fetch` with the credential (or none).

**Phase 6: on error.** Apply the side effects of §2.8, then return the error. The worker classifies it.

**Phase 7: validate the response.** Each failure is permanent unless noted.

1. Identity echo (`:365-367`).
2. `validateRelatedResult` (§2.3/2.6) (`:368-370`).
3. [MT] subjects and visibility.
4. `text` ≤ 1 MiB.
5. Entity graph (§2.4).
6. Source responses: drop surplus over 4 MiB (§4.7), then validate (`:398-404`).
7. Build the `Payload` (§3.6.1), including `metric_paths` per entity type and `metrics` per `type/external_id` (`:405-421`).
8. Filter and renumber resources (§2.5).

**Phase 8: commit** (`:469-547`), in one transaction.

1. Re-lock the capture. If `state != 'queued'`, return OK.
2. **`validateExecution`:** if a connection is used, its current `revision` must equal the revision read before the fetch, and its state must be `ready`. Otherwise `ErrConnection`. This covers credential rotation or account deletion during a fetch (`app/connections.go:185-196`); the fetched result is discarded.
3. If `canonical_target` is set, run `resolveCaptureScope` (§3.13). Afterwards, if the capture is no longer `queued` (it joined another capture and was failed), return OK. **A capture that joined a running one stores nothing itself.**
4. Update the capture: `prefetch=NULL`, `credential_revision`, `related_targets` (JSON of the targets), `next_page_cursor`, `max_batch_size`.
5. Insert the source responses (`position` = index after truncation).
6. Set `state='downloading'`, `payload` and `adapter_version`.
7. For each kept resource at position n: insert an asset `(capture_id, position n, source_url, kind, cache_key, alt_text, sensitive, purpose)` and enqueue `download`.
8. `finalizeSettled`: if no asset is `pending` (for example there are zero resources), enqueue `finalize` (`:554-560`).

### 3.5 `download` task

See §4 for the detailed media rules.

- On success: the asset becomes `ready`, `thumbnail` is enqueued for its blob, and `finalizeSettled(capture)` runs.
- On final failure: `fail()` marks the asset `failed` and runs `finalizeSettled`.

### 3.6 `finalize` task and revision creation (`app/worker.go:562-722`)

#### 3.6.1 Payload JSON (stored in `captures.payload`, then `revisions.payload`)

The JSON fields, from `app/service.go:663-680`, are:

- `author_name`, `published_at`, `summary`
- `graph`: `{root, entities: [{id, version_id, key, type, external_id, data, schema, resource_indices, context_only}], relations: [{source, target, type}]}`
- `media_sensitive[]`, `media_descriptions[]`
- `text`, `text_kind`, `warnings[]`
- `adapter_version`, `text_source`
- `incomplete`
- `metrics`: `{"<type>/<external_id>": {"<pointer>": value}}`
- `metric_paths`: `{"<type>": ["<pointer>"]}`

Notes:

- `id` and `version_id` in graph entities are filled in at finalize (§3.12).
- Entity `data` has the metric paths removed.

#### 3.6.2 Algorithm

1. Lock the collection row and the capture. If `state != 'downloading'`, return OK. If any asset is `pending`, return OK; the last download enqueues finalize again.
2. `validateCaptureConnection`: the same revision check as §3.4 phase 8 step 2. A revoked account fails the capture with `ErrConnection`.
3. `good` = count of `ready` assets with `purpose == ''`. `partial = payload.incomplete || any asset not ready`, including purposed ones.
4. If `text == ''`, `good == 0` and there is no graph: `failCaptureTx(… "no text or media could be saved")`.
5. `persistEntities` (§3.12). This assigns `id`/`version_id` into the graph and re-serializes the payload.
6. Compute the digest and compare with the head (§3.6.3).
7. **If the content differs**, or there is no previous revision:
   - insert a revision `(collection_id, capture_id, content_hash = digest, payload, content_bytes = len(payload))`;
   - insert `revision_entities` (`is_root = key == graph.root`) and `entity_relations`;
   - set `collections.current_revision`.

   **If equal**, reuse the previous revision. There is no new row.

8. Set the capture to `state = partial ? 'partial' : 'complete'`, `payload = NULL`, `finished_at = now()`, `revision_id` = new or reused, and `metrics` = JSON of the payload's metrics (null if empty).
9. Update the collection: `observed_at = now()`, `source_state = NULL`, `source_state_at = NULL`. A successful capture clears a gone state.
10. **Refresh moved the collection** (`:706-719`): if `refresh_from` is set and differs from the capture's collection, delete the old collection's saved row only if it has no `current_revision`, then `mark_unreferenced(old)`.
11. `deliveries(capture)` (§3.10).

#### 3.6.3 Revision signature and dedup (`app/revision_signature.go:11-62`, `app/worker.go:613-689`)

**`revisionSignature(p, assets, policy)`** is the JSON of `{Text, Kind: text_kind, Summary, AuthorName, PublishedAt, Graph, Warnings, Assets}`, where:

- `context` = the keys of entities that are `context_only` in **policy** and are not the root.
- `Graph` is `p.graph` with every context entity replaced by `{key, type, external_id}` only. Data, schema, ids, version ids and resource indices are dropped.
- `Assets` is the list of `{Purpose, Hash, AltText, Sensitive, State, Error}` for all capture assets in position order, **except** assets referenced only by context entities. An asset referenced by both a context and a content entity is kept.
- If any context entity exists, `AuthorName` and `Summary` are blanked.
- Not included: `media_descriptions`/`media_sensitive` (they are covered by the asset `AltText`/`Sensitive`), `text_source`, `adapter_version`, `incomplete`, `metrics`, `metric_paths`, and asset ids, URLs and sizes.

**Digest.** `digest = sha256_hex(canonical_json(revisionSignature(p, aa, p.graph)))`. Go canonicalizes through PostgreSQL `jsonb::text`, which sorts keys by length then bytewise and normalizes whitespace. Any deterministic canonical JSON is fine as long as one function is used everywhere. Hashes are compared only with hashes the same code produced (there is no import).

**Head comparison.**

1. `previous` = the head revision's `content_hash` (newest by `created_at DESC, id DESC`).
2. **Comparable path.** It applies when a previous revision exists, `p.graph != null`, and (any entity is `context_only` **or** `p.metric_paths` is non-empty) (`:627-664`). X always takes it because X declares metric paths. Steps:
   1. Load the previous payload and **strip the current `metric_paths`** from its entity data, since old versions kept counts in data.
   2. Load the previous capture's assets.
   3. Apply `comparable()` (`app/observed_metrics.go:78-105`) to both payloads: each entity key is renamed to `"<type>/<external_id>"` (root and relations renamed too), `id` and `version_id` are cleared, and entities and relations are re-sorted. This makes adapter key numbering and DB ids irrelevant.
   4. Compute both signatures using **the current graph's context policy for both** ("compare the retained snapshot under today's context policy").
   5. If the two comparable digests are equal, treat the content as equal to `digest`. Otherwise treat `previous` as the comparable previous digest, which differs from `digest`.
3. **Equal content** means `previous == digest`: reuse `previous_id`. Otherwise insert a new revision with `content_hash = digest` (the non-comparable digest).

**Consequences**, all verified by tests:

- Changes only to a context author (name, handle, followers, avatar) give no new post revision (`app/revision_signature_test.go:11-32`, `app/entities_test.go:232-238`).
- A non-context author change does give one (`app/entities_test.go:227-231`).
- A changed post media hash, `alt_text` or `sensitive` flag gives a new revision without re-downloading (`app/video_test.go:100-109`).
- Count changes on declared metric paths give no revision. Undeclared counters are content (`app/entities_test.go:239-268`).
- A profile **root** whose stats change gives a new revision when the stats are not declared as metrics (`app/revision_signature_test.go:33-40`).
- Renumbered or reordered entity keys give no revision (`app/observed_metrics_test.go:96-141`).
- A new raw response alone gives no revision, but the raw response is still stored (`app/entities_test.go:211-220`).

#### 3.6.4 Observed metrics (counts) (`adapter/metrics.go`, `app/observed_metrics.go`)

**`SplitMetrics(data, paths)`**

- For each JSON pointer (with `~1`→`/` and `~0`→`~` unescaping), walk the object parents. If the parent exists and has the leaf key, remove the value and record it under the pointer string.
- Missing paths are ignored. Number precision is preserved.
- It returns the stripped data and the metrics, or null if none.

**`OverlayMetrics(data, metrics)`**

- Put the values back: create missing parent objects, but **never replace a non-object** (skip that path).
- Skip invalid paths.
- Return the data unchanged if it is not an object.

**Read side**

- A collection shows the newest counts of its latest `complete`/`partial` capture that has metrics (`app/collections_batch.go:20`).
- `CaptureCollection(captureId)` shows that capture's own counts, falling back to the counts of the revision's capture (`app/service.go:710-718`).
- A past revision shows its own capture's counts.
- The "current" author version shows the counts of the capture that observed it (`app/entities.go:519-529`).

### 3.7 `related` task (fan-out and continuation) (`app/related.go:48-227`)

The task id is the submission id.

1. Load the submission, its capture, the collection URL and the options.
   - If `related_state != 'pending'` or the submission is stopped: return OK.
   - If the capture is `queued`/`downloading`: **snooze 2 s**.
   - If the capture is `failed`: `fail(task, "parent capture failed")`, so `related_state = 'failed'`.
   - A missing submission (for example after DeleteAll) gives `ErrNotFound`, so the task ends; `fail` updates nothing.
2. **Repair after a canonical move** (`:78-114`):
   - If neither `related_source_collection` nor the capture's current collection is saved: `ErrNotFound` (permanent).
   - If they differ: save the current collection with the submission's provider, connection and adapter. Unsave the source if it has no `current_revision`, then `mark_unreferenced(source)`.
3. `targets` = the capture's stored `related_targets`.
4. **Automatic capture of a `refresh_on_submit` target** (`:126-145`). This happens when an explicit request joined an automatic capture:
   - Submit `{ParentSubmission: sid, URL: collection url, same provider/connection, Key: "related-expand:<sid>"}`. This is a non-automatic capture that will expand.
   - Ignore this capture's own targets.
5. Read `limit = submission.collection_limit`, `next = capture.next_page_cursor`, `collection = capture.is_collection` and `currentCursor = capture.page_cursor`.
6. **For each target `i`, in order** (`:155-191`):
   - **Classify.** `member = true`. If `collection` or `options.skip_references`: `member = !Resolve(target.url).Collection`. A resolve error aborts the task, and the task retries.
   - **Filter**, if options are set and `member`:
     - On a collection page: skip if `limit > 0 && members >= limit`, or if `!captureTargetMatches(options, target)` (§5.3).
     - On a non-collection page: skip when `skip_references`.
   - **References always pass.** Collection-typed targets, such as author profiles, are submitted even with filters and never consume the limit.
   - If `member`: `members++`.
   - **Submit** `{ParentSubmission: sid, URL: target.url, same provider/connection, Automatic: true, RefreshAfterSeconds: target.refresh_after_seconds, Prefetch: target.prefetch, Key: "related:<sid>:<i>"}`.
     - `errCollectionStopped` → return OK.
     - `ErrRate` → snooze [MT].
     - Any other error → return the error; the task retries and eventually fails, which sets `related_state='failed'`.
7. **Auto-continuation** (`:193-218`). It happens when `next != ""`, `next != currentCursor`, and one of:
   - options are set, `collection` is true, and `limit == 0 || limit > members` (with options, **limit 0 means "until the end"**); or
   - options are not set, `limit > members`, and `members > 0` (without options, a page that yields no members ends continuation).

   Then:
   - `remaining = limit > members ? limit - members : 0`.
   - `pageSize = options ? min(remaining, 100) : remaining`.
   - Submit `{ParentSubmission: sid, URL: collection url, same provider/connection, PageCursor: next, PageSize: pageSize, CollectionLimit: remaining, Options: options, Key: "batch:<sid>"}`. This is not automatic, so it is itself a collection page with its own related task.
   - Set `submission.next_submission` to the submission with key `batch:<sid>`.

8. **Finish:** remove the `prefetch` key from every element of the capture's `related_targets`, then set `related_state='complete'` unless stopped (`:219-226`).

Child submissions carry prefetch only when automatic (§3.2 step 18). The child capture's `prefetch` is cleared after its fetch.

### 3.8 `refresh_batch` task

See §6.3.

### 3.9 `thumbnail` task

See §4.5.

### 3.10 Failure recording: `fail(task, msg)` and `deliveries` (`app/worker.go:725-858`)

`fail` runs in one transaction and depends on the task type.

**`capture`/`finalize` → `failCaptureTx(captureId, msg)`** (`:784-815`)

1. Lock the collection and the capture. If the capture is already terminal, return OK.
2. Mark all `pending` assets `failed` with `error = msg`. Mark their `pending` objects `garbage`.
3. **Delete the capture's source responses.**
4. Set the capture to `state='failed'`, `error=msg`, `prefetch=NULL`, `payload=NULL`, `finished_at=now()`.
5. Run `deliveries`.

**`download`** (`:825-846`): if the asset is `pending`, set it to `failed` with `error=msg`. Mark its `pending` object `garbage`. Run `finalizeSettled(capture)`; the capture then finalizes as `partial`, or fails if nothing was saved.

**`related`:** `related_state='failed'`, `related_error=msg`, only where it was `pending`.

**`thumbnail`:** insert a `blob_thumbnails` row `failed` with `error=msg` (ON CONFLICT DO NOTHING).

**`refresh_batch`:** `state='failed'`, `error=msg` where `running`.

**`deliveries(capture)`** runs when a capture reaches a terminal state (`:725-765`):

- Enqueue `related` for every submission of this capture with `related_state='pending'` and not stopped. These start immediately instead of waiting for the 10 s fallback.
- [channel] Enqueue a delivery for each pending chat submission. This is the hook for the Telegram rewrite.

### 3.11 State machines

| entity                     | transitions                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| capture                    | `queued` → `downloading` (capture commit) → `complete` \| `partial` (finalize). `queued`/`downloading` → `failed` (`failCaptureTx`, reached from capture/finalize fail, a join, nothing saved, a stale sweep or job reconcile). Terminal states never change. |
| asset                      | `pending` → `ready` (download or cache reuse) \| `failed` (download fail or capture fail).                                                                                                                                                                    |
| `submission.related_state` | `none` (no fan-out) \| `pending` → `complete` (related done, or stopped) \| `failed` (parent failed or task failed). `complete` → `pending` again on member retry (§5.4).                                                                                     |
| refresh_batch              | `running` → `complete` (everything submitted) \| `failed` (quota [MT], expired after 1 day, or task failure).                                                                                                                                                 |
| `blob_thumbnails`          | absent → `ready` \| `failed`. Terminal.                                                                                                                                                                                                                       |
| objects                    | §4.6.                                                                                                                                                                                                                                                         |
| connection                 | `ready` → `reauth_required` (UNAUTHENTICATED) → `ready` (re-import). Any state → `revoked`.                                                                                                                                                                   |

### 3.12 Entity persistence and version dedup (`app/entities.go:117-166`)

For each graph entity, at finalize, with the platform taken from the collection:

1. `media` = for each `resource_index` in order, the **first** capture asset at that position, as `[purpose, hash, state, alt_text, sensitive, error]`.
2. `body = JSON([data, schema, media])`.
3. Upsert `entities(platform, kind = type, external_id)` and set `observed_at = now()` on conflict. This gives `entity.id`.
4. `version_id = ensure_entity_version(id, body, data, schema)`. The dedup key is `(entity_id, sha256(canonical body))`, and the first stored data wins.
5. After the revision is inserted: `revision_entities(revision_id, key, version_id, is_root)` plus relations (`linkEntities`). This runs only for new revisions; a reused revision keeps its old links.

Entities are shared across all collections by `(platform, type, external_id)`. The same author in many posts is one entity, and identical content is one version (`app/entities_test.go:221-226`). Different types with the same external id stay distinct (`app/entities_test.go:310-314`).

### 3.13 Collection identity, canonical targets, aliases and joining

**Identity.** One collection exists per `(platform, kind, object_scope, external_id)`, whichever source or account stored it. A private or account observation becomes another revision of the same collection (`app/collection_identity_test.go:44-53`).

**`resolveCaptureScope`** runs at capture commit when `canonical_target` is present (`app/capture_scope.go:15-74`).

- **Canonical id equals the requested id:** update `collections.url` to the canonical URL if it differs. This is how a profile rename updates the stored URL (`app/instagram_test.go:139-149`).
- **Canonical id differs** (for example `handle:foo` → `12345`):
  1. Take the advisory identity lock on the canonical identity. Upsert the canonical collection, with `url = canonical url` and `provider = capture provider`.
  2. Upsert the alias `(platform, kind, object_scope, requested external id) → canonical collection`.
  3. **`joinActiveCapture`:** look for another active capture of the canonical collection with the same adapter, provider, connection key, page cursor, page size, automatic flag and mode.
     - **If found:** repoint all submissions of this capture to it, replace this capture id in all `refresh_batches.capture_ids`, and `failCaptureTx(this, "joined a running capture of the same content")`. The merged capture therefore shows as `failed`.
     - **Otherwise:** move this capture to the canonical collection (`collection_id = target`). This is safe because a queued capture has no assets or revisions.
  4. If the saved source (`refresh_from`, or the old collection) is saved: save the canonical collection too, upserting provider, connection and adapter.
  5. Unsave the old collection if it has no `current_revision` (an empty staging row), then `mark_unreferenced(old)`.
  6. If the canonical collection is saved, clear its `unreferenced_at`; then `mark_unreferenced(canonical)`, a no-op if saved.

**Aliases are not used by Submit.** Every submit of `x.com/foo` lands on the staging collection `handle:foo` first, and the fetch moves it. Staging rows age out through GC.

### 3.14 `source_state`

- **Set** at the capture error site from the `source-state` trailer: `deleted` or `suspended` (§2.8).
- **Cleared** by the next successful finalize (`app/worker.go:703`).
- **Used for:**
  - excluding members from "retryable" counts (`app/batch.go:89-90`);
  - `CaptureMember.gone` (`app/capture_records.go:283`);
  - display.
- Tests: `app/current_profile_test.go:115-133`.

---

## 4. Media

### 4.1 Download task (`app/download.go:31-335`)

1. **Per-asset lock:** an advisory lock on `(asset id, -1)`. If it is busy, snooze 1 s (`:44-59`).
2. **Cache key:** if `cache_key != ''`, take the lock on `(cache_key, -2)`, polling every 25 ms for up to 2 s (`mediaWait`), else snooze 1 s. Then try `reuseMedia` (§4.4). On a hit, done. On a miss, continue **while holding the cache-key lock**, so concurrent identical renditions wait for this download (`:67-100`).
3. **Prepare:**
   - If the asset is not `pending`, return OK.
   - `validateCaptureConnection` (§3.4 phase 8 step 2).
   - If the asset has no `object_id`, create `objects(id = uuid, object_key = "objects/<id>", state 'pending')` and link it. Otherwise reuse the linked object, which must still be `pending` (`:101-136`).
4. **URL check:** `http`/`https` only, no userinfo. Otherwise permanent `invalid media URL` (`:137-140`).
5. **Request:** a plain `GET` with no extra headers, a 5 min HTTP client timeout, and default redirect following (`internal/runtime/runtime.go:51`; `:158-166`). A transport error gives `media request failed: …` (retryable).
6. **Status:**
   - 429 or ≥500 → `RetryError{After: Retry-After}` with message `media upstream unavailable`. `Retry-After` is integer seconds or an HTTP date; anything else gives 0.
   - Any other non-200 → permanent `media provider rejected request` (`:169-174`).
7. **Body:** stream to a temp file while hashing sha256 (`:208-231`).
   - A stream error gives `media download interrupted` (retryable).
   - An empty body gives permanent `empty media`.
   - [MT] The only size limit was the quota. **There is no size limit otherwise.**
8. **Sniff** the first 512 bytes (§4.2). The rules are:
   - kind `video` requires `video/mp4` or `video/webm`;
   - kind `image` requires `image/jpeg`, `image/png` or `image/webp`;
   - otherwise permanent `unsupported media format`. GIF is not accepted.
9. **Dedup lock:** an advisory lock on the content hash. Check whether a blob with this hash exists. If not, upload the temp file to the object store under this asset's object key with the sniffed MIME (`:247-272`).
10. **Commit**, in one transaction (`:273-335`):
    1. If the asset is no longer `pending`, return OK.
    2. `validateCaptureConnection`.
    3. Load the blob by hash. If it is missing but existed at step 9, return the retryable error `cached media expired before attachment` (GC raced). Otherwise insert `blobs(hash, object_key = this key, size, mime)`.
    4. The object becomes `attached` if the blob's key is this object's key, else `garbage` (a dedup hit; the reserved key was never uploaded).
    5. The asset becomes `ready` with `blob_id`.
    6. `enqueueThumbnail(blob)`.
    7. `finalizeSettled(capture)`.

### 4.2 MIME sniffing (`app/media_type.go:10-24`)

The rule is Go's `http.DetectContentType` (the WHATWG MIME sniffing algorithm) on ≤512 bytes, plus an ISO-BMFF fallback.

**Signatures that matter:**

- JPEG: `FF D8 FF`.
- PNG: `89 50 4E 47 0D 0A 1A 0A`.
- WebP: `RIFF????WEBPVP`.
- WebM: `1A 45 DF A3`.
- MP4 (WHATWG mp4 signature):
  - `len ≥ 12`;
  - `boxSize` = big-endian u32 at offset 0, with `len ≥ boxSize` and `boxSize % 4 == 0`;
  - bytes 4..8 are `ftyp`;
  - for each offset `st` from 8 to `boxSize` in steps of 4 (skipping 12), the 3 bytes at `st` are `mp4`.

**Fallback.** It applies when the detected type is `application/octet-stream`, `len ≥ 16` and bytes 4..8 are `ftyp`:

- `size` = big-endian u32 at 0, with `16 ≤ size ≤ len` and `size % 4 == 0`;
- the major brand (bytes 8..12) is one of `isom`, `iso2`…`iso9`, `avc1`, `dash`, `M4V ` (with the trailing space);
- then the result is `video/mp4`.

**Rejected** (`app/media_type_test.go:10-41`):

- truncated headers (0, 4, 8, 15 or 23 bytes for a 24-byte box);
- brands `avif`, `heic`, `M4A `, `fake`;
- box size 4096 > buffer;
- HTML bodies.

### 4.3 Blob dedup and object keys

- **Blob identity** is the sha256 hex of the full bytes, globally unique (`blobs.hash`).
  - Identical bytes in one capture or across captures share one blob and one stored object (`app/integration_test.go:373-387`).
  - Concurrent downloads of identical bytes perform 2 HTTP downloads but 1 upload (`app/image_dedup_test.go:57-73`).
- Go keys objects as `objects/<random uuid>`. The plan switches to content-addressed `media/ab/cd/<sha256>`, which makes the "dedup hit → garbage object" dance unnecessary, but blob/asset reference GC must still hold (§6.6).

### 4.4 Media cache by immutable key (`app/media_cache.go:16-73`, `app/worker.go:533-537`)

- **Key:** `cache_key = sha256_hex(JSON.stringify([platform, immutable_key]))`. Go's `json.Marshal` produces compact output and escapes `<`, `>`, `&` as `<` and so on. This only matters for importing old data.
- **`reuseMedia`:**
  - If the asset is not `pending`, it counts as a hit and returns.
  - `validateCaptureConnection`.
  - `cached_blob(key)` = the blob of any `ready` asset with that key. On a hit:
    - the asset's object becomes `garbage` and its `object_id` NULL;
    - the asset becomes `ready` with that blob;
    - `enqueueThumbnail` and `finalizeSettled` run.
  - On a miss, the normal download proceeds.
- **Semantics** (`app/image_dedup_test.go:77-98`, `app/video_test.go:83-122`):
  - The first capture with a new key downloads (even if the bytes already exist) and maps the key to the hash with no upload.
  - The same key later needs no HTTP request at all.
  - A different rendition key (for example `…:2160p` vs `…:1080p`) downloads.
  - Reuse is across all captures and sources.

### 4.5 Thumbnails (`app/thumbnail.go`)

**Encoder** (`:33-41`): if `ffmpeg` is on PATH and `ffmpeg -hide_banner -h encoder=libwebp` prints `Encoder libwebp`, use WebP. Otherwise use `mjpeg`. Without ffmpeg, no tasks are enqueued and nothing is recorded, so a later build can backfill.

**Enqueue** (`:54-64`):

- After every asset becomes `ready` (downloaded or reused), if the blob has no `blob_thumbnails` row, enqueue `thumbnail` with **task id = blob id**.
- Tasks are per blob, not per asset; duplicates are harmless.

**Task** (`:98-192`):

1. Take an advisory lock per blob.
2. If the blob is gone, or a thumbnail row exists, return OK.
3. A MIME not in {`image/jpeg`, `image/png`, `image/webp`, `video/mp4`, `video/webm`} gives a `failed` row `unsupported media format`.
4. Copy the blob to a temp dir and render with a 1 min timeout.
5. A render error (exit code ≠ 0, or an empty output) gives a `failed` row `thumbnail rendering failed`. It is **not retried**; a broken image still produces a ready asset (`app/thumbnail_test.go:65-182`).
6. **Upload:**
   1. Register `objects(key "objects/<uuid>", state 'garbage')` first.
   2. Upload.
   3. Insert a `blob_thumbnails` row `ready` with `(object_key, size, mime)`, ON CONFLICT DO NOTHING.
   4. If the insert happened, mark the object `attached`. If the object is no longer garbage, error with `thumbnail object collected before attachment`.
   5. If the blob vanished meanwhile, nothing is inserted and the object stays garbage.
7. Upload or storage errors are retryable. After 3 attempts, `fail` records a `failed` row with the safeError message.

**ffmpeg invocation** (`:214-234`):

```
ffmpeg -nostdin -v error -y -i <source> -map 0:v:0 -frames:v 1
  -vf "scale='if(gt(iw,ih),-2,min(iw,400))':'if(gt(iw,ih),min(ih,400),-2)',scale='min(iw,1200)':'min(ih,1200)':force_original_aspect_ratio=decrease"
  (libwebp) -c:v libwebp -quality 75 -f webp <out>         → image/webp
  (mjpeg)   -c:v mjpeg -q:v 5 -pix_fmt yuvj420p -f image2 <out> → image/jpeg
```

- **Geometry:** the short side is ≤400 and the long side ≤1200, never enlarged. For example 2000×1000 → 800×400, 500×1500 → 400×1200, 400×6000 → 80×1200, 300×200 unchanged (`app/thumbnail_test.go:23-63`).
- **Backfill:** each maintenance run enqueues up to 2000 blobs that have no thumbnail row and no live thumbnail job (`:68-90`).
- **Exposure:** `Asset.thumbnail = true` iff a `ready` thumbnail exists for the asset's blob (`app/service.go:535`). Thumbnails never count toward storage.

### 4.6 Object lifecycle and GC (Go; simplifies with content addressing)

- **`pending`**
  - Created when a download starts (`app/download.go:121`).
  - Becomes `attached` when it is the blob's object.
  - Becomes `garbage` on a dedup hit, a cache reuse, a download fail, a capture fail, or collection GC.
- **Thumbnail objects:** created `garbage` and become `attached` once linked. When their `blob_thumbnails` row is deleted, they go back to `garbage` via the trigger.
- **Blob GC:** sets the blob's object to `garbage`.
- **Object GC** (`Collect`, `app/download.go:349-390`) runs every maintenance pass with `grace = object_gc_grace_hours` (24 h):
  1. Claim batches of 100 garbage objects older than the grace (by creation time).
  2. Delete each from storage. **Deleting a key that was never uploaded must succeed**, because dedup-hit objects were never written.
  3. On success: `finish_garbage_object`.
  4. On failure: `defer_garbage_object` (backoff of 1 min × 2^attempts, capped at 1 day). Continue with the rest and return a joined error containing `object <id>: <cause>`.
  5. Loop while batches are full, within a 30 s budget.

### 4.7 Raw source responses (`app/sources.go`)

- **Kept in adapter order** until the cumulative body size would exceed **4 MiB** (`maxSourceBytes`). The rest are dropped and logged; the capture is not failed (`:16-35`; `app/entities_test.go:33-61`). The count is unlimited.
- **Each kept response must have:** a non-nil, non-empty body that is **valid JSON**; a non-empty `content_type`; and `source_url` ≤8192. Otherwise permanent `invalid source response`. A visibility value is also required [MT].
- **Stored** byte-for-byte with `sha256 = sha256_hex(body)` and `size`, at `position` = index.
- **Read API:** list up to 100 newest responses of complete/partial captures of a saved collection; read one body (`:70-102`).

---

## 5. Profiles, pagination, records and progress

### 5.1 Terms

- A **capture page** is one capture of a collection target with a given `page_cursor`. Inside it, the adapter may read several **upstream pages**: X up to 15, Instagram up to 12, aiming for ~100 posts.
- A collection request creates a chain of capture pages linked by `submissions.next_submission`.
- Members are fanned out from each page's `related_targets`.

### 5.2 Profile capture flow

1. **Explicit submit of a profile URL** (`collection=true`, `refresh_on_submit=true`):
   - always a new capture, or a join with an active **explicit** one;
   - `is_collection = true`;
   - `page_size` and `collection_limit` come from options (§3.2 step 6), else 0.
2. **Adapter fetch:**
   - The adapter returns the profile root entity, the timeline posts as `related_targets` (each with `published_at`, `media_types`, `post_type` and an optional `prefetch`), `next_page_cursor`, `max_batch_size`, and a `canonical_target` (`handle:x` → numeric id).
   - Protected X profiles without a credential return the profile only, with `incomplete` and the warning `帖子受保护，需添加有访问权限的采集账号。` (`x/strategy.ts:268-287`).
3. **Finalize** stores the profile revision. Then the related task fans out members (§3.7). Members are automatic, `recheck` is true (always refetched, §3.2 step 17), and they use their prefetch.
4. **Continuation:**
   - **Without options**, the first page does not auto-continue (limit 0).
   - **With options**, it continues while there is a next cursor and the limit is not reached. MaxPosts 0 means unlimited.
   - **"more"** (§5.4) submits the next cursor with `PageSize 0` and `CollectionLimit 0`. Without options this is exactly one more page. **If the record has options (inherited), limit 0 means auto-continue until the cursor ends** (§3.7 step 7).
   - **"more1000"** requires `max_batch_size ≥ 1000` (else `ErrUnsupported`). It submits `PageSize 1000`, `CollectionLimit 1000`, and keeps auto-continuing until 1000 members are submitted or the cursor ends.
   - **"page_retry"** refetches the last page's own `page_cursor` with its original `page_size`, and `CollectionLimit` = that page's `collection_limit`.
   - All three inherit the record's `capture_options` (`app/channel_actions.go:192-226`).
5. **Collection limit accounting** (`app/collection_progress_test.go:283-320`):
   - Only member targets count.
   - Collection references never consume it.
   - The next page's `collection_limit` is the remaining budget.
6. **Stop:** `StopCollection(submission)`, §5.6.

### 5.3 Capture options (`internal/domain/domain.go:59-65`; `app/related.go:229-247`)

**JSON:** `{media_only?, omit_shared?, skip_references?, max_posts?, since?}`, with `omitempty` fields.

- They are stored per submission and inherited by children (`app/service.go:233-237`) and by continuation pages.
- **Validation:** `max_posts ≤ 100000`; `since` is RFC 3339.

**`captureTargetMatches(options, target)`** filters only **member** targets of a **collection** page:

- `omit_shared` excludes `post_type` `quote` and `repost`.
- `skip_references` excludes `repost` (quotes are kept because they have their own content). On a non-collection page, it also skips every non-collection target (§3.7 step 6).
- `media_only` excludes targets with empty `media_types`.
- `since` excludes targets whose `published_at` is unparseable or earlier than `since`. Equality matches (`app/capture_options_test.go:18-44`).

**`max_posts`** becomes the first page's `collection_limit`, with `page_size = min(max_posts, 100)`. Filtered-out targets do not count toward it, so pagination continues past pages with no matching posts (`app/capture_options_test.go:63-100`).

### 5.4 Capture records (`app/capture_records.go`)

**Definition.** A record is a top-level submission, newest first, with page size 30. Its criteria are `parent_submission IS NULL`, `input <> ''`, and a key outside the excluded prefixes (§3.2.3).

- Refresh submissions and "more"/"page_retry" pages are records.
- Members never are; `CaptureRecord(member)` gives `ErrNotFound`.

**Cursor:** base64url (no padding) of `JSON{Time, Bytes, ID, Filter}` with `Filter = "captures"`, or `"members:<id>:<state>"` for members. An invalid or mismatched cursor gives `invalid cursor` (`:163-181`).

**Record fields** (`:20-49,112-131`):

- `id` (submission), `job_id` (capture), `collection_id`
- `saved` (the collection is still saved)
- `url`, `input`, `platform`, `kind`
- `state`, `error`, `created_at`, `finished_at`
- `media {total, ready, failed}`: the record's own capture assets
- `done = state ∈ {complete, partial, failed}`
- For collection records (`is_collection && related_state <> 'none'`), `memberProgress` adds (`:134-161`):
  - `members`: §5.5;
  - `stopped`;
  - `done = members.done || stopped`;
  - `pages`, when done and not stopped: `more` = the last page's `next_page_cursor` is non-empty; `more_1000` = `more && last page max_batch_size ≥ 1000`; `failed` = any page capture is failed/partial, any page related task failed, or the record state is failed/partial;
  - `retryable`, when done: the count of distinct failed member captures on pages whose `related_state = 'complete'`, that are not stopped, and whose collection's `source_state` is null.

**`CaptureRecord(id)` detail** (`:215-251`):

- `warnings` (from the capture's revision payload).
- `media_items` (≤500, by position: `position`, `kind`, `purpose`, `state`, `error`).
- `reasons` (§5.5).

**`CaptureMembers(id, state, cursor)`** (`:256-307`):

- `state` filters: `""` (all), `problem` (failed and partial), `pending` (queued and downloading), `failed`, `partial`, `complete`. Anything else gives `ErrInvalidFilter`.
- Page size 50, ordered by `created_at, id` **ascending**.
- Each item has `job_id`, `collection_id`, `saved`, `url`, `state`, `error`, `created_at`, `gone` (`source_state` set), and `reasons`: the distinct failed asset errors ∪ the revision warnings when the capture is partial, sorted.

**`RetryCaptureRecord(id, key)`** (`:349-376`):

- If the collection is no longer saved, re-save it through `CaptureURL(url, key, options)`, which uses the current account.
- Otherwise use `recaptureInput(restart=false)`: refresh through the saved source, or start over with the current selection if the last capture failed. The record's options are applied.
- Either way it creates a **new record**; the old one is unchanged.

**`RetryCaptureMembers(id, memberJobId?)`** and `retryFailedMembers` (`:381-402`, `app/batch.go:300-327`):

- Select the retryable members (the same criteria as `retryable`), optionally only the one whose capture is `memberJobId`.
- **Rename each member submission's `idem_key` to `retried:<id>`**, set each affected page's `related_state='pending'`, and enqueue `related` for those pages.
- The page's related task then re-submits those targets under the original `related:<sid>:<i>` keys, which are now free, creating new captures. The others are idempotent replays.
- It returns the count. The retried member replaces the failed one in progress.

**`CaptureRecordPage(id, op, key)`** (`:407-445`):

- Requires `pages != null`, that is a done, non-stopped collection record. Otherwise `ErrUnsupported`.
- `op ∈ {more, more1000}` uses idem key `more:<id>`. `page_retry` uses `page-retry:<key or uuid>`. Any other op gives `ErrUnsupported`.
- With no next cursor and not a retry: `ErrNoMorePages` (`no more pages`).
- Reads the last page of the chain (max depth).

**`LibrarySize`** = `{collections: saved count, records, running}` (`app/delete_all.go:18-25`).

### 5.5 Collection progress (`channelCollection`, `app/channel_api.go:245-295`)

Input: a record submission id.

- **`pages`:** the chain via `next_submission`, recursive, depth < 1000 (`app/collection_progress.go:12-15`).
- **`members`:** the distinct capture ids of child submissions with `idem_key LIKE 'related:%'` under any page.

Fields:

- `complete` / `partial` / `failed` / `pending`: member captures by state (pending = queued or downloading).
- `total` = **count of distinct `related_targets[*].url` across all pages**. It includes targets skipped by filters or limits, and references.
- `next` = the last page's `next_page_cursor`. `max_batch` = the last page's `max_batch_size`.
- `stopped` = any page is stopped.
- `done` = the first page's capture is `failed`, **or** it is `complete`/`partial` and no page is "pending" and `pending == 0`. A page is pending when its capture is queued/downloading, or its `related_state='pending'` while its capture is not failed.
- `error = "partial_pages"` if any page capture is failed/partial or any page's `related_state='failed'`.
- **`reasons`:** across pages and members, the union of:
  - failed captures' `error`;
  - failed assets' `error`;
  - warnings of partial captures' revisions;
  - failed pages' `related_error`.

  Each reason is counted once per capture (`count(DISTINCT capture)`), non-empty only, and ordered by count desc then reason.

Test expectations: `app/collection_progress_test.go:96-161`, `app/capture_records_test.go:81-95`.

### 5.6 Stop (`app/collection_progress.go:19-46`)

- Only for submissions whose capture `is_collection`; otherwise `ErrUnsupported`.
- Recursively mark the submission, its children (`parent_submission`), its `next_submission` chain and submissions with key `batch:<id>` with `collection_stopped = true`. Every `related_state='pending'` among them becomes `complete`.
- **Effects:**
  - Submit with a stopped parent gives `errCollectionStopped`.
  - Related tasks of stopped submissions do nothing.
  - `deliveries` skips them.
  - Already queued member captures still run to completion.
- Stop is idempotent.

---

## 6. Other areas

### 6.1 Read-side derived data on collections

This is not capture, but tests encode it (`app/entities.go:168-619`).

- **`hydrateGraph`:**
  - `collection.assets` = the capture's assets with `purpose == ''`.
  - Each graph entity gets `assets` for the positions in its `resource_indices`, purposed ones included.
- **`saved_collection_id` per entity:** the saved collection whose head revision's root entity is this entity.
  - Fallback: an alias with the same platform and external id, where the alias's collection kind matches and its head root entity has the same entity type and platform.
  - The first priority is direct-rooted, then the newest save (`app/entities.go:234-312`).
  - Tests: `app/entity_aliases_test.go:55-139`.
- **Saved avatars:** an entity linked to a saved collection with no ready avatar of its own borrows the ready `avatar` asset of that collection head's **root** entity, never another account in the same capture (`app/entities.go:547-607`; `app/saved_avatar_test.go`).
- **Saved summaries:** for entities that the root `quoted`/`reposted`, if they are saved, show `saved_summary`, `saved_text` and `saved_author` (the `authored_by` target of the saved head's root, linked recursively), and append that post's content assets (`app/entities.go:316-435`).
- **`current`:** for entities that are an `authored_by` target (other than the root), the newest entity version observed as a root or as a root's direct author, with its avatar and counts. It is set only if it differs from the snapshot's version (`app/entities.go:453-533`; `app/current_profile_test.go:51-113`).
- **Incoming relations** (`app/incoming_relations.go:15-131`): for the root entity, find saved revisions anywhere with a `reposted`/`quoted` edge **into** an entity of the same identity. For each distinct source identity, report the type, the source's latest saved version (and its `authored_by` author) and links. The captured graph is never changed, and the source must remain saved (`app/incoming_relations_test.go:64-175`).
- **Storage bytes** of a collection (`app/web.go:360-371`): the sum of revision `content_bytes`, plus distinct `(blob hash, size)` over all revisions' capture assets, plus source response sizes of complete/partial captures.
- **Revisions list:** 20 per page, newest first (`app/web.go:206-251`).
- **`CaptureCollection(captureId)`** pins delivery to that capture's revision (`app/service.go:685-721`).

### 6.2 Delete

**`DeleteCollection(id)`** (`app/service.go:430-463`):

1. If it is not saved: `ErrNotFound`.
2. Lock it, delete the saved row (tag links cascade), prune orphan tags, then `mark_unreferenced(id)`.
3. Content stays until retention GC. Revisions are unreadable immediately, because reads require "saved".
4. An in-flight capture is neither killed nor allowed to resurrect the save. Its collection is collected after it completes (`app/public_test.go:355-369`).

**`DeleteAll(before)`** (`app/delete_all.go:31-76`). The API requires the body `{"confirm":"delete all"}` and uses `before = now()`.

1. Lock all collections saved with `created_at ≤ before`.
2. Count the records up to `before`.
3. Delete those saved rows, prune tags, and `mark_unreferenced` each.
4. **Delete all submissions with `created_at ≤ before`.** This stops pending related tasks and continuation pages, which find their submission gone.
5. [channel] Settle pending deliveries.
6. Return `{collections, records}`. Running is 0. On error the result is `{}`.

Properties: it is idempotent, and saves after the cutoff survive (`app/delete_all_test.go:18-116`).

The plan says deletion takes effect immediately in TS and drops `collection_retention_days`. Decide whether "immediately" means physical deletion (then the in-flight capture and pending-delivery exclusions of GC still apply) or only invisibility.

### 6.3 Refresh batches (`app/batch.go`)

**`StartRefreshBatch(ids)`** (`:25-71`):

- Parse each id as a UUID (else `ErrUnsupported`) and deduplicate, keeping the first-seen order.
- Require 1..500 ids, else `ErrUnsupported`. Every id must be saved, else `ErrNotFound`.
- Insert the batch, enqueue `refresh_batch`, and return the progress snapshot.

**`refreshBatch` task** (`:187-252`):

- If the batch is gone, OK. If it is not `running`, OK.
- If it was created more than 1 day ago: fail it with `capture service unavailable`.
- For each `position` from the stored position onwards:
  - A no-longer-saved collection counts as **rejected**.
  - [registry] An unavailable adapter snoozes 1 min.
  - Otherwise `Submit{RefreshID: id, Key: "refresh-batch:<batch>:<position>"}`:
    - `ErrRate` → snooze 1 min [MT].
    - `ErrQuota` → fail the batch with `storage quota exceeded` [MT].
    - `ErrNotFound`, `ErrUnsupported` or `ErrConnection` → rejected. The rest continues.
    - Any other error → task error (retry).
  - **Persist after each item**, guarded by `WHERE position = <expected>`:
    - for a rejected item: `position+1`, `rejected+1`;
    - otherwise: `position+1`, `reused += (job state not queued/downloading)`, and append `job.id` to `capture_ids`.
  - Replays therefore never submit twice.
- When the loop ends: `state='complete'`. This means "everything submitted", not finished.

**Progress** (`scanRefreshBatch`, `:100-183`):

- `total` = the number of ids; `submitted` = `position`; `reused`; `rejected`.
- `running` / `complete` / `partial` / `failed` over `capture_ids` states.
- **`members`:**
  - The pages are the collection roots (submissions with key `refresh-batch:<id>:<i>` whose capture `is_collection`) plus their `next_submission` chains.
  - `total` = max(distinct member captures, distinct target URLs). It is known as soon as a listing is fetched, before members are submitted.
  - Plus per-state counts.
  - `done` = no page has `related_state='pending'` and `pending == 0`.
- `retryable`: §5.4 criteria over these pages, **zeroed unless the batch is done**.
- `done` = `state != 'running' && running == 0 && members.done`.
- **`active[]`:** in batch order, the root items still running or with members not done, each with `{url, collection_id, collection (its latest saved content), running, members}`.

**`RetryRefreshBatch`** (`:269-293`): if the batch is not done, `errBatchRunning` (`refresh batch is still running`). Otherwise `retryFailedMembers` over the batch pages and return the count. Members whose source is gone are excluded.

**Every member of a refreshed profile is fetched again** (`recheck`), regardless of `updated_at` (`app/batch_test.go:167-171`; `single:1-8`).

### 6.4 Annotations and tags (`app/annotations.go`)

**Read:** the note plus the tags (sorted by name, id) of a saved collection, else `ErrNotFound`.

**`UpdateAnnotation(id, {note?, tag_ids?, tag_names?})`**

- **Validation** (`:91-115`):
  - note ≤10000 runes with no NUL;
  - `tag_names` ≤100, cannot be combined with `tag_ids`, each trimmed non-empty, ≤64 runes, no NUL;
  - `tag_ids` ≤100 valid UUIDs;
  - otherwise `ErrInvalidAnnotation` (`invalid note or tags`).
- **Apply** (`:116-166`), atomically:
  - set the note if given;
  - upsert `tag_names` (trimmed) into ids;
  - every tag id must exist, else `ErrNotFound` and nothing changes;
  - replace the collection's tag set;
  - prune orphan tags;
  - return the annotation.
- Clearing tags keeps the note. Duplicate names or ids collapse (`app/annotations_test.go:16-153`).

### 6.5 Accounts and credentials

**Encryption** (`internal/credentials/vault.go`):

- The key is `CREDENTIAL_KEY` (or the contents of `CREDENTIAL_KEY_FILE`), base64 of exactly 32 bytes. The cipher is **AES-256-GCM**.
- **Seal:** a random 12-byte nonce; stored `nonce || ciphertext||tag`; **AAD = `"<tenant>:<credential_ref uuid>"`**.
- Credentials are 1..16384 bytes.
- The plan derives the key from `SECRET_KEY`. The AAD should become just the ref id (or a fixed prefix plus the ref).

**Add an account** (`AddAccount` + `ImportConnection`, `app/accounts.go:61-98`, `app/connections.go:27-140`):

1. Check the input: the credential is non-empty; `name` is ≤100 bytes, defaulting to `采集账号`. Otherwise `ErrInvalidAccount`.
2. The platform must "accept accounts": it has a default `session` provider with `credential.prepare` and `connection.check`, and the vault is configured. Otherwise `ErrUnsupported`.
3. `PrepareCredential(provider, input)` (10 s) → `Credential` (validated 1..16384 bytes, else `adapter returned invalid credential`).
4. Seal it under a new `ref` uuid.
5. `CheckConnection(provider, credential)` (40 s), which needs a non-empty `account_id`. Its errors are wrapped as `account verification failed: …`.
6. In one transaction:
   1. **Upsert by verified account:** if a non-revoked connection with the same adapter, provider and `account_id` exists, reuse its id.
   2. If the target id already has a different `account_id`: `ErrConnection`.
   3. Insert the credential row.
   4. Upsert the connection with `state='ready'`, the new `credential_ref` and `username`; on update, `revision = revision + 1`.
   5. **Select it** as that adapter's account.
   6. Delete orphan credential rows.
7. Adapter errors INVALID_ARGUMENT, UNAUTHENTICATED, PERMISSION_DENIED and FAILED_PRECONDITION become `ErrInvalidCredential` (`invalid credentials`).
8. Concurrent imports of the same account give one connection (`app/account_upsert_test.go:23-80`).

**Revoke** (`app/connections.go:142-160`): `state='revoked'`, `credential_ref=NULL`, `revision+1`; clear any selection pointing to it; delete orphan credentials. Saved collections stay.

- **Pending captures:** their next `validateExecution` (capture commit, download, cache reuse, finalize) fails with `ErrConnection`, so the capture fails with `账号不可用，请在采集账号中选择可用账号或重新授权。`.
- **Account-delete flow:** confirmation is needed (result code `confirm_account_delete`, then `account_deleted`), and it is idempotent (`app/channel_actions.go:286-308`).

**`CheckConnection(id)`** (`app/connections.go:208-258`):

- Decrypt the credential and call the adapter.
- UNAUTHENTICATED → `reauth_required` (when the revision matches).
- On success, update `username` when `revision`, `state=ready` and `account_id` still match, else `ErrConnection`.

**Selection** (`SelectAccount`, `app/accounts.go:102-143`):

- **Per adapter.** An empty connection means anonymous, which requires a default `none` provider (`ErrAccountRequired` for Instagram, `ErrUnsupported` otherwise).
- A non-empty connection must exist (`ErrNotFound`), belong to that adapter (`ErrNotFound`), and be `ready` (`ErrConnection`).
- The bot argument `public:<adapter>` selects anonymous for one adapter. Plain `public` does so only when there is exactly one adapter (`app/channel_actions.go:309-320`).
- `DefaultConnection(adapter)` = the selection or `''` (`app/connections.go:267-277`).

**Accounts list:**

- **Platforms:** `{id, name, help = credential_help, public (has a default none provider), can_add, selected}`.
- **Accounts:** the non-revoked ones, ordered by `name, id`: `{id, name, username, state, platform, selected}` (`app/channel_actions.go:228-284`).

### 6.6 Maintenance (`app/maintenance.go:37-197`)

It runs every minute. The steps are independent: errors are joined and the remaining steps still run.

1. **Terminal jobs:** discarded or cancelled queue jobs not yet reconciled get `fail(task, "job exhausted retries or was interrupted")`, then are marked reconciled. Batches of 100 (`:70-109`).
2. **Stale captures:** captures `queued`/`downloading` older than **1 h** with no live job for the capture or any of its assets get `fail({type: capture}, "capture was interrupted")`. Batches of 100 (`:115-141`; `app/maintenance_test.go:38-154`).
3. **Unreferenced collections:** `collect_unreferenced_collections(retention_days × 1 day)`, repeated while 100 are removed, within a 30 s budget (`:143-154`).
   - **Busy collections must not starve the batch.** With 105 busy and 1 free, the free one is collected, because exclusion happens in the candidate query.
4. **Superseded raw responses:** `prune_source_responses(7 days, 100)`, repeated (`:158-169`).
   - **Kept:** raw of captures that produced a revision (even if old), raw younger than 7 days, and the newest capture's raw (`app/prune_raw_test.go:16-57`).
5. **Garbage objects** (§4.6).
6. **Thumbnail backfill** (§4.5).
7. [dropped] Web sessions cleanup and queue metrics.

---

## 7. User-facing message texts

### 7.1 Chinese strings produced by the core (preserve verbatim)

| text                                                 | where                                                 | when                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `此平台需要账号，请先添加并选择自己的采集凭据。`     | `app/worker.go:142` (`safeError(ErrAccountRequired)`) | Shown as a failure or error, for example a bot save of an Instagram link without an account (`app/instagram_runtime_test.go:74`). |
| `账号不可用，请在采集账号中选择可用账号或重新授权。` | `app/worker.go:145` (`safeError(ErrConnection)`)      | Stored as the capture or asset error when the account is unusable, rotated or revoked.                                            |
| `采集账号`                                           | `app/accounts.go:67`                                  | Default account name.                                                                                                             |

### 7.2 Chinese strings produced by adapters

These are kept automatically by reusing the adapter code. They appear as warnings, summaries or help text.

- **X:**
  - `已达单次翻页上限。` (`x/profile.ts:286`)
  - `帖子获取中断。` (`x/profile.ts:339,365,493`)
  - `帖子受保护，需添加有访问权限的采集账号。` (`x/strategy.ts:286,347`)
  - `未能确认帖子媒体信息。`, `不支持此类媒体。`, `部分媒体缺少有效下载地址。`, `不支持文章正文。` (`x/provider.ts:169-228`)
  - The summary format is `<author or 未知作者>：<text><[图片]/[视频] markers>` (`x/provider.ts:235-238`).
  - Credential help: `Base64 Cookie，需包含 auth_token 和 ct0。` (`x/server.ts:107`).
- **Instagram:**
  - `部分 Instagram 原始响应超出保存限制。` (`ig/strategy.ts:207`)
  - `已达单次 Instagram 翻页上限。` (`ig/strategy.ts:281`)
  - `Instagram 时间线读取失败。` (`ig/strategy.ts:299`)
  - `部分 Instagram 图片或视频未提供可下载地址。` (`ig/entities.ts:301`)
  - The summary format is `<author or Instagram>：<text or 图片或视频>` (`ig/entities.ts:317`).
  - Credential help: `Base64 浏览器 Cookie，需包含 sessionid；保留 csrftoken、ds_user_id、mid 和 ig_did。` (`ig/server.ts:89`).

### 7.3 English messages stored in `captures.error`, `assets.error`, `related_error` and `refresh_batches.error`

These are user-visible in records and reasons. They are listed so the same texts are reproduced.

- **Capture:**
  - `no text or media could be saved`
  - `joined a running capture of the same content`
  - `capture was interrupted`
  - `job exhausted retries or was interrupted`
  - `adapter returned mismatched identity`
  - `text exceeds collection limit`
  - `resource metadata exceeds limit`
  - `invalid resource`
  - `invalid entity graph size`
  - `invalid entity identity or undeclared type`
  - `undeclared entity schema`
  - `entity graph exceeds limit`
  - `entity data does not match adapter schema`
  - `invalid entity resource reference`
  - `entity root does not match capture identity`
  - `missing entity root`
  - `invalid entity relation`
  - `duplicate entity relation`
  - `invalid source response`
  - `source responses exceed limit`
  - `undeclared or invalid page continuation`
  - `invalid canonical target`
  - `undeclared related capture capability`
  - `related capture page exceeds 512 targets`
  - `invalid related target`
  - `undeclared or oversized related prefetch`
  - The adapter's own status messages (§2.8)
  - `provider operation unsupported`
  - `operation failed; retry or inspect service health`
- **Asset:**
  - `invalid media URL`
  - `media provider rejected request`
  - `empty media`
  - `unsupported media format`
  - After retries, a transient failure shows `operation failed; retry or inspect service health`.
- **Related:** `parent capture failed`.
- **Thumbnail** (not shown): `unsupported media format`, `thumbnail rendering failed`.
- **Batch:** `capture service unavailable`.
- **Payload warning:** `resource omitted: unsupported type or resource limit`.
- **API errors** (`internal/httpapi/server.go:403-458`):

  | status | message                                                                                                                                                                 |
  | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 400    | `unsupported URL`, `invalid cursor`, `idempotency key too long`, `invalid collection filters`, `invalid note or tags`, `invalid credentials`, `invalid account request` |
  | 404    | `not found`                                                                                                                                                             |
  | 409    | `idempotency key conflicts with an earlier request`, `no more pages`                                                                                                    |
  | 422    | `account required; add and select your own credentials`, `account unavailable; choose a source or authorize again`, `ErrUnsupported` text                               |
  | 503    | `adapter temporarily unavailable` (for UNAVAILABLE/DEADLINE_EXCEEDED)                                                                                                   |
  | 500    | `internal error`                                                                                                                                                        |

---

## 8. Subtle invariants and edge cases (checked by tests)

1. **I-1. Submitting an already-stored post never fetches.** Only `refresh_on_submit` targets (profiles), `RefreshID`, page cursors, collection-page members (`recheck`) and stale automatic targets refetch. The returned job may already be `complete` (`app/public_test.go:199-204`, `app/connections_test.go:133-143`; `app/service.go:328-346`).
2. **I-2. Coalescing.** Concurrent identical submits with different keys share one capture and one fetch (`app/integration_test.go:233-255`).
   - An explicit request for a `collection` target never joins an automatic capture (`app/collection_progress_test.go:76-83`).
   - When `collection` is unset, an explicit request may join one, and the related task then runs `related-expand` (`app/related_test.go:168-183`).
3. **I-3. Finalize is enqueued exactly once, by the last asset to settle.** It is also enqueued directly when there are no assets. The fallback `related` task is scheduled +10 s while the capture runs, and finalize adds an immediate one (`app/finalize_settled_test.go:57-77`). This needs asset completions of a capture to be serialized (the Go tenant lock).
4. **I-4. Every handler is replay-safe**: capture, download, finalize, related, thumbnail and refresh_batch (`app/integration_test.go:268-274,366-369`; `app/related_test.go:96-97`).
5. **I-5. A capture that canonicalizes onto a running capture is marked `failed`.** Its message is `joined a running capture of the same content`. Its submissions and batch `capture_ids` move to the running one, so failure counts must not double count (`app/batch_retry_test.go:197-240`).
6. **I-6. Revision dedup ignores** context entities' data and media, author_name/summary (when context exists), entity key numbering and order, DB ids, and declared metric paths. It **includes** content media hash, alt text, sensitive flag and asset state/error (§3.6.3).
7. **I-7. The old revision's data keeps the old counts** when they were stored before metric paths were declared. Comparison strips them with the current paths (`app/observed_metrics_test.go:17-92`).
8. **I-8. `ensure_entity_version` never updates stored data.** The hash includes schema and media state, so a schema change produces a new version.
9. **I-9. Members of a collection page are always refetched** on refresh, even if unchanged (`app/batch_test.go:167-171`).
10. **I-10. Limits:**
    - Collection references never consume `collection_limit`.
    - Filtered-out targets do not count.
    - With options, a page with 0 matching members still continues. Without options, it ends continuation.
    - Progress `total` counts all distinct target URLs (`app/collection_progress_test.go:283-320`; `app/capture_options_test.go:63-100`).
11. **I-11. "more" twice gives the same job** (`more:<id>`). Each continuation via "more" is a new record that inherits `capture_options` exactly (`app/capture_records_test.go:176-259`).
12. **I-12. Retrying failed members** renames their keys to `retried:<id>`, replaces them in progress (Total unchanged), and excludes `source_state`-gone members. A second retry retries only what failed again. Retrying a running batch gives `errBatchRunning` (`app/batch_retry_test.go:50-195`).
13. **I-13. Deferred credential:** each attempt first fetches without the credential. The credential fetch happens only after a `credential-required` trailer, inside the connection turn. Expected sequences are `[false]` or `[false, false, true]` across a snooze (`app/deferred_credential_test.go:44-93`).
14. **I-14. Credential rotation during a fetch** discards the result with `ErrConnection`. UNAUTHENTICATED sets `reauth_required`. Revoking an account fails its pending captures at finalize (`app/connections_test.go:229-321`).
15. **I-15. Retry or refresh of a failed capture uses the account selected now**, while the old capture's connection is unchanged (`app/retry_account_test.go:19-76`). A normal refresh uses the source that saved the collection.
16. **I-16. Instagram without an account gives `ErrAccountRequired`, never an anonymous fallback.** This holds even after the selected account is revoked (`app/instagram_test.go:93-99,150-153`; `app/instagram_runtime_test.go:69-87`).
17. **I-17. Raw responses:** keep the earliest that fit 4 MiB; the count is unlimited; store byte-for-byte; they must be valid JSON. They are deleted when the capture fails and pruned when superseded (7 days, no revision, not newest).
18. **I-18. Media:**
    - An identical-bytes blob is uploaded once.
    - Immutable-key reuse skips HTTP entirely.
    - A new key with known bytes downloads but does not upload.
    - A broken image still becomes a `ready` asset; only its thumbnail fails permanently.
    - GIF and other formats fail as `unsupported media format`.
    - Thumbnails are per blob, never per asset (`app/image_dedup_test.go`, `app/thumbnail_test.go`).
19. **I-19. Deleting garbage keys that were never uploaded must succeed.** A failed object delete defers that object with backoff and does not stop the batch. The error contains `garbage objects: object ` (`app/maintenance_test.go`).
20. **I-20. `source_state` is set only from the trailer**, keeps prior revisions, and is cleared by the next successful capture. X marks `deleted` only from the public post API's 404 (`x/provider.ts:84-94`).
21. **I-21. Instagram 404 is NOT_FOUND**, which the core retries (it is not in the permanent list) before failing. X 404 is FAILED_PRECONDITION, which is permanent.
22. **I-22. Every Submit target is saved**, including automatic members and references. DeleteAll deletes submissions up to the cutoff, so pending fan-out stops, and a capture queued before DeleteAll does not resurrect the save (`app/connections_test.go:326-338`).
23. **I-23. Stop** is idempotent and durable. Children submitted after a stop fail with `errCollectionStopped`. Already queued children complete. A stopped record is `stopped && done` (`app/collection_progress_test.go:228-255`).
24. **I-24. Head means `created_at DESC, id DESC`** everywhere. Record and member cursors are `(created_at, id)` tuples. Members are listed ascending, records descending.
25. **I-25. jsonb formatting in tests.** Several Go tests compare jsonb text with spaces, such as `{"max_posts": 1, "omit_shared": true}` and `{"name": "Quoted author"}`. In TS, compare parsed values, not strings.
26. **I-26. Platform neutrality.** The core must not hard-code platform words (`x.com`, `twitter.com`, `auth_token`, `"X 帖子"`, …). Platform specifics live in the platform modules (`app/platform_boundary_test.go:115-126`).
27. **I-27. Related fan-out depth:**
    - A top-level post hydrates its references one level.
    - A collection page hydrates members, and each member hydrates its own references one more level.
    - References of references, and automatic collection targets, never expand (`app/service.go:389-396`; `app/related_test.go:58-189`).
