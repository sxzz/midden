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
	// Credentials pasted into the chat are dropped; only the deletion signal
	// survives, including on replay.
	for i := 0; i < 2; i++ {
		redacted, e := client.Event(ctx, secret)
		if e != nil || !redacted {
			t.Fatal(redacted, e)
		}
	}
	var raw string
	_ = admin.Pool.QueryRow(ctx, `SELECT payload::text FROM channel_work WHERE channel_id=$1 AND resource='2'`, channel).Scan(&raw)
	if strings.Contains(raw, secret.Credential) || !strings.Contains(raw, `"sensitive": true`) {
		t.Fatal("credential retained", raw)
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

func TestWebAccountLifecycle(t *testing.T) {
	s, admin, channel := channelFixture(t)
	d := &pb.DescribeResponse{AdapterId: "fixture", DisplayName: "Fixture", Providers: []*pb.Provider{
		{Id: "public", Authentication: "none", DefaultProvider: true},
		{Id: "session", Authentication: "session", DefaultProvider: true, CredentialHelp: "Fixture cookie", Capabilities: []*pb.Capability{{Name: "credential.prepare", Major: 1}, {Name: "connection.check", Major: 1}}},
	}}
	s.Adapters = map[string]app.AdapterBinding{"fixture": {Descriptor: d, Client: channelAccountAdapter{}, TLS: true}}
	ctx := context.Background()
	identity, err := s.DB.Resolve(ctx, channel, "101", s.Config.Quota)
	if err != nil {
		t.Fatal(err)
	}
	token := func(tenant string) string {
		t.Helper()
		value := uuid.NewString()
		if _, err := admin.Pool.Exec(ctx, `INSERT INTO tokens(tenant_id,digest) VALUES($1,$2)`, tenant, store.Hash(value)); err != nil {
			t.Fatal(err)
		}
		return value
	}
	owner := token(identity.TenantID)
	other, err := s.DB.Resolve(ctx, channel, "202", s.Config.Quota)
	if err != nil {
		t.Fatal(err)
	}
	stranger := token(other.TenantID)
	h := WebHandler(s, WebConfig{})
	call := func(method, path, body, bearer string, out any) int {
		t.Helper()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+bearer)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if v, ok := out.(*app.Accounts); ok {
			// Omitted fields must not keep values from an earlier response.
			*v = app.Accounts{}
		}
		if out != nil {
			_ = json.Unmarshal(w.Body.Bytes(), out)
		}
		return w.Code
	}
	var list app.Accounts
	if code := call("GET", "/v1/accounts", "", owner, &list); code != 200 || len(list.Platforms) != 1 || !list.Platforms[0].CanAdd || !list.Platforms[0].Public || list.Platforms[0].Help != "Fixture cookie" || len(list.Accounts) != 0 {
		t.Fatal(code, list)
	}
	for body, want := range map[string]int{
		`{"platform":"fixture","credential":"invalid"}`:                                     400,
		`{"platform":"fixture","credential":""}`:                                            400,
		`{"platform":"fixture","credential":"x","name":"` + strings.Repeat("a", 101) + `"}`: 400,
		`{"platform":"other","credential":"x"}`:                                             422,
		`{"platform":"fixture","credential":"x","extra":true}`:                              400,
	} {
		if code := call("POST", "/v1/accounts", body, owner, nil); code != want {
			t.Fatal(body, code)
		}
	}
	var added app.Account
	if code := call("POST", "/v1/accounts", `{"platform":"fixture","credential":"opaque credential with spaces","name":"Main"}`, owner, &added); code != 201 || added.Name != "Main" || added.Username != "fixture" || added.Platform != "fixture" || !added.Selected || added.State != "ready" {
		t.Fatal(code, added)
	}
	var raw string
	if err := admin.Pool.QueryRow(ctx, `SELECT encode(ciphertext,'escape') FROM account_credentials WHERE tenant_id=$1`, identity.TenantID).Scan(&raw); err != nil || strings.Contains(raw, "opaque credential") {
		t.Fatal("credential stored in plaintext", err)
	}
	// Adding the same upstream account again keeps one connection.
	var again app.Account
	if code := call("POST", "/v1/accounts", `{"platform":"fixture","credential":"opaque credential with spaces"}`, owner, &again); code != 201 || again.ID != added.ID {
		t.Fatal(code, again)
	}
	if code := call("GET", "/v1/accounts", "", stranger, &list); code != 200 || len(list.Accounts) != 0 {
		t.Fatal("foreign account listed", code, list)
	}
	if code := call("PUT", "/v1/accounts/selection", `{"platform":"fixture","account_id":"`+added.ID+`"}`, stranger, nil); code == 200 {
		t.Fatal("foreign account selected")
	}
	if code := call("DELETE", "/v1/accounts/"+added.ID, "", stranger, nil); code != 404 {
		t.Fatal("foreign account deleted", code)
	}
	if code := call("PUT", "/v1/accounts/selection", `{"platform":"fixture"}`, owner, &list); code != 200 || list.Platforms[0].Selected != "" || list.Accounts[0].Selected {
		t.Fatal("public source not selected", code, list)
	}
	if code := call("PUT", "/v1/accounts/selection", `{"platform":"fixture","account_id":"`+added.ID+`"}`, owner, &list); code != 200 || list.Platforms[0].Selected != added.ID || !list.Accounts[0].Selected {
		t.Fatal("account not selected", code, list)
	}
	if code := call("DELETE", "/v1/accounts/"+added.ID, "", owner, nil); code != 204 {
		t.Fatal(code)
	}
	if code := call("GET", "/v1/accounts", "", owner, &list); code != 200 || len(list.Accounts) != 0 || list.Platforms[0].Selected != "" {
		t.Fatal("revoked account listed", code, list)
	}
	if code := call("PUT", "/v1/accounts/selection", `{"platform":"fixture","account_id":"`+added.ID+`"}`, owner, nil); code != 422 {
		t.Fatal("revoked account selected", code)
	}
}

