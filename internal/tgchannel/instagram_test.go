package tgchannel

import (
	"strings"
	"testing"

	"monitor/internal/channelapi"
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

func TestInstagramCarouselDeliveryAndOriginalButton(t *testing.T) {
	collection := domain.Collection{ID: "collection", URL: "https://www.instagram.com/p/C/", AuthorName: "Fixture", Text: "Caption", Graph: &domain.EntityGraph{Root: "post", Entities: []domain.Entity{{Key: "post", Type: "instagram.post"}, {Key: "author", Type: "instagram.profile", Data: []byte(`{"username":"fixture.name"}`)}}, Relations: []domain.EntityRelation{{Source: "post", Target: "author", Type: "authored_by"}}}, Assets: []domain.Asset{
		{ID: "first", State: "ready", MIME: "image/jpeg", Position: 0},
		{ID: "second", State: "ready", MIME: "video/mp4", Position: 1},
		{ID: "missing", State: "failed", Position: 2},
		{ID: "fourth", State: "ready", MIME: "image/jpeg", Position: 3},
	}}
	parts := deliveryParts(collectionMessage(collection, "partial"), collection.Assets)
	formatDeliveryParts(parts, collectionMessageEntities(collection))
	var ids []string
	linked := false
	for _, part := range parts {
		for _, asset := range part.assets {
			ids = append(ids, asset.ID)
		}
		for _, entity := range part.entities {
			if entity.Type == "text_link" && entity.URL == "https://www.instagram.com/fixture.name/" {
				linked = true
			}
		}
	}
	if strings.Join(ids, ",") != "first,second,fourth" || !linked {
		t.Fatal("Instagram carousel order or author link lost", ids, linked)
	}
	buttons := collectionButtons(collection.ID, collection.URL, "")
	if buttons[0][0].URL != collection.URL {
		t.Fatal("Instagram original button missing", buttons)
	}
}

func TestInstagramProfileProgressButtons(t *testing.T) {
	progress := &channelapi.CollectionProgress{URL: "https://www.instagram.com/fixture.name/", CollectionID: "profile", Total: 100, Complete: 96, Partial: 2, Failed: 2, Done: true, Next: "cursor", MaxBatch: 1000}
	text, buttons := collectionProgressMessage("batch", channelapi.Delivery{ProgressDetails: progress}, "")
	if !strings.Contains(text, "已保存 96") || buttons[0][0].Text != telegram.ProfileURLLabel(progress.URL) {
		t.Fatal(text, buttons)
	}
	actions := func(keys telegram.Keyboard) string {
		var out []string
		for _, row := range keys {
			for _, key := range row {
				out = append(out, key.Data)
			}
		}
		return strings.Join(out, ",")
	}
	if !strings.Contains(actions(buttons), "/more1000 batch") || !strings.Contains(actions(buttons), "/more batch") {
		t.Fatal(buttons)
	}
	progress.Error = "page failed"
	_, buttons = collectionProgressMessage("batch", channelapi.Delivery{ProgressDetails: progress}, "")
	if !strings.Contains(actions(buttons), "/page_retry batch") {
		t.Fatal(buttons)
	}
	progress.Done = false
	_, buttons = collectionProgressMessage("batch", channelapi.Delivery{ProgressDetails: progress}, "")
	if !strings.Contains(actions(buttons), "/collection_stop batch") {
		t.Fatal(buttons)
	}
	progress.Stopped = true
	text, buttons = collectionProgressMessage("batch", channelapi.Delivery{ProgressDetails: progress}, "")
	if !strings.Contains(text, "已中止") || strings.Contains(actions(buttons), "/more ") {
		t.Fatal(text, buttons)
	}
}

func TestInstagramRequiresOwnAccountInBot(t *testing.T) {
	r := &Runner{}
	out := r.accountResponse(channelapi.Event{Private: true}, channelapi.Result{Accounts: &channelapi.AccountList{Platforms: []channelapi.Platform{{ID: "instagram", Name: "Instagram", Public: false, CanAdd: true}, {ID: "x", Name: "X", Public: true}}}})
	if !strings.Contains(out.Text, "Instagram 需要添加并选择自己的账号凭据") {
		t.Fatal(out.Text)
	}
	foundX := false
	for _, row := range out.Buttons {
		for _, button := range row {
			if button.Data == "/account public:instagram" {
				t.Fatal("Instagram public source offered")
			}
			foundX = foundX || button.Data == "/account public:x"
		}
	}
	if !foundX {
		t.Fatal("X public source disappeared")
	}
	if text := failureReason("account required; add and select your own credentials"); !strings.Contains(text, "自己的采集凭据") {
		t.Fatal(text)
	}
}
