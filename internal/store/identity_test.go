package store

import (
	"context"
	"os"
	"testing"

	"github.com/google/uuid"
)

func TestTelegramIdentitySharesTenantAcrossBots(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, err := Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	db, err := Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	channel := func(kind string) string {
		id := uuid.NewString()
		if _, err := admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,$2,$3)`, id, kind, id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	first, second, other := channel("telegram"), channel("telegram"), channel("test")
	user, stranger := uuid.NewString(), uuid.NewString()
	a, err := db.Resolve(ctx, first, user, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	b, err := db.Resolve(ctx, second, user, 1<<30)
	if err != nil {
		t.Fatal(err)
	}
	if b.TenantID != a.TenantID || b.ID == a.ID {
		t.Fatalf("same Telegram user split across bots: %+v %+v", a, b)
	}
	again, err := db.Resolve(ctx, second, user, 1<<30)
	if err != nil || again != b {
		t.Fatal(again, err)
	}
	s, err := db.Resolve(ctx, second, stranger, 1<<30)
	if err != nil || s.TenantID == a.TenantID {
		t.Fatal(s, err)
	}
	// Non-Telegram channels keep channel-scoped users.
	o, err := db.Resolve(ctx, other, user, 1<<30)
	if err != nil || o.TenantID == a.TenantID {
		t.Fatal(o, err)
	}
}

func TestTelegramIdentityConcurrentBotsJoinOneTenant(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, err := Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	db, err := Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	channels := make([]string, 8)
	for i := range channels {
		channels[i] = uuid.NewString()
		if _, err := admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'telegram',$2)`, channels[i], channels[i]); err != nil {
			t.Fatal(err)
		}
	}
	user := uuid.NewString()
	tenants := make(chan string, len(channels))
	errs := make(chan error, len(channels))
	for _, c := range channels {
		go func() {
			v, err := db.Resolve(ctx, c, user, 1<<30)
			tenants <- v.TenantID
			errs <- err
		}()
	}
	seen := map[string]bool{}
	for range channels {
		if err := <-errs; err != nil {
			t.Fatal(err)
		}
		seen[<-tenants] = true
	}
	if len(seen) != 1 {
		t.Fatalf("concurrent bots created %d tenants", len(seen))
	}
}
