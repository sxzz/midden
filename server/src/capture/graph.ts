import { Buffer } from 'node:buffer'
import { PermanentError } from '#jobs/queue.ts'
import { splitMetrics } from './metrics.ts'
import type {
  EntityType,
  FetchResponse,
  Provider,
} from '#platforms/protocol.ts'
import type { Metrics, PayloadGraph } from './payload.ts'

// Graph keys, entity type names and relation types.
export const ENTITY_NAME = /^[a-z][\w.-]{0,127}$/
const MAX_ENTITIES = 512
const MAX_RELATIONS = 1024
const MAX_GRAPH_BYTES = 2 << 20

export interface ValidatedGraph {
  graph: PayloadGraph
  metrics: Metrics
  metricPaths: Record<string, string[]>
}

const fail = (message: string): never => {
  throw new PermanentError(message)
}

/**
 * Check a fetched entity graph and normalize it: observed counts split out
 * of the data, entities sorted by key and relations by source|type|target,
 * since local ordering is not content.
 */
export function validateGraph(
  response: FetchResponse,
  provider: Provider,
  entityTypes: readonly EntityType[],
): ValidatedGraph | undefined {
  const source = response.graph
  if (!source) return undefined
  const rootId = response.canonicalTarget?.externalId || response.externalId
  if (
    source.entities.length === 0 ||
    source.entities.length > MAX_ENTITIES ||
    source.relations.length > MAX_RELATIONS
  )
    fail('实体图大小无效')
  const allowed = new Set(
    provider.capabilities.some(
      (c) => c.name === 'entity.graph' && c.major === 1,
    )
      ? provider.entityTypes
      : [],
  )
  const paths = new Map(entityTypes.map((t) => [t.name, t.metricPaths]))
  const graph: PayloadGraph = {
    root: source.root,
    entities: [],
    relations: [],
  }
  const metrics: Metrics = {}
  const metricPaths: Record<string, string[]> = {}
  const keys = new Set<string>()
  const identities = new Set<string>()
  let total = 0
  for (const entity of source.entities) {
    const identity = `${entity.type}\0${entity.externalId}`
    if (
      (entity.contextOnly && entity.key === source.root) ||
      !ENTITY_NAME.test(entity.key) ||
      keys.has(entity.key) ||
      !allowed.has(entity.type) ||
      !entity.externalId ||
      Buffer.byteLength(entity.externalId) > 200 ||
      entity.externalId.includes('\0') ||
      identities.has(identity)
    )
      fail('实体标识无效或类型未声明')
    keys.add(entity.key)
    identities.add(identity)
    total += entity.dataJson.length
    if (total > MAX_GRAPH_BYTES) fail('实体图超出上限')
    let data: unknown
    try {
      data = JSON.parse(Buffer.from(entity.dataJson).toString('utf8'))
    } catch {
      fail('实体数据不符合平台定义')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data))
      fail('实体数据不符合平台定义')
    const typePaths = paths.get(entity.type) ?? []
    if (typePaths.length) metricPaths[entity.type] = [...typePaths]
    const split = splitMetrics(data as Record<string, unknown>, typePaths)
    if (split.metrics)
      metrics[`${entity.type}/${entity.externalId}`] = split.metrics
    const seen = new Set<number>()
    for (const index of entity.resourceIndices) {
      if (index >= response.resources.length || seen.has(index))
        fail('实体引用的媒体无效')
      seen.add(index)
    }
    graph.entities.push({
      key: entity.key,
      type: entity.type,
      external_id: entity.externalId,
      data: split.data,
      ...(entity.resourceIndices.length
        ? { resource_indices: [...entity.resourceIndices] }
        : {}),
      ...(entity.contextOnly ? { context_only: true } : {}),
    })
    if (entity.key === source.root && entity.externalId !== rootId)
      fail('实体根与采集对象不符')
  }
  if (!keys.has(source.root)) fail('缺少实体根')
  const relations = new Set<string>()
  for (const relation of source.relations) {
    if (
      !keys.has(relation.source) ||
      !keys.has(relation.target) ||
      !ENTITY_NAME.test(relation.type)
    )
      fail('实体关系无效')
    const key = `${relation.source}|${relation.type}|${relation.target}`
    if (relations.has(key)) fail('实体关系重复')
    relations.add(key)
    graph.relations.push({
      source: relation.source,
      target: relation.target,
      type: relation.type,
    })
  }
  graph.entities.sort((a, b) => compare(a.key, b.key))
  const relationKey = (r: { source: string; type: string; target: string }) =>
    `${r.source}|${r.type}|${r.target}`
  graph.relations.sort((a, b) => compare(relationKey(a), relationKey(b)))
  return { graph, metrics, metricPaths }
}

// Byte order like Go's string comparison, not locale order.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}
