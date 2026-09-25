package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

func TestCallbackValidation(t *testing.T) {
	id := uuid.NewString()
	for _, value := range []string{"/recent", "/usage", "/show " + id, "/refresh " + id, "/recent " + base64.RawURLEncoding.EncodeToString([]byte(id))} {
		if !validCallback(value) {
			t.Fatal(value)
		}
	}
	for _, value := range []string{"", "/refresh", "/show bad", "/recent bad", "/start", strings.Repeat("x", 65)} {
		if validCallback(value) {
			t.Fatal(value)
		}
	}
}

func TestTelegramUXIntegration(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker integration environment required")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	channel := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, e)
	identity, e := db.Resolve(ctx, channel, "42", 1<<30)
	must(t, e)
	other, e := db.Resolve(ctx, channel, "43", 1<<30)
	must(t, e)
	var mu sync.Mutex
	var methods []string
	nextMessageID := 90
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		must(t, r.ParseForm())
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		mu.Lock()
		methods = append(methods, method)
		mu.Unlock()
		switch method {
		case "sendMessage":
			nextMessageID++
			fmt.Fprintf(w, `{"ok":true,"result":{"message_id":%d}}`, nextMessageID)
		case "editMessageText":
			fmt.Fprintf(w, `{"ok":true,"result":{"message_id":%s}}`, r.Form.Get("message_id"))
		case "sendChatAction":
			w.Write([]byte(`{"ok":true,"result":true}`))
		default:
			t.Errorf("unexpected method %s", method)
		}
	}))
	defer h.Close()
	sender := &telegram.Client{Token: "test", Base: h.URL, HTTP: h.Client()}
	s := &Service{DB: db, Adapter: &fakeAdapter{text: "archived text"}, Config: Defaults(), Senders: map[string]Sender{channel: sender}}
	workers := river.NewWorkers()
	river.AddWorker(workers, &Worker{S: s})
	queue, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{Workers: workers, Queues: map[string]river.QueueConfig{"control": {MaxWorkers: 1}}})
	must(t, e)
	s.Queue = queue
	job, e := s.Submit(ctx, identity.TenantID, domain.CaptureInput{URL: "https://x.com/i/status/201", Key: uuid.NewString(), Origin: domain.Origin{IdentityID: identity.ID, ChannelID: channel, ChatID: "42"}})
	must(t, e)
	var sid string
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1`, job.ID).Scan(&sid)
	}))
	task := store.Task{Tenant: identity.TenantID, ID: sid, Type: "status"}
	var snooze *river.JobSnoozeError
	if err := s.submissionStatus(ctx, task); !errors.As(err, &snooze) {
		t.Fatal(err)
	}
	must(t, s.capture(ctx, store.Task{Tenant: identity.TenantID, ID: job.ID, Type: "capture"}))
	must(t, s.finalize(ctx, identity.TenantID, job.ID))
	// A new service instance must recover the status message ID from PostgreSQL.
	restarted := *s
	must(t, restarted.deliver(ctx, task))
	mu.Lock()
	before := len(methods)
	mu.Unlock()
	must(t, restarted.deliver(ctx, task))
	must(t, restarted.submissionStatus(ctx, task))
	mu.Lock()
	if len(methods) != before {
		t.Error("terminal delivery/status emitted duplicates")
	}
	if strings.Join(methods, ",") != "sendMessage,sendChatAction,editMessageText" {
		t.Error(methods)
	}
	mu.Unlock()

	var updateID int64
	inbox := func(tenant, user, action string, source ...int64) string {
		sourceID := int64(91)
		if len(source) > 0 {
			sourceID = source[0]
		}
		updateID++
		id := uuid.NewString()
		raw := []byte(fmt.Sprintf(`{"update_id":1,"callback_query":{"id":"cb","from":{"id":%s},"message":{"message_id":%d,"from":{"id":999,"is_bot":true},"chat":{"id":%s,"type":"private"}},"data":%q}}`, user, sourceID, user, action))
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO inbox(id,tenant_id,channel_id,update_id,payload) VALUES($1,$2,$3,$4,$5)`, id, tenant, channel, updateID, raw)
			return err
		}))
		must(t, restarted.processInbox(ctx, store.Task{Tenant: tenant, ID: id, Type: "inbox"}))
		return id
	}
	iid := inbox(identity.TenantID, "42", "/usage")
	var rid string
	var previous int64
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,message_id FROM replies WHERE inbox_id=$1`, iid).Scan(&rid, &previous)
	}))
	if previous != 0 {
		t.Fatal("callback would overwrite archived content", previous)
	}
	// Even replies persisted before this protection must not overwrite content.
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE replies SET message_id=91 WHERE id=$1`, rid)
		return err
	}))
	must(t, restarted.reply(ctx, store.Task{Tenant: identity.TenantID, ID: rid, Type: "reply"}))
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT message_id FROM replies WHERE id=$1`, rid).Scan(&previous)
	}))
	if previous == 91 {
		t.Fatal("delivery overwrote archived content")
	}
	menuID := previous
	iid = inbox(identity.TenantID, "42", "/usage", menuID)
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,message_id FROM replies WHERE inbox_id=$1`, iid).Scan(&rid, &previous)
	}))
	if previous != menuID {
		t.Fatal("non-content menu should remain editable")
	}
	must(t, restarted.reply(ctx, store.Task{Tenant: identity.TenantID, ID: rid, Type: "reply"}))

	// Foreign archive IDs in callbacks never create delivery or refresh submissions.
	for _, action := range []string{"/show " + job.ArchiveID, "/refresh " + job.ArchiveID, "/recent " + base64.RawURLEncoding.EncodeToString([]byte(job.ArchiveID))} {
		iid = inbox(other.TenantID, "43", action)
		var text string
		must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, `SELECT text FROM replies WHERE inbox_id=$1`, iid).Scan(&text)
		}))
		if !strings.Contains(text, "权限") {
			t.Fatal(text)
		}
	}
	iid = inbox(identity.TenantID, "42", "/refresh "+job.ArchiveID)
	must(t, restarted.processInbox(ctx, store.Task{Tenant: identity.TenantID, ID: iid, Type: "inbox"}))
	var count int
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM submissions WHERE idem_key=$1`, "refresh:"+iid).Scan(&count)
	}))
	if count != 1 {
		t.Fatal("duplicate refresh", count)
	}
	// Persisted buttons survive JSON serialization without exceeding Telegram's limit.
	b, _ := json.Marshal(archiveButtons(job.ArchiveID, "https://x.com/i/status/201"))
	var keyboard telegram.Keyboard
	must(t, json.Unmarshal(b, &keyboard))
	for _, row := range keyboard {
		for _, button := range row {
			if len(button.Data) > 64 {
				t.Fatal(button)
			}
		}
	}
}

func TestArchiveMessageHidesTechnicalMetadata(t *testing.T) {
	a := domain.Archive{ID: uuid.NewString(), RevisionID: uuid.NewString(), Text: "原帖正文", Assets: []domain.Asset{{State: "ready"}}}
	text := archiveMessage(a, "complete")
	if text != "已收藏 · 1 张图片\n\n原帖正文" {
		t.Fatal(text)
	}
	a.Text = ""
	a.Warnings = []string{"视频不支持"}
	a.Assets = append(a.Assets, domain.Asset{State: "failed", Error: "下载超时"})
	text = archiveMessage(a, "partial")
	if strings.Contains(text, a.ID) || !strings.Contains(text, "视频不支持") || !strings.Contains(text, "下载超时") {
		t.Fatal(text)
	}
}
