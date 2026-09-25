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
	"sync/atomic"
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
	var toasts []string
	var sharedButtonSeen atomic.Bool
	nextMessageID := 90
	var expectedReplyTo atomic.Int64
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		must(t, r.ParseForm())
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		mu.Lock()
		methods = append(methods, method)
		mu.Unlock()
		if method == "sendMessage" || method == "editMessageText" {
			var markup map[string]json.RawMessage
			must(t, json.Unmarshal([]byte(r.Form.Get("reply_markup")), &markup))
			if string(markup["inline_keyboard"]) == "null" {
				t.Error("Telegram rejects a null inline keyboard")
				w.WriteHeader(http.StatusBadRequest)
				w.Write([]byte(`{"ok":false,"error_code":400,"description":"invalid keyboard"}`))
				return
			}
		}
		switch method {
		case "answerCallbackQuery":
			if r.Form.Get("show_alert") == "true" {
				t.Error("save feedback must be a toast")
			}
			mu.Lock()
			toasts = append(toasts, r.Form.Get("text"))
			mu.Unlock()
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		case "sendMessage":
			if strings.HasPrefix(r.Form.Get("chat_id"), "-") && strings.Contains(r.Form.Get("reply_markup"), "/recent") {
				t.Error("group keyboard exposed recent")
			}
			if strings.Contains(r.Form.Get("reply_markup"), "我也要存") {
				sharedButtonSeen.Store(true)
			}
			if strings.HasPrefix(r.Form.Get("chat_id"), "-") && r.Form.Get("reply_to_message_id") != fmt.Sprint(expectedReplyTo.Load()) {
				t.Errorf("wrong group reply target: %s", r.Form.Get("reply_to_message_id"))
			}
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
	s := &Service{DB: db, Adapter: &fakeAdapter{text: "archived text", textSource: "fxtwitter"}, Config: Defaults(), Senders: map[string]Sender{channel: sender}}
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
	archived, e := s.Archive(ctx, identity.TenantID, job.ArchiveID)
	must(t, e)
	if archived.TextSource != "fxtwitter" {
		t.Fatal("text provenance lost")
	}
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
	inboxChat := func(tenant, user, chat, action string, source ...int64) string {
		sourceID := int64(91)
		if len(source) > 0 {
			sourceID = source[0]
		}
		updateID++
		id := uuid.NewString()
		kind := "private"
		if strings.HasPrefix(chat, "-") {
			kind = "supergroup"
		}
		raw := []byte(fmt.Sprintf(`{"update_id":1,"callback_query":{"id":"cb","from":{"id":%s},"message":{"message_id":%d,"from":{"id":999,"is_bot":true},"chat":{"id":%s,"type":%q}},"data":%q}}`, user, sourceID, chat, kind, action))
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO inbox(id,tenant_id,channel_id,update_id,payload) VALUES($1,$2,$3,$4,$5)`, id, tenant, channel, updateID, raw)
			return err
		}))
		must(t, restarted.processInbox(ctx, store.Task{Tenant: tenant, ID: id, Type: "inbox"}))
		return id
	}
	inbox := func(tenant, user, action string, source ...int64) string {
		return inboxChat(tenant, user, user, action, source...)
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

	iid = inbox(other.TenantID, "43", "/recent")
	var emptyText, replyState string
	must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,text FROM replies WHERE inbox_id=$1`, iid).Scan(&rid, &emptyText)
	}))
	if emptyText != "暂无归档。" {
		t.Fatal(emptyText)
	}
	must(t, restarted.reply(ctx, store.Task{Tenant: other.TenantID, ID: rid, Type: "reply"}))
	must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM replies WHERE id=$1`, rid).Scan(&replyState)
	}))
	if replyState != "sent" {
		t.Fatal("empty archive list was not delivered", replyState)
	}

	// Group requests use the sender's identity, with persisted reply targets after restart.
	groupMessage := func(tenant, user, text string, messageID int64) string {
		updateID++
		id := uuid.NewString()
		raw := []byte(fmt.Sprintf(`{"update_id":1,"message":{"message_id":%d,"from":{"id":%s},"chat":{"id":-42,"type":"supergroup"},"text":%q}}`, messageID, user, text))
		must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
			_, err := tx.Exec(ctx, `INSERT INTO inbox(id,tenant_id,channel_id,update_id,payload) VALUES($1,$2,$3,$4,$5)`, id, tenant, channel, updateID, raw)
			return err
		}))
		must(t, restarted.processInbox(ctx, store.Task{Tenant: tenant, ID: id, Type: "inbox"}))
		return id
	}
	iid = groupMessage(identity.TenantID, "42", "/usage", 501)
	var groupText, groupChat string
	var groupReplyTo int64
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,text,chat_id,reply_to_message_id FROM replies WHERE inbox_id=$1`, iid).Scan(&rid, &groupText, &groupChat, &groupReplyTo)
	}))
	if !strings.Contains(groupText, "已使用") || groupChat != "-42" || groupReplyTo != 501 {
		t.Fatal("group did not share sender's archives or reply target", groupText, groupChat, groupReplyTo)
	}
	expectedReplyTo.Store(501)
	must(t, restarted.reply(ctx, store.Task{Tenant: identity.TenantID, ID: rid, Type: "reply"}))
	var groupMenuID int64
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT message_id FROM replies WHERE id=$1`, rid).Scan(&groupMenuID)
	}))
	// Another member cannot interact with the initiating user's buttons.
	iid = inboxChat(other.TenantID, "43", "-42", "/recent", groupMenuID)
	must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT text FROM replies WHERE inbox_id=$1`, iid).Scan(&groupText)
	}))
	if groupText != "这条消息仅限发起者操作。" {
		t.Fatal("foreign group callback accepted", groupText)
	}
	// The initiator can request content; it is a new reply to the clicked message.
	iid = inboxChat(identity.TenantID, "42", "-42", "/show "+job.ArchiveID, groupMenuID)
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,reply_to_message_id FROM submissions WHERE idem_key=$1`, "show:"+iid).Scan(&sid, &groupReplyTo)
	}))
	if groupReplyTo != groupMenuID {
		t.Fatal("lost callback reply target", groupReplyTo)
	}
	expectedReplyTo.Store(groupMenuID)
	must(t, restarted.deliver(ctx, store.Task{Tenant: identity.TenantID, ID: sid, Type: "deliver"}))
	// A regular group URL also retains its destination when reusing an archive.
	iid = groupMessage(identity.TenantID, "42", "https://x.com/i/status/201", 502)
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,reply_to_message_id FROM submissions WHERE idem_key=$1`, iid+":201").Scan(&sid, &groupReplyTo)
	}))
	if groupReplyTo != 502 {
		t.Fatal("lost capture reply target", groupReplyTo)
	}
	expectedReplyTo.Store(502)
	must(t, restarted.deliver(ctx, store.Task{Tenant: identity.TenantID, ID: sid, Type: "deliver"}))
	iid = groupMessage(other.TenantID, "43", "/recent", 503)
	must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id,text FROM replies WHERE inbox_id=$1`, iid).Scan(&rid, &groupText)
	}))
	if groupText != "请在私聊中使用 /recent 查看最近归档。" {
		t.Fatal("recent must be disabled in groups", groupText)
	}
	expectedReplyTo.Store(503)
	must(t, restarted.reply(ctx, store.Task{Tenant: other.TenantID, ID: rid, Type: "reply"}))

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
	var refreshed string
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT capture_id FROM submissions WHERE idem_key=$1`, "refresh:"+iid).Scan(&refreshed)
	}))
	s.Adapter.(*fakeAdapter).incomplete = true
	must(t, s.capture(ctx, store.Task{Tenant: identity.TenantID, ID: refreshed, Type: "capture"}))
	must(t, s.finalize(ctx, identity.TenantID, refreshed))
	partial, e := s.Job(ctx, identity.TenantID, refreshed)
	must(t, e)
	if partial.State != "partial" {
		t.Fatal("source failure was not marked partial", partial)
	}
	// Shared saving adds a reference and returns only a toast.
	shared := &Service{DB: db, Queue: queue, Adapter: &fakeAdapter{public: true, text: "shared content"}, Config: Defaults(), Senders: s.Senders}
	pub, err := shared.Submit(ctx, identity.TenantID, domain.CaptureInput{URL: "https://x.com/i/status/91000000077", Origin: domain.Origin{IdentityID: identity.ID, ChannelID: channel, ChatID: "-42", ReplyToMessageID: 504}})
	must(t, err)
	must(t, shared.capture(ctx, store.Task{Tenant: identity.TenantID, ID: pub.ID, Type: "capture"}))
	must(t, shared.finalize(ctx, identity.TenantID, pub.ID))
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1`, pub.ID).Scan(&sid)
	}))
	if sharedButtonSeen.Load() {
		t.Fatal("private archive exposed shared save button")
	}
	expectedReplyTo.Store(504)
	must(t, shared.deliver(ctx, store.Task{Tenant: identity.TenantID, ID: sid, Type: "deliver"}))
	if !sharedButtonSeen.Load() {
		t.Fatal("public archive missing shared save button")
	}
	mu.Lock()
	beforeSave := len(methods)
	mu.Unlock()
	for _, action := range []string{"/save " + pub.ArchiveID, "/save " + pub.ArchiveID, "/save " + job.ArchiveID, "/save invalid"} {
		inboxChat(other.TenantID, "43", "-42", action, groupMenuID)
	}
	mu.Lock()
	if strings.Join(toasts, "|") != "已保存|已经保存过了|这条内容无法保存，仅支持公开归档。|这条内容无法保存，仅支持公开归档。" {
		t.Error(toasts)
	}
	for _, method := range methods[beforeSave:] {
		if method != "answerCallbackQuery" {
			t.Error("shared save emitted a group message", method)
		}
	}
	mu.Unlock()
	var refs, captures, submissions, replies int
	must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM tenant_archives WHERE archive_id=$1), (SELECT count(*) FROM captures WHERE archive_id=$1), (SELECT count(*) FROM submissions WHERE capture_id=$2), (SELECT count(*) FROM replies r JOIN inbox i ON i.id=r.inbox_id WHERE i.payload#>>'{callback_query,data}' LIKE '/save%')`, pub.ArchiveID, pub.ID).Scan(&refs, &captures, &submissions, &replies)
	}))
	if refs != 1 || captures != 1 || submissions != 0 || replies != 0 {
		t.Fatal("shared save did more than add a reference", refs, captures, submissions, replies)
	}
	must(t, shared.DeleteArchive(ctx, other.TenantID, pub.ArchiveID))
	_, err = admin.Pool.Exec(ctx, `UPDATE tenants SET quota_bytes=1 WHERE id=$1`, other.TenantID)
	must(t, err)
	inboxChat(other.TenantID, "43", "-42", "/save "+pub.ArchiveID, groupMenuID)
	mu.Lock()
	if toasts[len(toasts)-1] != "存储额度不足，未保存。" {
		t.Error(toasts)
	}
	mu.Unlock()
	must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM tenant_archives WHERE archive_id=$1`, pub.ArchiveID).Scan(&refs)
	}))
	if refs != 0 {
		t.Fatal("quota failure retained a reference")
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

func TestArchiveMessageIncludesOnlyArchiveID(t *testing.T) {
	a := domain.Archive{ID: uuid.NewString(), RevisionID: uuid.NewString(), Text: "原帖正文", Assets: []domain.Asset{{State: "ready"}}}
	text := archiveMessage(a, "complete")
	if text != "已保存 · 1 张图片\n\n"+a.ID+"\n\n原帖正文" {
		t.Fatal(text)
	}
	a.Text = ""
	a.Warnings = []string{"视频不支持"}
	a.Assets = append(a.Assets, domain.Asset{State: "failed", Error: "下载超时"})
	text = archiveMessage(a, "partial")
	if !strings.Contains(text, a.ID) || strings.Contains(text, "/show") || strings.Contains(text, a.RevisionID) || !strings.Contains(text, "视频不支持") || !strings.Contains(text, "下载超时") {
		t.Fatal(text)
	}
}
