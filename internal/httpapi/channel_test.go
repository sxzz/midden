package httpapi

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/app"
	"monitor/internal/channelapi"
	"monitor/internal/credentials"
	"monitor/internal/store"
	"monitor/internal/telegram"
	"monitor/internal/tgchannel"
)

func channelFixture(t *testing.T) (*app.Service, *store.Store, string) {
	t.Helper()
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(admin.Close)
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(db.Close)
	channel := uuid.NewString()
	botID := strconv.FormatInt(time.Now().UnixNano(), 10)
	_, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'telegram',$2)`, channel, channel)
	if e != nil {
		t.Fatal(e)
	}
	saved := map[string]string{}
	rows, e := admin.Pool.Query(ctx, `SELECT key,value FROM config WHERE key IN ('telegram_bot_token','telegram_channel_id','web_app_url')`)
	if e != nil {
		t.Fatal(e)
	}
	for rows.Next() {
		var k, v string
		_ = rows.Scan(&k, &v)
		saved[k] = v
	}
	rows.Close()
	t.Cleanup(func() {
		for k, v := range saved {
			_, _ = admin.Pool.Exec(context.Background(), `UPDATE config SET value=$2 WHERE key=$1`, k, v)
		}
	})
	_, e = admin.Pool.Exec(ctx, `UPDATE config SET value=CASE key WHEN 'telegram_bot_token' THEN $2 WHEN 'telegram_channel_id' THEN $1 ELSE '' END WHERE key IN ('telegram_bot_token','telegram_channel_id','web_app_url')`, channel, botID+":fixture")
	if e != nil {
		t.Fatal(e)
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE channels SET external_id=$2 WHERE id=$1`, channel, botID)
	if e != nil {
		t.Fatal(e)
	}
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	if e != nil {
		t.Fatal(e)
	}
	return &app.Service{DB: db, Config: app.Defaults(), Vault: vault}, admin, channel
}

func TestChannelHTTPIsolationAndLease(t *testing.T) {
	s, admin, channel := channelFixture(t)
	ctx := context.Background()
	server := httptest.NewServer(ChannelHandler(s))
	defer server.Close()
	client := &tgchannel.Client{Base: server.URL, Channel: channel}
	if _, e := client.Config(ctx); e != nil {
		t.Fatal("unauthenticated internal access", e)
	}
	public := httptest.NewRecorder()
	WebHandler(s, WebConfig{}).ServeHTTP(public, httptest.NewRequest("GET", "/internal/v1/channels/"+channel+"/config", nil))
	if public.Code != 404 {
		t.Fatal(public.Code)
	}
	event := channelapi.Event{UpdateID: 1, Actor: "101", Chat: "101", Private: true, MessageID: 1, Command: "usage"}
	for i := 0; i < 2; i++ {
		if _, e := client.Event(ctx, event); e != nil {
			t.Fatal(e)
		}
	}
	var count int
	_ = admin.Pool.QueryRow(ctx, `SELECT count(*) FROM channel_work WHERE channel_id=$1`, channel).Scan(&count)
	if count != 1 {
		t.Fatal("duplicate event", count)
	}
	w, e := client.Claim(ctx)
	if e != nil || w == nil {
		t.Fatal(w, e)
	}
	v, e := client.Action(ctx, *w, "usage")
	if e != nil || v.Usage == nil {
		t.Fatal(v, e)
	}
	if e = client.Ack(ctx, *w, channelapi.Ack{Progress: 2, MessageID: 55}); e != nil {
		t.Fatal(e)
	}
	_, e = admin.Pool.Exec(ctx, `UPDATE channel_work SET lease_until=now()-interval '1 second' WHERE id=$1`, w.ID)
	if e != nil {
		t.Fatal(e)
	}
	next, e := client.Claim(ctx)
	if e != nil || next == nil || next.Lease == w.Lease || next.Progress != 2 || next.MessageID != 55 {
		t.Fatal(next, e)
	}
	if e = client.Ack(ctx, *w, channelapi.Ack{Done: true}); e == nil {
		t.Fatal("stale lease accepted")
	}
	if e = client.Ack(ctx, *next, channelapi.Ack{Done: true, Progress: 2, MessageID: 55}); e != nil {
		t.Fatal(e)
	}
	if e = client.Ack(ctx, *next, channelapi.Ack{Done: true, Progress: 2, MessageID: 55}); e != nil {
		t.Fatal("ack replay", e)
	}
	// No channel can use another channel's claim.
	if _, e = s.ChannelTenant(ctx, uuid.NewString(), next.ID, next.Lease); e == nil {
		t.Fatal("foreign channel accepted")
	}
	secret := event
	secret.UpdateID = 2
	secret.Command = "account_add"
	secret.Credential = "synthetic-cookie-secret"
	redacted, e := client.Event(ctx, secret)
	if e != nil || !redacted {
		t.Fatal(redacted, e)
	}
	var raw string
	_ = admin.Pool.QueryRow(ctx, `SELECT payload::text FROM channel_work WHERE channel_id=$1 AND resource='2'`, channel).Scan(&raw)
	if strings.Contains(raw, secret.Credential) || !strings.Contains(raw, "ciphertext") {
		t.Fatal("credential not sealed")
	}
	// A different actor cannot read the first actor's collection via a work claim.
	a, e := s.DB.Resolve(ctx, channel, "101", s.Config.Quota)
	if e != nil {
		t.Fatal(e)
	}
	b, e := s.DB.Resolve(ctx, channel, "102", s.Config.Quota)
	if e != nil {
		t.Fatal(e)
	}
	if a.TenantID == b.TenantID {
		t.Fatal("identity collision")
	}
}

