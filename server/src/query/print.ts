// The canonical form of a query (`parsed` in responses): values as they are
// compared, one space between terms, ` OR ` between alternatives, and
// parentheses only where they are needed and around an AND inside an OR,
// whose binding is easy to misread. Terms keep their order: the keyword
// search reads its words as a phrase too. Reading the printed form gives
// the same query back.
import type { QueryNode } from './ast.ts'

/** A value that would not read back as one bare value. */
const NEEDS_QUOTES = /[\s()"]/u

/** Inside quotes, a `"` is written twice. */
const quoted = (raw: string) => `"${raw.replaceAll('"', '""')}"`

function value(raw: string): string {
  return NEEDS_QUOTES.test(raw) || !raw ? quoted(raw) : raw
}

export function printQuery(node: QueryNode | undefined): string {
  if (!node) return ''
  switch (node.type) {
    case 'and':
      return node.items
        .map((item) =>
          item.type === 'or' ? `(${printQuery(item)})` : printQuery(item),
        )
        .join(' ')
    case 'or':
      return node.items
        .map((item) =>
          item.type === 'and' ? `(${printQuery(item)})` : printQuery(item),
        )
        .join(' OR ')
    case 'not':
      return `-${
        node.item.type === 'and' || node.item.type === 'or'
          ? `(${printQuery(node.item)})`
          : printQuery(node.item)
      }`
    case 'word':
      return node.value
    case 'phrase':
      return quoted(node.value)
    case 'hashtag':
      return `#${node.value}`
    case 'atom':
      return `${node.key}:${value(node.value)}`
  }
}
