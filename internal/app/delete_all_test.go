package app

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestDeleteAllIsolationAndRetention(t *testing.T) {
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
	channel := uuid.NewString()
	_, err = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)`, channel, channel)
	must(t, err)
	a, err := db.Resolve(ctx, channel, "42", 1<<30)
	must(t, err)
	b, err := db.Resolve(ctx, channel, "43", 1<<30)
	must(t, err)
	q, err := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, err)
	s := &Service{DB: db, Queue: q, Adapter: &fakeAdapter{public: true, text: "retained content"}, Config: Defaults()}
	save := func(url string) domain.Job {
		j, err := s.Submit(ctx, a.TenantID, domain.CaptureInput{URL: url})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: a.TenantID, ID: j.ID, Type: "capture"}))
		must(t, s.finalize(ctx, a.TenantID, j.ID))
		return j
	}
	shared := save("https://x.com/i/status/98000000001")
	alone := save("https://x.com/i/status/98000000002")
	_, err = s.SavePublicCollection(ctx, b.TenantID, shared.CollectionID)
	must(t, err)
	usageBefore, err := s.Usage(ctx, b.TenantID)
	must(t, err)
	// A delivery still waiting on a deleted record has nothing left to send.
	var delivery string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO channel_work(tenant_id,channel_id,kind,resource) SELECT $1,$2,'delivery',id::text FROM submissions WHERE capture_id=$3 AND tenant_id=$1 RETURNING id`, a.TenantID, channel, alone.ID).Scan(&delivery))
	size, err := s.LibrarySize(ctx, a.TenantID)
	must(t, err)
	if size != (LibrarySize{Collections: 2, Records: 2}) {
		t.Fatal("wrong library size", size)
	}
	var cutoff time.Time
	must(t, admin.Pool.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&cutoff))
	later := save("https://x.com/i/status/98000000003")
	n, err := s.DeleteAll(ctx, a.TenantID, cutoff)
	must(t, err)
	if n != (LibrarySize{Collections: 2, Records: 2}) {
		t.Fatal("wrong deletion count", n)
	}
	n, err = s.DeleteAll(ctx, a.TenantID, cutoff)
	must(t, err)
	if n != (LibrarySize{}) {
		t.Fatal("retry removed newer saves", n)
	}
	records, err := s.CaptureRecords(ctx, a.TenantID, "")
	must(t, err)
	if len(records.Items) != 1 || records.Items[0].JobID != later.ID {
		t.Fatal("capture records not cleared up to the cutoff", records.Items)
	}
	var settled string
	must(t, admin.Pool.QueryRow(ctx, `SELECT state FROM channel_work WHERE id=$1`, delivery).Scan(&settled))
	if settled != "done" {
		t.Fatal("delivery of a deleted record left pending", settled)
	}
	if other, err := s.CaptureRecords(ctx, b.TenantID, ""); err != nil || len(other.Items) != 0 {
		t.Fatal("other tenant records changed", other.Items, err)
	}
	page, err := s.Recent(ctx, a.TenantID, "")
	must(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != later.CollectionID {
		t.Fatal("later save lost", page)
	}
	usageAfter, err := s.Usage(ctx, b.TenantID)
	must(t, err)
	if usageBefore.Used == 0 || usageAfter.Used != usageBefore.Used {
		t.Fatal("other tenant usage changed", usageBefore, usageAfter)
	}
	page, err = s.Recent(ctx, b.TenantID, "")
	must(t, err)
	if len(page.Items) != 1 || page.Items[0].ID != shared.CollectionID {
		t.Fatal("other tenant data lost", page)
	}
	var aloneMarked, sharedMarked bool
	must(t, admin.Pool.QueryRow(ctx, `SELECT (SELECT unreferenced_at IS NOT NULL FROM collections WHERE id=$1),(SELECT unreferenced_at IS NOT NULL FROM collections WHERE id=$2)`, alone.CollectionID, shared.CollectionID).Scan(&aloneMarked, &sharedMarked))
	if !aloneMarked || sharedMarked {
		t.Fatal("incorrect retention markers", aloneMarked, sharedMarked)
	}
	must(t, db.Tx(ctx, a.TenantID, func(tx pgx.Tx) error {
		var retained int
		if err := tx.QueryRow(ctx, `SELECT count(*) FROM revisions WHERE collection_id=ANY($1::uuid[])`, []string{shared.CollectionID, alone.CollectionID, later.CollectionID}).Scan(&retained); err != nil {
			return err
		}
		if retained != 3 {
			t.Error("content physically deleted before retention elapsed", retained)
		}
		return nil
	}))
}
