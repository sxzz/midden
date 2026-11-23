/** Entity as stored in a capture or revision payload. */
export interface PayloadEntity {
  // Assigned when the entity is persisted at finalize.
  id?: string
  version_id?: string
  key: string
  type: string
  external_id: string
  /** Always an object; the graph check rejects anything else. */
  data: Record<string, unknown>
  resource_indices?: number[]
  context_only?: boolean
}

export interface PayloadRelation {
  source: string
  target: string
  type: string
}

export interface PayloadGraph {
  root: string
  entities: PayloadEntity[]
  relations: PayloadRelation[]
}

export type Metrics = Record<string, Record<string, unknown>>

/**
 * What a capture stored: staged on the capture until finalize, then kept as
 * the revision payload. Field names and omissions match the Go service.
 */
export interface Payload {
  author_name?: string
  published_at?: string
  summary?: string
  graph?: PayloadGraph
  media_sensitive?: boolean[]
  media_descriptions?: string[]
  text: string
  text_kind: string
  warnings: string[]
  adapter_version: string
  text_source?: string
  incomplete?: boolean
  // Observed counts by "<type>/<external id>", and where each type keeps
  // them in its data (also in older versions).
  metrics?: Metrics
  metric_paths?: Record<string, string[]>
}

export function metricKey(entity: {
  type: string
  external_id: string
}): string {
  return `${entity.type}/${entity.external_id}`
}
