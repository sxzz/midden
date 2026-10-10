package store

import (
	"strings"
	"unicode"
)

// The migration runner reads SQL only far enough to tell code from quoted
// text and comments. That is all it takes to split a file into statements and
// to compare two files without caring how they are laid out.

type sqlScanner struct {
	src string
	pos int
}

type sqlPiece int

const (
	sqlCode sqlPiece = iota
	sqlSpace
	sqlComment
	sqlQuoted // 'text' or "identifier", kept byte for byte
	sqlDollar // $tag$ ... $tag$, a body or a literal
)

// next returns the following piece and its text. Dollar-quoted pieces are
// returned whole only when whole is set; otherwise the opening delimiter is
// ordinary code and the body is scanned like the rest of the file.
func (s *sqlScanner) next(whole bool) (sqlPiece, string, bool) {
	if s.pos >= len(s.src) {
		return 0, "", false
	}
	start := s.pos
	rest := s.src[start:]
	c := rest[0]
	switch {
	case c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f':
		for s.pos < len(s.src) && strings.IndexByte(" \t\n\r\f", s.src[s.pos]) >= 0 {
			s.pos++
		}
		return sqlSpace, s.src[start:s.pos], true
	case strings.HasPrefix(rest, "--"):
		if end := strings.IndexByte(rest, '\n'); end >= 0 {
			s.pos += end
		} else {
			s.pos = len(s.src)
		}
		return sqlComment, s.src[start:s.pos], true
	case strings.HasPrefix(rest, "/*"):
		// Block comments nest in PostgreSQL.
		depth := 0
		for s.pos < len(s.src) {
			switch {
			case strings.HasPrefix(s.src[s.pos:], "/*"):
				depth++
				s.pos += 2
			case strings.HasPrefix(s.src[s.pos:], "*/"):
				depth--
				s.pos += 2
			default:
				s.pos++
			}
			if depth == 0 {
				break
			}
		}
		return sqlComment, s.src[start:s.pos], true
	case c == '\'' || c == '"':
		// E'...' strings escape with a backslash; every string doubles its quote.
		escapes := c == '\'' && start > 0 && (s.src[start-1] == 'e' || s.src[start-1] == 'E') && (start < 2 || !identifierByte(s.src[start-2]))
		s.pos++
		for s.pos < len(s.src) {
			switch {
			case escapes && s.src[s.pos] == '\\':
				s.pos += 2
				continue
			case s.src[s.pos] != c:
				s.pos++
				continue
			case s.pos+1 < len(s.src) && s.src[s.pos+1] == c:
				s.pos += 2
				continue
			}
			s.pos++
			break
		}
		s.pos = min(s.pos, len(s.src))
		return sqlQuoted, s.src[start:s.pos], true
	case c == '$' && whole && (start == 0 || !identifierByte(s.src[start-1])):
		// $1 is a parameter and a$b an identifier; only $tag$ opens a quote.
		end := 1
		for end < len(rest) && identifierByte(rest[end]) && rest[end] != '$' {
			end++
		}
		if end < len(rest) && rest[end] == '$' && (end == 1 || !unicode.IsDigit(rune(rest[1]))) {
			tag := rest[:end+1]
			if closing := strings.Index(rest[end+1:], tag); closing >= 0 {
				s.pos += end + 1 + closing + len(tag)
			} else {
				s.pos = len(s.src)
			}
			return sqlDollar, s.src[start:s.pos], true
		}
	}
	s.pos++
	return sqlCode, s.src[start:s.pos], true
}

func identifierByte(c byte) bool {
	return c == '_' || c == '$' || c >= 0x80 || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
}

// splitSQL returns the statements of a file, without comment-only remains.
func splitSQL(src string) []string {
	var out []string
	var current strings.Builder
	meaningful := false
	flush := func() {
		if meaningful {
			out = append(out, strings.TrimSpace(current.String()))
		}
		current.Reset()
		meaningful = false
	}
	s := sqlScanner{src: src}
	for {
		kind, text, ok := s.next(true)
		if !ok {
			break
		}
		if kind == sqlCode && text == ";" {
			flush()
			continue
		}
		current.WriteString(text)
		meaningful = meaningful || (kind != sqlSpace && kind != sqlComment)
	}
	flush()
	return out
}

// normalizeSQL reduces a file to what a formatter leaves alone: comments and
// whitespace go, and letter case survives only inside quotes. Function bodies
// are formatted too, so dollar quotes are not treated as literal text. The
// result identifies a migration; it is never executed.
func normalizeSQL(src string) string {
	var out strings.Builder
	s := sqlScanner{src: src}
	for {
		kind, text, ok := s.next(false)
		if !ok {
			break
		}
		switch kind {
		case sqlCode:
			out.WriteString(strings.ToLower(text))
		case sqlQuoted:
			out.WriteString(text)
		}
	}
	return out.String()
}
