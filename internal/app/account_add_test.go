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
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	pb "monitor/api/adapter/v1"
	"monitor/internal/credentials"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

func accountFixture(t *testing.T) (*Service, telegram.Update, string) {
	t.Helper()
	v, err := credentials.New(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	must(t, err)
	token := base64.StdEncoding.EncodeToString([]byte("other=ignored;auth_token=" + strings.Repeat("a", 40) + ";ct0=" + strings.Repeat("b", 64) + ";"))
	m := &telegram.Message{ID: 7, Text: "/account_add " + token + " 测试账号"}
	m.From.ID, m.Chat.ID, m.Chat.Type = 42, 42, "private"
	return &Service{Vault: v, AdapterTLS: true}, telegram.Update{ID: 123, Message: m}, token
}

func TestPrepareAccountInput(t *testing.T) {
	s, u, token := accountFixture(t)
	for _, group := range []bool{false, true} {
		if group {
			u.Message.Chat.ID = -42
			u.Message.Chat.Type = "group"
			u.Message.Text = "/account_add@fixture " + token
		}
		raw, del, err := s.prepareUpdate(u, "tenant", "channel", "fixture")
		must(t, err)
		if strings.Contains(string(raw), token) || strings.Contains(string(raw), strings.Repeat("a", 40)) {
			t.Fatal("credential persisted as plaintext")
		}
		if del == group {
			t.Fatal("wrong deletion policy")
		}
		var out persistedUpdate
		must(t, json.Unmarshal(raw, &out))
		if out.Message.Text != "/account_add" {
			t.Fatal("command not redacted")
		}
		if group {
			if len(out.AccountImport.Ciphertext) != 0 {
				t.Fatal("group credential retained")
			}
		} else {
			c, err := s.Vault.Open("tenant", out.AccountImport.ID, out.AccountImport.Ciphertext)
			must(t, err)
			if c.AuthToken != strings.Repeat("a", 40) {
				t.Fatal("session lost")
			}
			if _, err = s.Vault.Open("other", out.AccountImport.ID, out.AccountImport.Ciphertext); err == nil {
				t.Fatal("cross-tenant decrypt")
			}
			again, _, err := s.prepareUpdate(u, "tenant", "channel", "fixture")
			must(t, err)
			var replay persistedUpdate
			must(t, json.Unmarshal(again, &replay))
			if replay.AccountImport.ID != out.AccountImport.ID {
				t.Fatal("unstable connection identity")
			}
		}
	}
	s, u, token = accountFixture(t)
	s.Vault = nil
	raw, _, err := s.prepareUpdate(u, "tenant", "channel", "")
	must(t, err)
	if strings.Contains(string(raw), token) {
		t.Fatal("unconfigured service leaked credentials")
	}
	for _, cmd := range TelegramCommands(true) {
		if cmd.Command == "account_add" {
			t.Fatal("account import exposed in group menu")
		}
	}
	if !validCallback("/account_add") || validCallback("/account_add secret") {
		t.Fatal("account callback must only open instructions")
	}
}

type rejectedAccountAdapter struct{ *fakeAdapter }

func (*rejectedAccountAdapter) CheckConnection(context.Context, *pb.CheckConnectionRequest, ...grpc.CallOption) (*pb.CheckConnectionResponse, error) {
	return nil, status.Error(codes.Unauthenticated, "upstream confidential error")
}

func TestTelegramAccountImportIntegration(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker required")
	}
	ctx := context.Background()
	admin, err := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, err)
	defer admin.Close()
	db, err := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, err)
	defer db.Close()
	s, u, token := accountFixture(t)
	s.DB = db
	s.Config = Defaults()
	s.Sender = &fakeSender{}
	s.Adapter = &fakeAdapter{}
	s.Providers = []*pb.Provider{{Id: "x-session", Authentication: "session", Capabilities: []*pb.Capability{{Name: "connection.check", Major: 1}}}}
	s.Queue, err = river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	channel := uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, err)
	identity, err := db.Resolve(ctx, channel, "42", 1<<30)
	must(t, err)
	other, err := db.Resolve(ctx, channel, "43", 1<<30)
	must(t, err)
	raw, _, err := s.prepareUpdate(u, identity.TenantID, channel, "")
	must(t, err)
	var envelope persistedUpdate
	must(t, json.Unmarshal(raw, &envelope))
	id := uuid.NewString()
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `INSERT INTO inbox(id,tenant_id,channel_id,update_id,payload) VALUES($1,$2,$3,$4,$5)`, id, identity.TenantID, channel, u.ID, raw)
		return e
	}))
	task := store.Task{Tenant: identity.TenantID, ID: id, Type: "inbox"}
	must(t, s.processInbox(ctx, task))
	must(t, s.processInbox(ctx, task))
	var count, revision int
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*),max(revision) FROM connections WHERE tenant_id=$1`, identity.TenantID).Scan(&count, &revision))
	if count != 1 || revision != 1 {
		t.Fatal("duplicate connection or revision")
	}
	var payload, text string
	must(t, admin.Pool.QueryRow(ctx, `SELECT i.payload::text,r.text FROM inbox i JOIN replies r ON r.inbox_id=i.id WHERE i.id=$1`, id).Scan(&payload, &text))
	if strings.Contains(payload, "ciphertext") || strings.Contains(payload, token) || !strings.Contains(text, "账号已添加") {
		t.Fatal("incorrect completion or credential cleanup")
	}
	must(t, db.Tx(ctx, other.TenantID, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT count(*) FROM connections WHERE id=$1`, envelope.AccountImport.ID).Scan(&count)
	}))
	if count != 0 {
		t.Fatal("connection visible across tenants")
	}
	// Simulate process loss after importing but before inbox/reply commit.
	must(t, s.RevokeConnection(ctx, identity.TenantID, envelope.AccountImport.ID))
	must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE inbox SET state='pending',payload=$2 WHERE id=$1`, id, raw)
		return e
	}))
	must(t, s.processInbox(ctx, task))
	var state string
	must(t, admin.Pool.QueryRow(ctx, `SELECT state,revision FROM connections WHERE id=$1`, envelope.AccountImport.ID).Scan(&state, &revision))
	if state != "revoked" || revision != 2 {
		t.Fatal("replay resurrected credentials")
	}
	for _, tc := range []struct{ kind, want string }{{"group", "请在私聊"}, {"malformed", "Cookie 格式无效"}, {"rejected", "X 登录会话已失效"}} {
		t.Run(tc.kind, func(t *testing.T) {
			_, update, encoded := accountFixture(t)
			update.ID = 456
			if tc.kind == "group" {
				update.Message.Chat.ID = -42
				update.Message.Chat.Type = "group"
				update.Message.Text = "/account_add@fixture " + encoded
			}
			if tc.kind == "malformed" {
				update.Message.Text = "/account_add invalid!"
			}
			if tc.kind == "rejected" {
				s.Adapter = &rejectedAccountAdapter{&fakeAdapter{}}
			}
			raw, _, err := s.prepareUpdate(update, identity.TenantID, channel, "fixture")
			must(t, err)
			iid := uuid.NewString()
			updateID := int64(500 + len(tc.kind))
			must(t, db.Tx(ctx, identity.TenantID, func(tx pgx.Tx) error {
				_, e := tx.Exec(ctx, `INSERT INTO inbox(id,tenant_id,channel_id,update_id,payload) VALUES($1,$2,$3,$4,$5)`, iid, identity.TenantID, channel, updateID, raw)
				return e
			}))
			must(t, s.processInbox(ctx, store.Task{Tenant: identity.TenantID, ID: iid, Type: "inbox"}))
			var payload, text string
			must(t, admin.Pool.QueryRow(ctx, `SELECT i.payload::text,r.text FROM inbox i JOIN replies r ON r.inbox_id=i.id WHERE i.id=$1`, iid).Scan(&payload, &text))
			if strings.Contains(payload, "ciphertext") || strings.Contains(payload, encoded) || strings.Contains(text, "confidential") || !strings.Contains(text, tc.want) {
				t.Fatal("credential retention, error leak, or wrong result")
			}
		})
	}
}
