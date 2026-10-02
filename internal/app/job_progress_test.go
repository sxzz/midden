package app

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestJobProgressFollowsMembers(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	must(t, e)
	defer admin.Close()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	must(t, e)
	defer db.Close()
	queue, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	prefix := strings.ReplaceAll(uuid.NewString(), "-", "")
	fake := &datedAdapter{collectionAdapter: &collectionAdapter{&fakeAdapter{}}, members: map[string]string{prefix + "-a": "", prefix + "-b": ""}}
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: queue, Adapter: fake, Config: cfg}
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	complete := func(id string) {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: id}))
		must(t, s.finalize(ctx, tenant, id))
	}
	progress := func(id string) domain.Job {
		j, e := s.JobProgress(ctx, tenant, id)
		must(t, e)
		return j
	}

	job, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/" + prefix})
	must(t, e)
	if m := progress(job.ID).Members; m == nil || m.Done {
		t.Fatalf("queued collection progress %+v", m)
	}
	complete(job.ID)
	// The collection's own capture is finished, but its members are not listed yet.
	j := progress(job.ID)
	if j.State != "complete" || j.Members == nil || j.Members.Done {
		t.Fatalf("finished listing progress %+v %+v", j, j.Members)
	}
	var sid string
	must(t, db.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT id FROM submissions WHERE capture_id=$1`, job.ID).Scan(&sid)
	}))
	must(t, s.related(ctx, store.Task{Tenant: tenant, ID: sid, Type: "related"}))
	if m := progress(job.ID).Members; m.Done || m.Pending != 2 || m.Total != 2 {
		t.Fatalf("members queued progress %+v", m)
	}
	rows, e := admin.Pool.Query(ctx, `SELECT capture_id FROM submissions WHERE parent_submission=$1 ORDER BY created_at`, sid)
	must(t, e)
	members, e := pgx.CollectRows(rows, pgx.RowTo[string])
	must(t, e)
	complete(members[0])
	if m := progress(job.ID).Members; m.Done || m.Complete != 1 || m.Pending != 1 {
		t.Fatalf("one member finished progress %+v", m)
	}
	complete(members[1])
	if m := progress(job.ID).Members; !m.Done || m.Complete != 2 || m.Pending != 0 {
		t.Fatalf("members finished progress %+v", m)
	}
	// Members' own captures are not collections and report no member progress.
	if m := progress(members[0]).Members; m != nil {
		t.Fatalf("member reported members %+v", m)
	}
}
