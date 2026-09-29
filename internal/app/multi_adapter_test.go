package app

import (
	"context"
	"encoding/base64"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

func TestMultiAdapterAccounts(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker required")
	}
	ctx := context.Background()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	v, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	s := &Service{DB: db, Queue: q, Vault: v, Config: Defaults(), Adapters: map[string]AdapterBinding{}}
	var tenant, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	accounts := map[string]string{}
	for _, id := range []string{"notes", "photos"} {
		fake := &notesAdapter{fakeAdapter: &fakeAdapter{public: true, text: id}}
		d := &pb.DescribeResponse{ProtocolVersion: "1.0", AdapterId: id, Hosts: []string{id + ".test"}, Providers: []*pb.Provider{
			{Id: "public", Authentication: "none", DefaultProvider: true, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC}, Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}}},
			{Id: "session", Authentication: "session", DefaultProvider: true, Visibilities: []pb.Visibility{pb.Visibility_VISIBILITY_PUBLIC, pb.Visibility_VISIBILITY_PRIVATE}, Capabilities: []*pb.Capability{{Name: "capture.fetch", Major: 1}, {Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}}},
		}}
		s.Adapters[id] = AdapterBinding{Client: fake, Descriptor: d, TLS: true}
		scoped, e := s.forAdapter(id)
		must(t, e)
		accounts[id], e = scoped.ImportConnection(ctx, tenant, "", id, &pb.Credential{Data: []byte(id + "-credential")})
		must(t, e)
		selected, err := scoped.DefaultConnection(ctx, tenant)
		must(t, err)
		if selected != accounts[id] {
			t.Fatal("import did not select account for adapter", id)
		}
	}
	for _, id := range []string{"notes", "photos"} {
		raw := "https://" + id + ".test/entry/item-A"
		connection, e := s.connectionForURL(ctx, tenant, raw)
		must(t, e)
		if connection != accounts[id] {
			t.Fatal("account selection overwritten", id)
		}
		j, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: raw, ConnectionID: connection})
		must(t, e)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
		must(t, s.finalize(ctx, tenant, j.ID))
		fake := s.Adapters[id].Client.(*notesAdapter)
		if string(fake.last.Credential.Data) != id+"-credential" {
			t.Fatal("credential sent to wrong adapter")
		}
	}
	menu := &commandRequest{Task: store.Task{Tenant: tenant}}
	must(t, s.commandAccount(ctx, menu))
	checked := 0
	for _, row := range menu.Buttons {
		for _, b := range row {
			if strings.Contains(b.Text, "✓") {
				checked++
			}
			if !validCallback(b.Data) {
				t.Fatal("invalid callback", b.Data)
			}
		}
	}
	if checked != 2 {
		t.Fatal("both adapters should be selected", checked)
	}
	must(t, s.commandAccount(ctx, &commandRequest{Task: store.Task{Tenant: tenant}, Argument: "public:notes"}))
	c, e := s.connectionForURL(ctx, tenant, "https://notes.test/entry/a")
	must(t, e)
	if c != "" {
		t.Fatal("public not selected")
	}
	c, e = s.connectionForURL(ctx, tenant, "https://photos.test/entry/a")
	must(t, e)
	if c != accounts["photos"] {
		t.Fatal("other adapter selection changed")
	}
	if _, e = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/entry/a", ConnectionID: accounts["photos"]}); e == nil {
		t.Fatal("cross-adapter account accepted")
	}
	if _, e = s.Submit(ctx, other, domain.CaptureInput{URL: "https://photos.test/entry/a", ConnectionID: accounts["photos"]}); e == nil {
		t.Fatal("cross-tenant account accepted")
	}
	must(t, s.RevokeConnection(ctx, tenant, accounts["notes"]))
	c, e = s.connectionForURL(ctx, tenant, "https://photos.test/entry/a")
	must(t, e)
	if c != accounts["photos"] {
		t.Fatal("deletion affected other adapter")
	}
	// Adapter identity survives durable Telegram input, without plaintext credentials.
	msg := &telegram.Message{ID: 1, Text: "/account_add @photos fixture-secret New"}
	msg.Chat.Type = "private"
	raw, _, e := s.prepareUpdate(telegram.Update{ID: 1, Message: msg}, tenant, uuid.NewString(), "")
	must(t, e)
	if strings.Contains(string(raw), "fixture-secret") || !strings.Contains(string(raw), "\"adapter_id\":\"photos\"") {
		t.Fatal("unsafe account envelope")
	}
}
