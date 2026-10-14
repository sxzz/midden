package app

import (
	"context"
	"os"
	"testing"

	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestSupersededRawResponsesArePruned(t *testing.T) {
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
	queue, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	fake := &fakeAdapter{public: true, text: "unchanged", sourceResponses: []*pb.SourceResponse{{Body: []byte(`{"raw":true}`), ContentType: "application/json", SourceUrl: "https://example.test/raw", Visibility: pb.Visibility_VISIBILITY_PUBLIC}}}
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: Defaults()}
	s.Config.Rate = 1000
	capture := func() string {
		t.Helper()
		_, err := admin.Pool.Exec(ctx, `UPDATE collections SET observed_at=now()-interval '1 hour' WHERE external_id='99240011'`)
		must(t, err)
		job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://x.com/a/status/99240011", Automatic: true, RefreshAfterSeconds: 60})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		must(t, s.finalize(ctx, tenant, job.ID))
		return job.ID
	}
	versioned, superseded, recent, newest := capture(), capture(), capture(), capture()
	_, err = admin.Pool.Exec(ctx, `UPDATE captures SET finished_at=now()-interval '8 days' WHERE id=ANY($1::uuid[])`, []string{versioned, superseded})
	must(t, err)
	_, err = admin.Pool.Exec(ctx, `UPDATE captures SET finished_at=now()-interval '9 days' WHERE id=$1`, versioned)
	must(t, err)
	must(t, s.pruneSourceResponses(ctx))
	for id, want := range map[string]int{versioned: 1, superseded: 0, recent: 1, newest: 1} {
		var n int
		must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM source_responses WHERE capture_id=$1`, id).Scan(&n))
		if n != want {
			t.Fatalf("capture %s keeps %d raw responses, want %d", id, n, want)
		}
	}
}
