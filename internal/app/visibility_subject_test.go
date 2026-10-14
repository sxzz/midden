package app

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"
	"google.golang.org/grpc"

	pb "monitor/api/adapter/v1"
	"monitor/internal/domain"
	"monitor/internal/store"
)

// subjectAdapter keeps "private-" entries private for the account alice,
// "narrow-" entries private for their own reasons, and observes alice public
// on "observe-" entries.
type subjectAdapter struct {
	*collectionAdapter
	private bool
}

func (f *subjectAdapter) Describe(ctx context.Context, r *pb.DescribeRequest, opts ...grpc.CallOption) (*pb.DescribeResponse, error) {
	d, e := f.collectionAdapter.Describe(ctx, r, opts...)
	if e == nil && f.private {
		d.Providers[0].Visibilities = []pb.Visibility{pb.Visibility_VISIBILITY_PRIVATE}
	}
	return d, e
}

func (f *subjectAdapter) Fetch(ctx context.Context, r *pb.FetchRequest, opts ...grpc.CallOption) (*pb.FetchResponse, error) {
	out, e := f.collectionAdapter.Fetch(ctx, r, opts...)
	if e != nil {
		return nil, e
	}
	out.RelatedTargets = nil
	alice := &pb.ObjectRef{Platform: "notes", Kind: "person", ExternalId: "alice"}
	switch {
	case strings.HasPrefix(r.ExternalId, "private-"):
		out.Visibility = pb.Visibility_VISIBILITY_PRIVATE
		out.PrivateSubject = alice
	case strings.HasPrefix(r.ExternalId, "narrow-"):
		out.Visibility = pb.Visibility_VISIBILITY_PRIVATE
	case strings.HasPrefix(r.ExternalId, "observe-"):
		out.PublicSubjects = []*pb.ObjectRef{alice}
	}
	return out, nil
}

func TestAccountObservedPublicOpensVersionsKeptPrivateForIt(t *testing.T) {
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
	var owner, observer string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&owner))
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&observer))
	// A provider without accounts returns the one visibility it declares.
	services := map[bool]*Service{}
	for _, private := range []bool{false, true} {
		services[private] = &Service{DB: db, Queue: queue, Adapter: &subjectAdapter{&collectionAdapter{&fakeAdapter{}}, private}, Config: Defaults()}
		services[private].Config.Rate = 1000
	}
	capture := func(tenant, external string) string {
		t.Helper()
		s := services[!strings.HasPrefix(external, "observe-")]
		job, err := s.Submit(ctx, tenant, domain.CaptureInput{URL: "https://notes.test/entry/" + external})
		must(t, err)
		must(t, s.capture(ctx, store.Task{Tenant: tenant, ID: job.ID}))
		must(t, s.finalize(ctx, tenant, job.ID))
		return job.CollectionID
	}
	visibility := func(collection string) (v string) {
		t.Helper()
		must(t, admin.Pool.QueryRow(ctx, `SELECT visibility FROM revisions WHERE collection_id=$1 ORDER BY created_at DESC LIMIT 1`, collection).Scan(&v))
		return v
	}
	private := capture(owner, "private-"+uuid.NewString())
	narrow := capture(owner, "narrow-"+uuid.NewString())
	var subject string
	must(t, admin.Pool.QueryRow(ctx, `SELECT subject_platform||'/'||subject_kind||'/'||subject_scope||'/'||subject_external_id FROM revisions WHERE collection_id=$1`, private).Scan(&subject))
	if subject != "notes/person//alice" || visibility(private) != "private" {
		t.Fatalf("private version: %s %s", subject, visibility(private))
	}
	// Another tenant's capture observes the account public.
	capture(observer, "observe-"+uuid.NewString())
	if visibility(private) != "public" {
		t.Fatal("version kept private for an account seen public stayed private")
	}
	if visibility(narrow) != "private" {
		t.Fatal("version private for its own reasons was opened")
	}
	// The account turns protected again: new captures are private, the old
	// version stays as observed.
	later := capture(owner, "private-"+uuid.NewString())
	if visibility(later) != "private" || visibility(private) != "public" {
		t.Fatal("protection after publicity changed the wrong versions")
	}
}
