package tgchannel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"path"
	"strings"
	"testing"

	"monitor/internal/channelapi"
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

func TestDeliveryResumesConfirmedParts(t *testing.T) {
	collection := domain.Collection{ID: "fixture", Text: strings.Repeat("long text ", 700)}
	full := collectionMessage(collection, "complete")
	parts := deliveryParts(full, nil)
	if len(parts) < 2 {
		t.Fatal("fixture must have multiple parts")
	}
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Work-Lease") != "lease" {
			t.Error("missing lease")
		}
		_ = json.NewEncoder(w).Encode(channelapi.Delivery{Chat: "101", State: "pending", Job: domain.Job{State: "complete"}, Collection: &collection})
	}))
	defer core.Close()
	var sent []string
	bot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		sent = append(sent, r.FormValue("text"))
		fmt.Fprint(w, `{"ok":true,"result":{"message_id":20,"chat":{"id":101,"type":"private"}}}`)
	}))
	defer bot.Close()
	r := Runner{API: &Client{Base: core.URL, Channel: "channel"}, Bot: &telegram.Client{Base: bot.URL, Token: "42:fixture", HTTP: bot.Client()}}
	work := channelapi.Work{ID: "work", Lease: "lease", Kind: "delivery", Progress: 1, MessageID: 19}
	var saved channelapi.Ack
	if err := r.deliver(context.Background(), work, func(a channelapi.Ack) error { saved = a; return nil }); err != nil {
		t.Fatal(err)
	}
	if len(sent) != len(parts)-1 || sent[0] != parts[1].text || !saved.Done || saved.Progress != len(parts) || saved.MessageID != 19 {
		t.Fatal("confirmed prefix resent or checkpoint lost", len(sent), saved)
	}
}

func TestNormalizeGroupAndCredentials(t *testing.T) {
	for _, tc := range []struct {
		input    string
		entities []telegram.Entity
		accepted bool
	}{
		{"/usage", nil, false},
		{"/usage@OurBot", []telegram.Entity{{Type: "bot_command", Length: 13}}, true},
		{"/usage@OtherBot", []telegram.Entity{{Type: "bot_command", Length: 15}}, false},
		{"@OurBot https://example.test/item", []telegram.Entity{{Type: "mention", Length: 7}}, true},
	} {
		m := &telegram.Message{ID: 1, Text: tc.input, Entities: tc.entities}
		m.From.ID = 101
		m.Chat.ID = -100
		m.Chat.Type = "supergroup"
		got := Normalize(telegram.Update{ID: 1, Message: m}, "OurBot")
		if (got.Actor != "") != tc.accepted {
			t.Fatalf("%s: actor=%q", tc.input, got.Actor)
		}
	}
	m := &telegram.Message{ID: 1, Text: "/account_add @fixture opaque-cookie label"}
	m.From.ID = 101
	m.Chat.ID = 101
	m.Chat.Type = "private"
	got := Normalize(telegram.Update{ID: 1, Message: m}, "OurBot")
	if got.Credential != "opaque-cookie label" || got.Text != "" || got.Argument != "" || len(got.URLs) > 0 {
		t.Fatal("credential duplicated in normal event fields")
	}
}

