package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

func TestAccountDialog(t *testing.T) {
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
	channel := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, "INSERT INTO channels(id,kind,external_id) VALUES($1,'dialog-test',$2)", channel, channel)
	must(t, e)
	identity, e := db.Resolve(ctx, channel, "42", 1<<30)
	must(t, e)
	other, e := db.Resolve(ctx, channel, "43", 1<<30)
	must(t, e)
	vault, e := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, e)
	d := &pb.DescribeResponse{AdapterId: "x", DisplayName: "X", Providers: []*pb.Provider{{Id: "session", DefaultProvider: true, Authentication: "session", CredentialHelp: "发送 Base64 Cookie。", Capabilities: []*pb.Capability{{Name: "connection.check", Major: 1}, {Name: "credential.prepare", Major: 1}}}}}
	s := &Service{DB: db, Vault: vault, Adapters: map[string]AdapterBinding{"x": {Descriptor: d, Client: &fakeAdapter{}, TLS: true}}}
	request := func() *commandRequest {
		return &commandRequest{Task: store.Task{Tenant: identity.TenantID, ID: uuid.NewString()}, Origin: domain.Origin{IdentityID: identity.ID, ChannelID: channel, ChatID: "42"}}
	}
	r := request()
	must(t, s.commandAccountAdd(ctx, r))
	if !strings.Contains(r.Text, "添加 X 账号") || !strings.Contains(r.Text, "直接发送") || r.Buttons[0][0].Data != "/account_cancel" {
		t.Fatal("not interactive", r.Text)
	}
	msg := &telegram.Message{ID: 12, Text: "opaque credential with spaces"}
	msg.From.ID = 42
	msg.Chat.ID = 42
	msg.Chat.Type = "private"
	update := telegram.Update{ID: 123, Message: msg}
	// A fresh service uses the persisted dialog.
	restarted := *s
	raw, del, e := restarted.prepareInteractiveUpdate(ctx, update, identity.TenantID, channel, "")
	must(t, e)
	if !del || strings.Contains(string(raw), msg.Text) {
		t.Fatal("credential input leaked")
	}
	var envelope persistedUpdate
	envelope = persistedUpdate{}
	must(t, json.Unmarshal(raw, &envelope))
	if envelope.AccountImport == nil || envelope.AccountImport.AdapterID != "x" || envelope.AccountImport.FlowID != r.Task.ID {
		t.Fatal("lost prompt")
	}
	credential, e := vault.Open(identity.TenantID, envelope.AccountImport.ID, envelope.AccountImport.Ciphertext)
	must(t, e)
	if string(credential.Data) != msg.Text {
		t.Fatal("credential changed")
	}
	incoming := request()
	incoming.AccountImport = envelope.AccountImport
	must(t, restarted.commandAccountAdd(ctx, incoming))
	if !strings.Contains(incoming.Text, "账号已添加") {
		t.Fatal(incoming.Text)
	}
	var n int
	must(t, admin.Pool.QueryRow(ctx, "SELECT count(*) FROM account_dialogs WHERE tenant_id=$1", identity.TenantID).Scan(&n))
	if n != 0 {
		t.Fatal("dialog still active")
	}
	// No dialog from another identity/tenant can consume messages.
	copyMsg := *msg
	copyMsg.From.ID = 43
	copyMsg.Chat.ID = 43
	raw, del, e = s.prepareInteractiveUpdate(ctx, telegram.Update{ID: 124, Message: &copyMsg}, other.TenantID, channel, "")
	must(t, e)
	if del || strings.Contains(string(raw), "account_import") {
		t.Fatal("dialog crossed identity boundary")
	}
	r = request()
	must(t, s.commandAccountAdd(ctx, r))
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, "UPDATE account_dialogs SET expires_at=now()-interval '1 minute'")
		return e
	}))
	raw, del, e = s.prepareInteractiveUpdate(ctx, update, identity.TenantID, channel, "")
	must(t, e)
	envelope = persistedUpdate{}
	must(t, json.Unmarshal(raw, &envelope))
	if !del || strings.Contains(string(raw), "credential with spaces") || !strings.Contains(envelope.AccountImport.Error, "超时") || len(envelope.AccountImport.Ciphertext) != 0 {
		t.Fatal("expired credential accepted")
	}
	r = request()
	must(t, s.commandAccountAdd(ctx, r))
	must(t, s.commandAccountCancel(ctx, r))
	raw, del, e = s.prepareInteractiveUpdate(ctx, update, identity.TenantID, channel, "")
	must(t, e)
	if del || strings.Contains(string(raw), "account_import") {
		t.Fatal("cancel did not clear prompt")
	}
	if adapterDisplayName(&pb.DescribeResponse{AdapterId: "fixture", DisplayName: "Fixture Platform"}) != "Fixture Platform" || !validCallback("/account_cancel") {
		t.Fatal("presentation or cancellation")
	}
}

func TestAccountDialogPlatformPicker(t *testing.T) {
	providers := []*pb.Provider{{Authentication: "session", DefaultProvider: true, Capabilities: []*pb.Capability{{Name: "credential.prepare", Major: 1}, {Name: "connection.check", Major: 1}}}}
	s := &Service{Adapters: map[string]AdapterBinding{
		"x":      {Descriptor: &pb.DescribeResponse{AdapterId: "x", DisplayName: "X", Providers: providers}},
		"notes":  {Descriptor: &pb.DescribeResponse{AdapterId: "notes", Providers: providers}},
		"public": {Descriptor: &pb.DescribeResponse{AdapterId: "public"}},
	}}
	m := &telegram.Message{Text: "/account_add"}
	m.Chat.Type = "private"
	raw, _, e := s.prepareUpdate(telegram.Update{Message: m}, "tenant", "channel", "")
	must(t, e)
	var update persistedUpdate
	must(t, json.Unmarshal(raw, &update))
	r := &commandRequest{AccountImport: update.AccountImport}
	must(t, s.commandAccountAdd(context.Background(), r))
	if len(r.Buttons) != 2 || r.Buttons[1][0].Text != "X" {
		t.Fatal("missing platform picker", r.Text, r.Buttons)
	}
}