type channelAdapter struct{ pb.AdapterClient }

func (channelAdapter) Describe(context.Context, *pb.DescribeRequest, ...grpc.CallOption) (*pb.DescribeResponse, error) {
	return &pb.DescribeResponse{ProtocolVersion: "1.0", AdapterId: "fixture", Providers: []*pb.Provider{{Id: "fixture", Authentication: "none", DefaultProvider: true, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}, Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}}}}, nil
}

func (channelAdapter) Resolve(_ context.Context, r *pb.ResolveRequest, _ ...grpc.CallOption) (*pb.ResolveResponse, error) {
	return &pb.ResolveResponse{Url: r.Url, ExternalId: strings.TrimPrefix(r.Url, "https://example.test/"), Platform: "fixture", Kind: "post"}, nil
}

func (channelAdapter) Fetch(_ context.Context, r *pb.FetchRequest, _ ...grpc.CallOption) (*pb.FetchResponse, error) {
	return &pb.FetchResponse{ExternalId: r.ExternalId, ProviderId: r.ProviderId, Visibility: pb.Visibility_VISIBILITY_PUBLIC, Text: "通过独立 channel 保存的合成内容", TextKind: "provider_summary", AdapterVersion: "fixture"}, nil
}

func TestChannelRunnerEndToEnd(t *testing.T) {
	s, admin, channel := channelFixture(t)
	s.Adapter = channelAdapter{}
	cfg, e := s.ChannelConfig(context.Background(), channel)
	if e != nil {
		t.Fatal(e)
	}
	workers := river.NewWorkers()
	river.AddWorker(workers, &app.Worker{S: s})
	queue, e := river.NewClient(riverpgxv5.New(s.DB.Pool), &river.Config{Workers: workers, Queues: map[string]river.QueueConfig{"capture": {MaxWorkers: 1}, "download": {MaxWorkers: 1}, "control": {MaxWorkers: 1}}, FetchPollInterval: 20 * time.Millisecond, FetchCooldown: 5 * time.Millisecond})
	if e != nil {
		t.Fatal(e)
	}
	s.Queue = queue
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if e = queue.Start(ctx); e != nil {
		t.Fatal(e)
	}
	defer func() {
		cancel()
		stop, end := context.WithTimeout(context.Background(), 5*time.Second)
		defer end()
		_ = queue.Stop(stop)
	}()
	core := httptest.NewServer(ChannelHandler(s))
	defer core.Close()
	var mu sync.Mutex
	var sent []string
	msgID := int64(10)
	bot := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method := r.URL.Path[strings.LastIndex(r.URL.Path, "/")+1:]
		_ = r.ParseForm()
		w.Header().Set("Content-Type", "application/json")
		switch method {
		case "getMe":
			fmt.Fprintf(w, `{"ok":true,"result":{"id":%s,"is_bot":true,"first_name":"Fixture","username":"fixturebot"}}`, cfg.BotID)
		case "getUpdates":
			offset, _ := strconv.ParseInt(r.FormValue("offset"), 10, 64)
			if offset < 2 {
				fmt.Fprint(w, `{"ok":true,"result":[{"update_id":1,"message":{"message_id":1,"from":{"id":101},"chat":{"id":101,"type":"private"},"text":"/save https://example.test/123456"}}]}`)
			} else {
				select {
				case <-r.Context().Done():
					return
				case <-time.After(30 * time.Millisecond):
				}
				fmt.Fprint(w, `{"ok":true,"result":[]}`)
			}
		case "sendMessage", "editMessageText":
			mu.Lock()
			sent = append(sent, r.FormValue("text"))
			msgID++
			id := msgID
			mu.Unlock()
			fmt.Fprintf(w, `{"ok":true,"result":{"message_id":%d,"chat":{"id":101,"type":"private"},"date":1,"text":"fixture"}}`, id)
		default:
			fmt.Fprint(w, `{"ok":true,"result":true}`)
		}
	}))
	defer bot.Close()
	defer cancel()
	runner := &tgchannel.Runner{API: &tgchannel.Client{Base: core.URL, Channel: channel}, Bot: &telegram.Client{Base: bot.URL, HTTP: bot.Client()}}
	done := make(chan error, 1)
	go func() { done <- runner.Run(ctx) }()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		found := false
		for _, v := range sent {
			if strings.Contains(v, "通过独立 channel") {
				found = true
			}
		}
		mu.Unlock()
		if found {
			break
		}
		select {
		case e := <-done:
			t.Fatal("runner exited", e)
		default:
		}
		time.Sleep(30 * time.Millisecond)
	}
	mu.Lock()
	text := strings.Join(sent, "\n")
	mu.Unlock()
	if !strings.Contains(text, "通过独立 channel") {
		t.Fatal("no collection delivered", text)
	}
	cancel()
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("runner did not stop")
	}
	var count int
	_ = admin.Pool.QueryRow(context.Background(), `SELECT count(*) FROM submissions WHERE channel_id=$1`, channel).Scan(&count)
	if count != 1 {
		t.Fatal("duplicate capture", count)
	}
}

