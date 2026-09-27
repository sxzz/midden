package app

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

type inputSender struct {
	fakeSender
	texts []string
}

func (s *inputSender) Send(ctx context.Context, chat, text string, mid int64) (int64, error) {
	s.texts = append(s.texts, text)
	return s.fakeSender.Send(ctx, chat, text, mid)
}

func TestFailureRetainsEachSubmissionInput(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, err := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, err)
	defer admin.Close()
	db, err := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, err)
	defer db.Close()
	q, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	channel := uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id)VALUES($1,'fixture',$2)`, channel, channel)
	must(t, err)
	sender := &inputSender{}
	s := &Service{DB: db, Queue: q, Adapter: &fakeAdapter{public: true}, Config: Defaults(), Sender: sender}
	inputs := []string{"https://mobile.twitter.com/fixture/status/92001/photo/1?s=first", "https://x.com/i/web/status/92001?s=second"}
	identities := []domain.Identity{}
	jobs := []domain.Job{}
	for i, input := range inputs {
		identity, e := db.Resolve(ctx, channel, []string{"41", "42"}[i], 1<<30)
		must(t, e)
		identities = append(identities, identity)
		job, e := s.Submit(ctx, identity.TenantID, domain.CaptureInput{URL: input, Origin: domain.Origin{IdentityID: identity.ID, ChannelID: channel, ChatID: identity.ExternalID}})
		must(t, e)
		jobs = append(jobs, job)
	}
	if jobs[0].ID != jobs[1].ID {
		t.Fatal("expected coalesced capture")
	}
	must(t, s.fail(ctx, store.Task{Tenant: identities[0].TenantID, ID: jobs[0].ID, Type: "capture"}, "provider request failed"))
	restarted := *s
	for i, identity := range identities {
		var sid string
		must(t, admin.Pool.QueryRow(ctx, `SELECT id FROM submissions WHERE tenant_id=$1 AND capture_id=$2`, identity.TenantID, jobs[i].ID).Scan(&sid))
		must(t, restarted.deliver(ctx, store.Task{Tenant: identity.TenantID, ID: sid, Type: "deliver"}))
		if !strings.Contains(sender.texts[i], inputs[i]) || strings.Contains(sender.texts[i], inputs[1-i]) {
			t.Fatal("wrong failure input", sender.texts[i])
		}
	}
	s.Config.Rate = 0
	raw := "https://twitter.com/fixture/status/92002/photo/2?original=1"
	r := &commandRequest{Task: store.Task{Tenant: identities[0].TenantID, ID: uuid.NewString()}}
	must(t, s.submitMessageURLs(ctx, r, &telegram.Message{Text: raw}))
	if !strings.Contains(r.Text, raw) {
		t.Fatal("immediate error lost input", r.Text)
	}
	// Large immediate failures are split and recorded, rather than rejected by Telegram.
	inbox := uuid.NewString()
	rid := uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO inbox(id,tenant_id,channel_id,update_id,payload)VALUES($1,$2,$3,1,'{}')`, inbox, identities[0].TenantID, channel)
	must(t, err)
	text := strings.Repeat("原始输入😀", 1000) + raw
	_, err = admin.Pool.Exec(ctx, `INSERT INTO replies(id,tenant_id,inbox_id,chat_id,text)VALUES($1,$2,$3,'41',$4)`, rid, identities[0].TenantID, inbox, text)
	must(t, err)
	before := len(sender.texts)
	must(t, s.reply(ctx, store.Task{Tenant: identities[0].TenantID, ID: rid, Type: "reply"}))
	if strings.Join(sender.texts[before:], "") != text || len(sender.texts[before:]) < 2 {
		t.Fatal("long input truncated")
	}
	before = len(sender.texts)
	must(t, s.reply(ctx, store.Task{Tenant: identities[0].TenantID, ID: rid, Type: "reply"}))
	if len(sender.texts) != before {
		t.Fatal("completed reply repeated")
	}
}
