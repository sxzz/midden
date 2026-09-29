package app

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/channelapi"
	"monitor/internal/domain"
	"monitor/internal/store"
)

type pageAdapter struct{ *collectionAdapter }

func (f *pageAdapter) Describe(ctx context.Context, r *pb.DescribeRequest, o ...grpc.CallOption) (*pb.DescribeResponse, error) {
	d, e := f.collectionAdapter.Describe(ctx, r, o...)
	d.Providers[0].Capabilities = append(d.Providers[0].Capabilities, &pb.Capability{Name: adapter.CapturePage, Major: 1})
	return d, e
}

func (f *pageAdapter) Resolve(ctx context.Context, r *pb.ResolveRequest, o ...grpc.CallOption) (*pb.ResolveResponse, error) {
	d, e := f.collectionAdapter.Resolve(ctx, r, o...)
	if e == nil {
		d.Collection = d.Kind == "collection"
	}
	return d, e
}

func (f *pageAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, o ...grpc.CallOption) (*pb.FetchResponse, error) {
	d, e := f.collectionAdapter.Fetch(ctx, r, o...)
	if r.Kind == "collection" && !r.Automatic {
		d.MaxBatchSize = 1000
		d.RelatedTargets = []*pb.RelatedTarget{{Url: "https://notes.test/entry/" + r.ExternalId + "-" + r.PageCursor}}
		if r.PageCursor == "" {
			d.NextPageCursor = "second"
		}
	}
	return d, e
}

func collectionData(t *testing.T, s *Service, tenant, id string) *channelapi.CollectionProgress {
	t.Helper()
	c, err := s.channelCollection(context.Background(), tenant, id)
	must(t, err)
	return c
}

