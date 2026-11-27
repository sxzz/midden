// The agent API's query language (docs/agent.md, "Query language"). This
// grammar only reads the shape of a query: words, quoted phrases, `#tags`
// and `key:value` atoms, `-` before one of them, uppercase `OR`, and
// parentheses. What the values mean is checked afterwards (`ast.ts`).
//
// `pnpm --filter @midden/server gen:query` writes `parser.generated.ts`
// from this file; a test checks that the two agree.
//
// Every node has `start` and `end`: offsets into the query, in UTF-16 code
// units, as JavaScript strings count them.

{{
  // Keys longest first, so that `saved` does not take `saved-since`.
  const KEYS = [
    'saved-since', 'saved-until', 'sensitive', 'mentions', 'platform',
    'reposts', 'quotes', 'domain', 'folder', 'within', 'saved', 'since',
    'until', 'state', 'from', 'lang', 'type', 'has', 'rel', 'tag', 'is',
  ]
}}

Query
  = _ body:Or? _ { return body ?? { type: 'empty', start: 0, end: 0 } }

// AND binds tighter than OR: `a b OR c` is `(a b) OR c`.
Or
  = head:And tail:(__ OrKeyword __ @And)* {
      return tail.length
        ? { type: 'or', items: [head, ...tail], start: range().start, end: range().end }
        : head
    }

And
  = head:Unary tail:(_ !OrKeyword @Unary)* {
      return tail.length
        ? { type: 'and', items: [head, ...tail], start: range().start, end: range().end }
        : head
    }

// `-` only starts a term: inside a word (`x-ray`) it is part of the word.
Unary "term"
  = "-" item:Primary {
      return { type: 'not', item, start: range().start, end: range().end }
    }
  / Primary

Primary
  = "(" _ @Or _ ")"
  / Phrase
  / Hashtag
  / Atom
  / Word

Phrase "quoted phrase"
  = '"' value:$[^"]* '"' {
      return { type: 'phrase', value, start: range().start, end: range().end }
    }

Hashtag "#tag"
  = [#＃] value:$TagChar+ {
      return { type: 'hashtag', value, start: range().start, end: range().end }
    }

// A known key and its value; anything else with a colon (`https://…`,
// `10:30`, `Re:ゼロ`) is a word.
Atom "key:value"
  = key:$([a-z] [a-z-]*) &{ return KEYS.includes(key) } ":"
    value:(QuotedValue / $ValueChar+) {
      const quoted = typeof value === 'object'
      return {
        type: 'atom',
        key,
        value: quoted ? value.value : value,
        quoted,
        start: range().start,
        end: range().end,
      }
    }

QuotedValue
  = '"' value:$[^"]* '"' { return { value } }

Word "word"
  = !OrKeyword !"-" value:$WordChar+ {
      return { type: 'word', value, start: range().start, end: range().end }
    }

OrKeyword
  = "OR" &(Space / ")" / !.)

WordChar
  = [^ \t\n\r　()"]

ValueChar
  = [^ \t\n\r　()"]

TagChar
  = [^ \t\n\r　()"#＃]

Space
  = [ \t\n\r　]

_ "space"
  = Space*

__ "space"
  = Space+
