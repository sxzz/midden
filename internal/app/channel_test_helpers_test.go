package app

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"

	"monitor/internal/channelapi"
	"monitor/internal/store"
)

// Exercise the same leased event boundary as HTTP clients, with a test identity
// bound to an existing tenant. No Telegram transport or rendering is involved.
func channelTestEvent(t *testing.T, s *Service, tenant string, event channelapi.Event) (channelapi.Result, channelapi.Work, error) {
	t.Helper()
	ctx := context.Background()
	admin, err := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, err)
	defer admin.Close()
	channel := uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1::text::uuid,'fixture',$1)`, channel)
	must(t, err)
	_, err = admin.Pool.Exec(ctx, `INSERT INTO identities(tenant_id,channel_id,external_id) VALUES($1,$2,'42')`, tenant, channel)
	must(t, err)
	event.Actor, event.Chat, event.Private = "42", "42", true
	raw, err := json.Marshal(event)
	must(t, err)
	w := channelapi.Work{ID: uuid.NewString(), Lease: uuid.NewString(), Kind: "event", Payload: raw, CreatedAt: time.Now()}
	_, err = admin.Pool.Exec(ctx, `INSERT INTO channel_work(id,tenant_id,channel_id,kind,resource,payload,lease,lease_until) VALUES($1::text::uuid,$2,$3,'event',$1,$4,$5,now()+interval '90 seconds')`, w.ID, tenant, channel, raw, w.Lease)
	must(t, err)
	v, err := s.ChannelAction(ctx, channel, channelapi.Action{WorkID: w.ID, Lease: w.Lease, Name: event.Command})
	return v, w, err
}

func channelTestAction(t *testing.T, s *Service, tenant, op, argument string) (channelapi.Result, error) {
	t.Helper()
	v, _, err := channelTestEvent(t, s, tenant, channelapi.Event{Command: op, Argument: argument})
	return v, err
}

func selectTestAccount(t *testing.T, s *Service, tenant, argument string) {
	t.Helper()
	_, err := channelTestAction(t, s, tenant, "account", argument)
	must(t, err)
}
