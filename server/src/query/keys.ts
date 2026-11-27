// The keys of the query language's `key:value` terms, on their own so that
// what must not load the parser (the database client's SQL functions) can
// know them too. `grammar.peggy` lists the same.
export const KEYS = [
  'from',
  'mentions',
  'quotes',
  'reposts',
  'reposted-by',
  'protected',
  'related',
  'rel',
  'is',
  'has',
  'domain',
  'lang',
  'platform',
  'since',
  'until',
  'within',
  'saved',
  'saved-since',
  'saved-until',
  'tag',
  'folder',
  'state',
  'type',
  'sensitive',
] as const

export type Key = (typeof KEYS)[number]
