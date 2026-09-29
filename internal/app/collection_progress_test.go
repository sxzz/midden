package app

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
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

type collectionSender struct {
	fakeSender
	text    string
	buttons telegram.Keyboard
	edits   int
}

func (f *collectionSender) SendInteractive(_ context.Context, _ string, text string, mid int64, b telegram.Keyboard) (int64, error) {
	f.text = text
	f.buttons = b
	if mid != 0 {
		f.edits++
	}
	return 101, nil
}
func (f *collectionSender) Action(context.Context, string, string) error { return nil }
func (f *collectionSender) Answer(context.Context, string) error         { return nil }

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
	sender := &collectionSender{}
	cfg := Defaults()
	cfg.Rate = 1000
	s := &Service{DB: db, Queue: q, Adapter: &pageAdapter{&collectionAdapter{&fakeAdapter{}}}, Config: cfg, Sender: sender}
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
	if e = s.deliver(ctx, task); e == nil {
		t.Fatal("must wait for child scheduling")
	}
	must(t, s.related(ctx, task))
	if e = s.deliver(ctx, task); e == nil {
		t.Fatal("must wait for child completion")
	}
	var child string
	must(t, admin.Pool.QueryRow(ctx, "SELECT capture_id FROM submissions WHERE idem_key=$1", "related:"+sid+":0").Scan(&child))
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: child}))
	must(t, s.finalize(ctx, tenant, child))
	must(t, s.deliver(ctx, task))
	must(t, s.deliver(ctx, task))
	if !strings.Contains(sender.text, "已保存 1") || sender.edits == 0 {
		t.Fatal(sender.text)
	}
	found := false
	for _, row := range sender.buttons {
		for _, b := range row {
			if b.Data == "/more "+sid {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("missing next page")
	}
	req := &commandRequest{Task: store.Task{Tenant: tenant, ID: uuid.NewString()}, Argument: sid}
	must(t, s.commandMore(ctx, req))
	must(t, s.commandMore(ctx, req))
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
	req.Task.Tenant = other
	if s.commandMore(ctx, req) == nil {
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
		if e = s.deliver(ctx, store.Task{Tenant: tenant, ID: batchSID}); e == nil {
			t.Fatal("batch finished before following page")
		}
		currentSID = following
		must(t, admin.Pool.QueryRow(ctx, "SELECT capture_id FROM submissions WHERE id=$1", following).Scan(&currentID))
	}
	must(t, s.deliver(ctx, store.Task{Tenant: tenant, ID: batchSID}))
	if pages != 2 || !strings.Contains(sender.text, "已保存 2") {
		t.Fatal("batch progress", pages, sender.text)
	}
	for _, row := range sender.buttons {
		for _, b := range row {
			if strings.HasPrefix(b.Data, "/more") {
				t.Fatal("next button after end")
			}
		}
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
	_ = s.deliver(ctx, stoppedTask)
	hasStop := false
	for _, row := range sender.buttons {
		for _, b := range row {
			if b.Data == "/collection_stop "+stoppedSID {
				hasStop = true
			}
		}
	}
	if !hasStop {
		t.Fatal("missing stop button")
	}
	if err = s.commandCollectionStop(ctx, &commandRequest{Task: store.Task{Tenant: other}, Argument: stoppedSID}); err == nil {
		t.Fatal("cross-tenant stop allowed")
	}
	childJob, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/entry/" + uuid.NewString(), Key: "related:" + stoppedSID + ":0", ParentSubmission: stoppedSID, Automatic: true})
	must(t, err)
	stopRequest := &commandRequest{Task: store.Task{Tenant: tenant}, Argument: stoppedSID}
	must(t, s.commandCollectionStop(ctx, stopRequest))
	must(t, s.commandCollectionStop(ctx, stopRequest))
	must(t, s.related(ctx, stoppedTask))
	_, err = s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/entry/" + uuid.NewString(), Key: uuid.NewString(), ParentSubmission: stoppedSID})
	if !errors.Is(err, errCollectionStopped) {
		t.Fatalf("expected stopped checkpoint: %v", err)
	}
	must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: childJob.ID}))
	must(t, s.finalize(ctx, tenant, childJob.ID))
	must(t, s.deliver(ctx, stoppedTask))
	if !strings.Contains(sender.text, "帖子抓取已中止") || !strings.Contains(sender.text, "已保存 1") {
		t.Fatal(sender.text)
	}
	for _, row := range sender.buttons {
		for _, b := range row {
			if b.Text == "中止" {
				t.Fatal("stop button still active")
			}
		}
	}

	_, err = admin.Pool.Exec(ctx, "UPDATE captures SET paused=true WHERE id=$1", stoppedJob.ID)
	must(t, err)
	for _, task := range []store.Task{{Tenant: tenant, ID: stoppedJob.ID, Type: "capture"}, {Tenant: tenant, ID: stoppedSID, Type: "related"}, {Tenant: tenant, ID: stoppedSID, Type: "status"}} {
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