// The prompt and credential may arrive in one getUpdates response, before any
// work is claimed. The second input must already be encrypted at that point.
func TestChannelCredentialIngress(t *testing.T) {
	s, admin, channel := channelFixture(t)
	d := &pb.DescribeResponse{AdapterId: "fixture", Providers: []*pb.Provider{{Id: "session", Authentication: "session", DefaultProvider: true, Capabilities: []*pb.Capability{{Name: "credential.prepare", Major: 1}, {Name: "connection.check", Major: 1}}}}}
	s.Adapters = map[string]app.AdapterBinding{"fixture": {Descriptor: d, Client: channelAdapter{}, TLS: true}}
	server := httptest.NewServer(ChannelHandler(s))
	defer server.Close()
	client := &tgchannel.Client{Base: server.URL, Channel: channel}
	ctx := context.Background()
	prompt := channelapi.Event{UpdateID: 1, Actor: "101", Chat: "101", Private: true, Command: "account_add", Adapter: "fixture"}
	if _, err := client.Event(ctx, prompt); err != nil {
		t.Fatal(err)
	}
	credential := channelapi.Event{UpdateID: 2, Actor: "101", Chat: "101", Private: true, Text: "synthetic opaque secret"}
	for i := 0; i < 2; i++ {
		secret, err := client.Event(ctx, credential)
		if err != nil || !secret {
			t.Fatal("credential redaction", secret, err)
		}
	}
	var raw string
	if err := admin.Pool.QueryRow(ctx, `SELECT payload::text FROM channel_work WHERE channel_id=$1 AND resource='2'`, channel).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, credential.Text) || !strings.Contains(raw, "ciphertext") {
		t.Fatal("credential leaked or lost")
	}
	work, err := client.Claim(ctx)
	if err != nil || work == nil {
		t.Fatal(work, err)
	}
	result, err := client.Action(ctx, *work, "account_add")
	if err != nil || result.Code != "account_prompt" {
		t.Fatal(result, err)
	}
	if err = client.Ack(ctx, *work, channelapi.Ack{Done: true}); err != nil {
		t.Fatal(err)
	}
	work, err = client.Claim(ctx)
	if err != nil || work == nil {
		t.Fatal(work, err)
	}
	// Terminal failure also scrubs the encrypted transient input, but duplicate
	// intake must still tell the channel to delete the original user message.
	if err = client.Ack(ctx, *work, channelapi.Ack{Permanent: true}); err != nil {
		t.Fatal(err)
	}
	secret, err := client.Event(ctx, credential)
	if err != nil || !secret {
		t.Fatal("terminal replay lost redaction", err)
	}
	if err = admin.Pool.QueryRow(ctx, `SELECT payload::text FROM channel_work WHERE id=$1`, work.ID).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(raw, "ciphertext") || strings.Contains(raw, credential.Text) {
		t.Fatal("terminal credential retained")
	}
}

type channelAccountAdapter struct{ channelAdapter }

func (channelAccountAdapter) PrepareCredential(_ context.Context, r *pb.PrepareCredentialRequest, _ ...grpc.CallOption) (*pb.PrepareCredentialResponse, error) {
	if string(r.Input) == "invalid" {
		return nil, status.Error(codes.InvalidArgument, "bad credential")
	}
	return &pb.PrepareCredentialResponse{Credential: &pb.Credential{Data: r.Input}}, nil
}
func (channelAccountAdapter) CheckConnection(_ context.Context, r *pb.CheckConnectionRequest, _ ...grpc.CallOption) (*pb.CheckConnectionResponse, error) {
	return &pb.CheckConnectionResponse{AccountId: store.Hash(string(r.Credential.Data)), Username: "fixture"}, nil
}