func TestChannelAccountDelete(t *testing.T) {
	s, _, channel := channelFixture(t)
	d := &pb.DescribeResponse{AdapterId: "fixture", DisplayName: "Fixture", Providers: []*pb.Provider{{Id: "session", Authentication: "session", DefaultProvider: true, Capabilities: []*pb.Capability{{Name: "credential.prepare", Major: 1}, {Name: "connection.check", Major: 1}}}}}
	s.Adapters = map[string]app.AdapterBinding{"fixture": {Descriptor: d, Client: channelAccountAdapter{}, TLS: true}}
	server := httptest.NewServer(ChannelHandler(s))
	defer server.Close()
	client := &tgchannel.Client{Base: server.URL, Channel: channel}
	ctx := context.Background()
	identity, err := s.DB.Resolve(ctx, channel, "101", s.Config.Quota)
	if err != nil {
		t.Fatal(err)
	}
	added, err := s.AddAccount(ctx, identity.TenantID, "fixture", "Main", "opaque")
	if err != nil {
		t.Fatal(err)
	}
	var update int64
	run := func(command, argument string) channelapi.Result {
		t.Helper()
		update++
		if _, err := client.Event(ctx, channelapi.Event{UpdateID: update, Actor: "101", Chat: "101", Private: true, Command: command, Argument: argument}); err != nil {
			t.Fatal(err)
		}
		work, err := client.Claim(ctx)
		if err != nil || work == nil {
			t.Fatal(work, err)
		}
		result, err := client.Action(ctx, *work, command)
		if err != nil {
			t.Fatal(err)
		}
		if err = client.Ack(ctx, *work, channelapi.Ack{Done: true}); err != nil {
			t.Fatal(err)
		}
		return result
	}
	if result := run("account", ""); result.Accounts == nil || len(result.Accounts.Accounts) != 1 || !result.Accounts.Platforms[0].CanAdd {
		t.Fatal(result)
	}
	if result := run("account_delete", added.ID); result.Code != "confirm_account_delete" {
		t.Fatal(result)
	}
	if list, _ := s.Accounts(ctx, identity.TenantID); len(list.Accounts) != 1 {
		t.Fatal("deleted without confirmation")
	}
	if result := run("account_delete", "confirm:"+added.ID); result.Code != "account_deleted" {
		t.Fatal(result)
	}
	if list, _ := s.Accounts(ctx, identity.TenantID); len(list.Accounts) != 0 {
		t.Fatal("account retained")
	}
}

func TestChannelActorProfileUpdates(t *testing.T) {
	s, admin, channel := channelFixture(t)
	ctx := context.Background()
	event := channelapi.Event{UpdateID: 1, Actor: "42", Chat: "42", Private: true, MessageID: 1, Command: "usage", ActorProfile: &channelapi.ActorProfile{FirstName: "小明", LastName: "张", Username: "ming"}}
	check := func(want channelapi.ActorProfile) {
		t.Helper()
		var got channelapi.ActorProfile
		err := admin.Pool.QueryRow(ctx, `SELECT first_name,last_name,username FROM identities WHERE channel_id=$1 AND external_id='42'`, channel).Scan(&got.FirstName, &got.LastName, &got.Username)
		if err != nil || got != want {
			t.Fatalf("profile = %+v, want %+v: %v", got, want, err)
		}
	}
	first := *event.ActorProfile
	if _, err := s.ChannelEvent(ctx, channel, event); err != nil {
		t.Fatal(err)
	}
	check(first)
	event.UpdateID++
	event.ActorProfile = &channelapi.ActorProfile{FirstName: "新昵称"}
	if _, err := s.ChannelEvent(ctx, channel, event); err != nil {
		t.Fatal(err)
	}
	renamed := *event.ActorProfile
	check(renamed)
	// A retried old event must not undo the rename.
	event.UpdateID = 1
	event.ActorProfile = &first
	if _, err := s.ChannelEvent(ctx, channel, event); err != nil {
		t.Fatal(err)
	}
	check(renamed)
	// Missing optional profile data must not erase the stored profile.
	event.UpdateID = 3
	event.ActorProfile = nil
	if _, err := s.ChannelEvent(ctx, channel, event); err != nil {
		t.Fatal(err)
	}
	check(renamed)
}
