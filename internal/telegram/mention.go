package telegram

import (
	"strings"
	"unicode/utf16"
)

// AddressedText uses Telegram entities so links, quoted code and username prefixes
// do not accidentally address this bot. Mentions are removed only from command text.
func (m *Message) AddressedText(username string) (string, bool) {
	if username == "" {
		return m.Text, false
	}
	addressed := false
	clean := func(text string, entities []Entity) string {
		units := utf16.Encode([]rune(text))
		for _, e := range entities {
			if e.Offset < 0 || e.Length <= 0 || e.Offset > len(units) || e.Length > len(units)-e.Offset {
				continue
			}
			value := string(utf16.Decode(units[e.Offset : e.Offset+e.Length]))
			switch e.Type {
			case "mention":
				if strings.EqualFold(value, "@"+username) {
					addressed = true
					for i := e.Offset; i < e.Offset+e.Length; i++ {
						units[i] = ' '
					}
				}
			case "bot_command":
				parts := strings.SplitN(value, "@", 2)
				if len(parts) == 2 && strings.EqualFold(parts[1], username) {
					addressed = true
				}
			}
		}
		return strings.TrimSpace(string(utf16.Decode(units)))
	}
	text := clean(m.Text, m.Entities)
	clean(m.Caption, m.CaptionEntities)
	return text, addressed
}