func TestChannelAccountLifecycle(t *testing.T) {
	s, admin, channel := channelFixture(t)
	d := &pb.DescribeResponse{AdapterId: "fixture", DisplayName: "Fixture", Providers: []*pb.Provider{{Id: "session", Authentication: "session", DefaultProvider: true, Capabilities: []*pb.Capability{{Name: "credential.prepare", Major: 1}, {Name: "connection.check", Major: 1}}}}}
	s.Adapters = map[string]app.AdapterBinding{"fixture": {Descriptor: d, Client: channelAccountAdapter{}, TLS: true}}
	server := httptest.NewServer(ChannelHandler(s))
	defer server.Close()
	client := &tgchannel.Client{Base: server.URL, Channel: channel}
	ctx := context.Background()
	var update int64
	run := func(event channelapi.Event) (channelapi.Result, channelapi.Event, bool) {
		t.Helper()
		update++
		event.UpdateID = update
		if event.Actor == "" {
			event.Actor = "101"
		}
		event.Chat = event.Actor
		event.Private = true
		secret, err := client.Event(ctx, event)
		if err != nil {
			t.Fatal(err)
		}
		work, err := client.Claim(ctx)
		if err != nil || work == nil {
			t.Fatal(work, err)
		}
		var stored channelapi.Event
		if err = json.Unmarshal(work.Payload, &stored); err != nil {
			t.Fatal(err)
		}
		result, err := client.Action(ctx, *work, stored.Command)
		if err != nil {
			t.Fatal(err)
		}
		if err = client.Ack(ctx, *work, channelapi.Ack{Done: true}); err != nil {
			t.Fatal(err)
		}
		return result, stored, secret
	}
	result, _, _ := run(channelapi.Event{Command: "account_add"})
	if result.Code != "account_prompt" || result.Platform.Name != "Fixture" {
		t.Fatal(result)
	}
	// Reconstructing the HTTP client does not lose the stored dialog.
	client = &tgchannel.Client{Base: server.URL, Channel: channel}
	result, stored, secret := run(channelapi.Event{Text: "opaque credential with spaces"})
	if result.Code != "account_added" || !secret || stored.Text != "" || len(stored.Ciphertext) == 0 {
		t.Fatal("import failed", result.Code)
	}
	connection := result.Account.ID
	var count int
	if err := admin.Pool.QueryRow(ctx, "SELECT count(*) FROM account_dialogs WHERE identity_id IN(SELECT id FROM identities WHERE channel_id=$1)", channel).Scan(&count); err != nil || count != 0 {
		t.Fatal("dialog retained", count, err)
	}
	result, _, _ = run(channelapi.Event{Command: "account_delete", Argument: connection})
	if result.Code != "confirm_account_delete" {
		t.Fatal(result)
	}
	var state string
	if err := admin.Pool.QueryRow(ctx, "SELECT state FROM connections WHERE id=$1", connection).Scan(&state); err != nil || state != "ready" {
		t.Fatal("deleted without confirmation", state, err)
	}
	result, _, _ = run(channelapi.Event{Command: "account_delete", Argument: "confirm:" + connection})
	if result.Code != "account_deleted" {
		t.Fatal(result)
	}
	run(channelapi.Event{Command: "account_add"})
	result, stored, secret = run(channelapi.Event{Actor: "202", Command: "usage", Text: "unrelated"})
	if secret || len(stored.Ciphertext) > 0 {
		t.Fatal("cross-identity dialog")
	}
	if _, err := admin.Pool.Exec(ctx, "UPDATE account_dialogs SET expires_at=now()-interval '1 minute' WHERE identity_id IN(SELECT id FROM identities WHERE channel_id=$1)", channel); err != nil {
		t.Fatal(err)
	}
	result, stored, secret = run(channelapi.Event{Text: "expired secret"})
	if result.Code != "dialog_expired" || !secret || stored.Text != "" || len(stored.Ciphertext) != 0 {
		t.Fatal("expired input", result.Code)
	}
	run(channelapi.Event{Command: "account_add"})
	run(channelapi.Event{Command: "account_cancel"})
	_, stored, secret = run(channelapi.Event{Command: "usage", Text: "ordinary"})
	if secret || len(stored.Ciphertext) != 0 {
		t.Fatal("cancel failed")
	}
	result, _, secret = run(channelapi.Event{Command: "account_add", Adapter: "fixture", Credential: "invalid"})
	if !secret || result.Code != "invalid_credentials" {
		t.Fatal("invalid credentials accepted", result.Code)
	}
}
