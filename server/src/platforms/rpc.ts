/**
 * The error vocabulary the platform code was written against: gRPC status
 * codes plus string trailers. Kept so platform errors classify the same way
 * now that they are thrown in-process rather than over gRPC.
 */
export const status = {
  OK: 0,
  CANCELLED: 1,
  UNKNOWN: 2,
  INVALID_ARGUMENT: 3,
  DEADLINE_EXCEEDED: 4,
  NOT_FOUND: 5,
  ALREADY_EXISTS: 6,
  PERMISSION_DENIED: 7,
  RESOURCE_EXHAUSTED: 8,
  FAILED_PRECONDITION: 9,
  ABORTED: 10,
  OUT_OF_RANGE: 11,
  UNIMPLEMENTED: 12,
  INTERNAL: 13,
  UNAVAILABLE: 14,
  DATA_LOSS: 15,
  UNAUTHENTICATED: 16,
} as const
// eslint-disable-next-line @typescript-eslint/no-redeclare -- a value and its type share the name
export type status = (typeof status)[keyof typeof status]

/** String key/value trailers attached to an error. */
export class Metadata {
  readonly #values = new Map<string, string[]>()

  set(key: string, value: string): void {
    this.#values.set(key.toLowerCase(), [value])
  }

  get(key: string): string[] {
    return this.#values.get(key.toLowerCase()) ?? []
  }
}
