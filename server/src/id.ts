import { randomUUIDv7 } from 'node:crypto'

/**
 * Time-ordered ids: rows are often ordered by `(created_at, id)`, and a v7
 * UUID keeps that close to creation order.
 */
export function newId(): string {
  return randomUUIDv7()
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isId(value: string): boolean {
  return UUID.test(value)
}
