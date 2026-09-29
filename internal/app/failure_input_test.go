package app

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/channelapi"
	"monitor/internal/domain"
	"monitor/internal/store"
)

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
	s := &Service{DB: db, Queue: q, Adapter: &fakeAdapter{public: true}, Config: Defaults()}
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
	for i := range identities {
		w, err := restarted.ClaimChannel(ctx, channel)
		must(t, err)
		if w == nil {
			t.Fatal("missing delivery")
		}
		data, err := restarted.ChannelDelivery(ctx, channel, w.ID, w.Lease)
		must(t, err)
		if data.Input != inputs[i] {
			t.Fatal("wrong failure input", data.Input)
		}
		if _, err := restarted.ChannelTenant(ctx, channel, w.ID, w.Lease); err != nil {
			t.Fatal(err)
		}
		must(t, restarted.AckChannel(ctx, channel, w.ID, channelapi.Ack{Lease: w.Lease, Done: true}))
	}
}