func TestCollectionProgressAndMore(t *testing.T) {
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
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	must(t, e)
	var tenant, other string
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&tenant))
	must(t, admin.Pool.QueryRow(ctx, "INSERT INTO tenants DEFAULT VALUES RETURNING id").Scan(&other))
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: q, Adapter: &pageAdapter{&collectionAdapter{&fakeAdapter{}}}, Config: cfg}
	target := "https://notes.test/collection/" + uuid.NewString()
	// Explicit collection must not join an automatic capture that skips expansion.
	automatic, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: target, Automatic: true})
	must(t, e)
	job, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: target})
	must(t, e)
	if job.ID == automatic.ID {
		t.Fatal("explicit request reused non-expanding capture")
	}
	// Complete both before canonicalizing the shared root.
	for _, j := range []domain.Job{automatic, job} {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: j.ID}))
		must(t, s.finalize(ctx, tenant, j.ID))
	}
	var sid string
	must(t, admin.Pool.QueryRow(ctx, "SELECT id FROM submissions WHERE capture_id=$1", job.ID).Scan(&sid))
	channel := uuid.NewString()
	_, e = admin.Pool.Exec(ctx, "INSERT INTO channels(id,kind,external_id) VALUES($1,'test',$2)", channel, channel)
	must(t, e)
	_, e = admin.Pool.Exec(ctx, "UPDATE submissions SET chat_id='42',channel_id=$2 WHERE id=$1", sid, channel)
	must(t, e)
	task := store.Task{Tenant: tenant, ID: sid}
	if collectionData(t, s, tenant, sid).Done {
		t.Fatal("must wait for child scheduling")
	}
	must(t, s.related(ctx, task))
	if collectionData(t, s, tenant, sid).Done {
		t.Fatal("must wait for child completion")
	}
	var child string
	must(t, admin.Pool.QueryRow(ctx, "SELECT capture_id FROM submissions WHERE idem_key=$1", "related:"+sid+":0").Scan(&child))
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: child}))
	must(t, s.finalize(ctx, tenant, child))
	c := collectionData(t, s, tenant, sid)
	if !c.Done || c.Complete != 1 || c.Next != "second" {
		t.Fatalf("progress: %+v", c)
	}
	_, e = admin.Pool.Exec(ctx, "UPDATE submissions SET state='sent' WHERE id=$1", sid)
	must(t, e)
	_, e = s.channelPage(ctx, tenant, domain.Origin{}, uuid.NewString(), sid, "more")
	must(t, e)
	_, e = s.channelPage(ctx, tenant, domain.Origin{}, uuid.NewString(), sid, "more")
	must(t, e)
	var count int
	var cursor, nextID string
	must(t, admin.Pool.QueryRow(ctx, "SELECT count(*) FROM submissions WHERE tenant_id=$1 AND idem_key=$2", tenant, "more:"+sid).Scan(&count))
	if count != 1 {
		t.Fatal("duplicate page")
	}
	must(t, admin.Pool.QueryRow(ctx, "SELECT c.id,c.page_cursor FROM submissions p JOIN captures c ON c.id=p.capture_id WHERE p.tenant_id=$1 AND p.idem_key=$2", tenant, "more:"+sid).Scan(&nextID, &cursor))
	if cursor != "second" {
		t.Fatal(cursor)
	}
	if _, e = s.channelPage(ctx, other, domain.Origin{}, uuid.NewString(), sid, "more"); e == nil {
		t.Fatal("cross tenant page access")
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: nextID}))
	must(t, s.finalize(ctx, tenant, nextID))
	var next string
	must(t, admin.Pool.QueryRow(ctx, "SELECT next_page_cursor FROM captures WHERE id=$1", nextID).Scan(&next))
	if next != "" {
		t.Fatal("end cursor")
	}
	// Batch continuation is persisted and resumes without sending one message per page.
	batch, e := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/" + uuid.NewString(), PageSize: 1000, CollectionLimit: 1000})
	must(t, e)
	var batchSID string
	must(t, admin.Pool.QueryRow(ctx, "SELECT id FROM submissions WHERE capture_id=$1", batch.ID).Scan(&batchSID))
	_, e = admin.Pool.Exec(ctx, "UPDATE submissions SET chat_id='42',channel_id=$2 WHERE id=$1", batchSID, channel)
	must(t, e)
	currentID, currentSID := batch.ID, batchSID
	pages := 0
	for {
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: currentID}))
		must(t, s.finalize(ctx, tenant, currentID))
		resumed := *s
		s = &resumed
		step := store.Task{Tenant: tenant, ID: currentSID}
		must(t, s.related(ctx, step))
		must(t, s.related(ctx, step))
		var entry string
		must(t, admin.Pool.QueryRow(ctx, "SELECT capture_id FROM submissions WHERE idem_key=$1", "related:"+currentSID+":0").Scan(&entry))
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: entry}))
		must(t, s.finalize(ctx, tenant, entry))
		pages++
		var following string
		must(t, admin.Pool.QueryRow(ctx, "SELECT coalesce(next_submission::text,'') FROM submissions WHERE id=$1", currentSID).Scan(&following))
		if following == "" {
			break
		}
		if pages > 3 {
			t.Fatal("unbounded pagination")
		}
		if collectionData(t, s, tenant, batchSID).Done {
			t.Fatal("batch finished before following page")
		}
		currentSID = following
		must(t, admin.Pool.QueryRow(ctx, "SELECT capture_id FROM submissions WHERE id=$1", following).Scan(&currentID))
	}
	c = collectionData(t, s, tenant, batchSID)
	if pages != 2 || !c.Done || c.Complete != 2 || c.Next != "" {
		t.Fatalf("batch %d: %+v", pages, c)
	}
	// A stop is durable, tenant-scoped, and prevents any further child submissions.
	stoppedJob, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/collection/" + uuid.NewString(), Key: uuid.NewString()})
	must(t, err)
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: stoppedJob.ID}))
	must(t, s.finalize(ctx, tenant, stoppedJob.ID))
	var stoppedSID string
	must(t, admin.Pool.QueryRow(ctx, "SELECT id FROM submissions WHERE capture_id=$1", stoppedJob.ID).Scan(&stoppedSID))
	_, err = admin.Pool.Exec(ctx, "UPDATE submissions SET chat_id='42',channel_id=$2 WHERE id=$1", stoppedSID, channel)
	must(t, err)
	stoppedTask := store.Task{Tenant: tenant, ID: stoppedSID}
	if err = s.StopCollection(ctx, other, stoppedSID); err == nil {
		t.Fatal("cross-tenant stop allowed")
	}
	childJob, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/entry/" + uuid.NewString(), Key: "related:" + stoppedSID + ":0", ParentSubmission: stoppedSID, Automatic: true})
	must(t, err)
	must(t, s.StopCollection(ctx, tenant, stoppedSID))
	must(t, s.StopCollection(ctx, tenant, stoppedSID))
	must(t, s.related(ctx, stoppedTask))
	_, err = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/entry/" + uuid.NewString(), Key: uuid.NewString(), ParentSubmission: stoppedSID})
	if !errors.Is(err, errCollectionStopped) {
		t.Fatalf("expected stopped checkpoint: %v", err)
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: childJob.ID}))
	must(t, s.finalize(ctx, tenant, childJob.ID))
	c = collectionData(t, s, tenant, stoppedSID)
	if !c.Stopped || !c.Done || c.Complete != 1 {
		t.Fatalf("stopped: %+v", c)
	}

	_, err = admin.Pool.Exec(ctx, "UPDATE captures SET paused=true WHERE id=$1", stoppedJob.ID)
	must(t, err)
	for _, task := range []store.Task{{Tenant: tenant, ID: stoppedJob.ID, Type: "capture"}, {Tenant: tenant, ID: stoppedSID, Type: "related"}} {
		paused, e := s.taskPaused(ctx, task)
		must(t, e)
		if !paused {
			t.Fatal("pause checkpoint ignored", task.Type)
		}
	}
	paused, err := s.taskPaused(ctx, store.Task{Tenant: tenant, ID: childJob.ID, Type: "capture"})
	must(t, err)
	if paused {
		t.Fatal("unrelated capture paused")
	}

}
