package app

import (
	"testing"

	"monitor/internal/telegram"
)

func TestGroupRequiresBotMention(t *testing.T) {
	for _, tc := range []struct {
		name, text string
		entities   []telegram.Entity
		want       bool
	}{
		{"bare link", "https://x.com/a/status/20", nil, false},
		{"bare command", "/usage", []telegram.Entity{{Type: "bot_command", Length: 6}}, false},
		{"addressed command", "/usage@OurBot", []telegram.Entity{{Type: "bot_command", Length: 13}}, true},
		{"other bot", "/usage@OtherBot", []telegram.Entity{{Type: "bot_command", Length: 15}}, false},
		{"mention link", "@OurBot https://x.com/a/status/20", []telegram.Entity{{Type: "mention", Length: 7}}, true},
		{"prefix collision", "@OurBotExtra https://x.com/a/status/20", []telegram.Entity{{Type: "mention", Length: 12}}, false},
		{"code not mention", "@OurBot https://x.com/a/status/20", []telegram.Entity{{Type: "code", Length: 7}}, false},
		{"mention before command", "@ourbot /usage", []telegram.Entity{{Type: "mention", Length: 7}}, true},
		{"emoji offsets", "😀 @OurBot https://x.com/a/status/20", []telegram.Entity{{Type: "mention", Offset: 3, Length: 7}}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := &telegram.Message{Text: tc.text, Entities: tc.entities}
			if got := groupTrigger(m, "OurBot"); got != tc.want {
				t.Fatal(got)
			}
		})
	}
	m := &telegram.Message{Caption: "@OurBot https://x.com/a/status/20", CaptionEntities: []telegram.Entity{{Type: "mention", Length: 7}}}
	if !groupTrigger(m, "OurBot") {
		t.Fatal("caption mention ignored")
	}
}