func TestMediaDeliveryResumesWithoutResendingAlbum(t *testing.T) {
	collection := domain.Collection{ID: "fixture", URL: "https://example.test/post", Visibility: "public", Text: strings.Repeat("长正文😀", 1000), Assets: []domain.Asset{{ID: "asset1", State: "ready", MIME: "image/png"}, {ID: "asset2", State: "ready", MIME: "image/png"}}}
	var img bytes.Buffer
	if err := png.Encode(&img, image.NewRGBA(image.Rect(0, 0, 13, 17))); err != nil {
		t.Fatal(err)
	}
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/assets/") {
			w.Write(img.Bytes())
			return
		}
		json.NewEncoder(w).Encode(channelapi.Delivery{Chat: "-42", ReplyTo: 123, State: "pending", Job: domain.Job{State: "complete"}, Collection: &collection})
	}))
	defer core.Close()
	albums, attempts, deletes := 0, 0, 0
	var text []string
	bot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.Header.Get("Content-Type"), "multipart/") {
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Error(err)
			}
			defer r.MultipartForm.RemoveAll()
		} else {
			r.ParseForm()
		}
		switch path.Base(r.URL.Path) {
		case "deleteMessage":
			deletes++
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		case "sendMediaGroup":
			albums++
			if r.FormValue("reply_to_message_id") != "123" {
				t.Error("album lost reply")
			}
			fmt.Fprint(w, `{"ok":true,"result":[{"message_id":7},{"message_id":8}]}`)
		case "sendMessage":
			attempts++
			if attempts == 1 {
				fmt.Fprint(w, `{"ok":false,"error_code":500}`)
				return
			}
			if len(text) == 0 && (!strings.Contains(r.FormValue("reply_markup"), "我也要存") || strings.Contains(r.FormValue("reply_markup"), "/list")) {
				t.Error("wrong group controls")
			}
			text = append(text, r.FormValue("text"))
			fmt.Fprint(w, `{"ok":true,"result":{"message_id":9}}`)
		default:
			t.Error("unexpected method", r.URL.Path)
		}
	}))
	defer bot.Close()
	runner := Runner{API: &Client{Base: core.URL, Channel: "channel"}, Bot: &telegram.Client{Base: bot.URL, Token: "fixture", HTTP: bot.Client()}}
	work := channelapi.Work{ID: "work", Lease: "lease", Kind: "delivery", MessageID: 5}
	var done bool
	save := func(a channelapi.Ack) error {
		work.Progress = a.Progress
		work.MessageID = a.MessageID
		done = a.Done
		return nil
	}
	if err := runner.deliver(context.Background(), work, save); err == nil {
		t.Fatal("expected transient text failure")
	}
	restarted := runner
	if err := restarted.deliver(context.Background(), work, save); err != nil {
		t.Fatal(err)
	}
	if albums != 1 || deletes != 1 || !done || strings.Join(text, "") != collectionMessage(collection, "complete") {
		t.Fatal("delivery lost or duplicated parts", albums, deletes, done)
	}
}

func TestPausedDeliveryDoesNotContactTelegram(t *testing.T) {
	core := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(channelapi.Delivery{Paused: true})
	}))
	defer core.Close()
	r := Runner{API: &Client{Base: core.URL}}
	var ack channelapi.Ack
	if err := r.deliver(context.Background(), channelapi.Work{Progress: 2, MessageID: 42}, func(a channelapi.Ack) error { ack = a; return nil }); err != nil {
		t.Fatal(err)
	}
	if ack.Done || ack.RetrySeconds <= 0 || ack.Progress != 2 || ack.MessageID != 42 {
		t.Fatal(ack)
	}
}

func TestCollectionControls(t *testing.T) {
	d := channelapi.Delivery{ProgressDetails: &channelapi.CollectionProgress{URL: "https://example.test/profile", CollectionID: "collection", Complete: 1, Next: "cursor", MaxBatch: 1000}}
	_, keys := collectionProgressMessage("submission", d, "https://collection.test/app/")
	contains := func(keys telegram.Keyboard, action string) bool {
		for _, row := range keys {
			for _, b := range row {
				if strings.HasPrefix(b.Data, action) {
					return true
				}
			}
		}
		return false
	}
	if keys[0][0].Text != "在 X 查看主页" || keys[len(keys)-1][0].WebApp == nil || keys[len(keys)-1][0].WebApp.URL != "https://collection.test/app/#/collection/collection" {
		t.Fatal("unclear profile navigation or missing mini app", keys)
	}
	if !contains(keys, "/collection_stop") {
		t.Fatal("missing stop")
	}
	d.ProgressDetails.Done = true
	_, keys = collectionProgressMessage("submission", d, "https://collection.test/app/")
	if contains(keys, "/collection_stop") || !contains(keys, "/more1000") {
		t.Fatal(keys)
	}
	d.ProgressDetails.Stopped = true
	text, keys := collectionProgressMessage("submission", d, "https://collection.test/app/")
	if !strings.Contains(text, "已中止") || contains(keys, "/more") || contains(keys, "/page_retry") || contains(keys, "/collection_stop") {
		t.Fatal(text, keys)
	}
}

func TestCollectionFailureSummary(t *testing.T) {
	d := channelapi.Delivery{ProgressDetails: &channelapi.CollectionProgress{Done: true, Total: 3, Partial: 2, Failed: 1, Reasons: []channelapi.FailureReason{{Reason: "storage quota exceeded", Count: 2}, {Reason: "account cannot access this post", Count: 1}}}}
	text, _ := collectionProgressMessage("submission", d, "https://collection.test/app/")
	for _, want := range []string{"内容不完整 2", "失败 1", "进行中 0", "存储配额不足（2 条）", "采集账号无权访问该帖子（1 条）"} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q: %s", want, text)
		}
	}
}
