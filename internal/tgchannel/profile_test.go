package tgchannel

import (
	"encoding/json"
	"testing"

	"monitor/internal/telegram"
)

func TestNormalizeActorProfile(t *testing.T) {
	for _, raw := range []string{
		`{"update_id":1,"message":{"message_id":1,"from":{"id":42,"first_name":"小明","last_name":"张","username":"ming"},"chat":{"id":42,"type":"private"},"text":"/usage"}}`,
		`{"update_id":2,"callback_query":{"id":"cb","from":{"id":42,"first_name":"小明","last_name":"张","username":"ming"},"message":{"message_id":1,"from":{"id":999,"is_bot":true,"first_name":"Bot","username":"bot"},"chat":{"id":42,"type":"private"}},"data":"/usage"}}`,
	} {
		var update telegram.Update
		if err := json.Unmarshal([]byte(raw), &update); err != nil {
			t.Fatal(err)
		}
		event := Normalize(update, "bot")
		p := event.ActorProfile
		if event.Actor != "42" || p == nil || p.FirstName != "小明" || p.LastName != "张" || p.Username != "ming" {
			t.Fatalf("wrong actor profile: %+v", event)
		}
	}
}
