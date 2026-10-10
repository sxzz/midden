package app

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"

	"monitor/internal/store"
)

// stubbornBlob refuses to delete chosen keys and records every attempt.
type stubbornBlob struct {
	memoryBlob
	lock     sync.Mutex
	refuse   map[string]bool
	attempts map[string]int
}

func (b *stubbornBlob) Delete(ctx context.Context, k string) error {
	b.lock.Lock()
	b.attempts[k]++
	refused := b.refuse[k]
	b.lock.Unlock()
	if refused {
		return fmt.Errorf("simulated storage failure")
	}
	return b.memoryBlob.Delete(ctx, k)
}

// Each housekeeping step has to make progress past what it cannot handle
// yet: rows that must be skipped, an object that will not delete, and a
// capture whose queue job no longer exists.
func TestMaintenanceMakesProgressPastBlockedWork(t *testing.T) {
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
	blobs := &stubbornBlob{memoryBlob: memoryBlob{m: map[string][]byte{}}, refuse: map[string]bool{}, attempts: map[string]int{}}
	s := &Service{DB: db, Blobs: blobs}
	exec := func(query string, args ...any) {
		t.Helper()
		_, err := admin.Pool.Exec(ctx, query, args...)
		must(t, err)
	}
	var tenant string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant))
	var fixtures []string
	collection := func(unreferenced string) (id string) {
		t.Helper()
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO collections(external_id,url,provider_id,platform,kind,unreferenced_at) VALUES($1,'https://example.test/items/1','fixture','fixture','item',now()-$2::interval) RETURNING id`, uuid.NewString(), unreferenced).Scan(&id))
		fixtures = append(fixtures, id)
		return
	}
	capture := func(collection, age string) (id string) {
		t.Helper()
		must(t, admin.Pool.QueryRow(ctx, `INSERT INTO captures(tenant_id,collection_id,provider_id,scope,adapter_id,created_at) VALUES($1,$2,'fixture','public','fixture',now()-$3::interval) RETURNING id`, tenant, collection, age).Scan(&id))
		return
	}
	state := func(capture string) (state, reason string) {
		t.Helper()
		must(t, admin.Pool.QueryRow(ctx, `SELECT state,error FROM captures WHERE id=$1`, capture).Scan(&state, &reason))
		return
	}
	exists := func(collection string) (ok bool) {
		t.Helper()
		must(t, admin.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM collections WHERE id=$1)`, collection).Scan(&ok))
		return
	}

	// More collections than one batch are older than the one that can go, and
	// none of them can be collected while their capture is still running.
	var busy []string
	for range maintenanceBatch + 5 {
		id := collection("400 days")
		capture(id, "1 minute")
		busy = append(busy, id)
	}
	free := collection("300 days")
	done := capture(free, "1 minute")
	exec(`UPDATE captures SET state='failed',finished_at=now() WHERE id=$1`, done)

	// A capture with no job left is interrupted; one whose job is still
	// queued, or which only just started, is not.
	orphan := capture(collection("0 seconds"), "2 hours")
	queued := capture(collection("0 seconds"), "2 hours")
	exec(`INSERT INTO river_job(args,kind,max_attempts,queue,state) VALUES(jsonb_build_object('id',$1::text,'type','capture','tenant',$2::text),'monitor_task',3,'capture','scheduled')`, queued, tenant)
	fresh := capture(collection("0 seconds"), "1 minute")

	// One object cannot be deleted; the ones after it in the same batch can.
	var stuck, removable string
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO objects(uploaded_by,object_key,state,created_at) VALUES($1,$2,'garbage',now()-interval '900 days') RETURNING object_key`, tenant, "test/"+uuid.NewString()).Scan(&stuck))
	must(t, admin.Pool.QueryRow(ctx, `INSERT INTO objects(uploaded_by,object_key,state,created_at) VALUES($1,$2,'garbage',now()-interval '899 days') RETURNING object_key`, tenant, "test/"+uuid.NewString()).Scan(&removable))
	blobs.refuse[stuck] = true

	err = s.Maintain(ctx)
	if err == nil || !strings.Contains(err.Error(), "garbage objects: object ") || !strings.Contains(err.Error(), "simulated storage failure") {
		t.Fatal("the failing step was not reported by name", err)
	}
	if exists(free) {
		t.Fatal("skipped collections filled the batch and hid the collectable one")
	}
	for _, id := range busy {
		if !exists(id) {
			t.Fatal("a collection with a running capture was collected")
		}
	}
	if got, reason := state(orphan); got != "failed" || reason != "capture was interrupted" {
		t.Fatal("capture without a job kept running", got, reason)
	}
	if got, _ := state(queued); got != "queued" {
		t.Fatal("capture with a queued job was interrupted", got)
	}
	if got, _ := state(fresh); got != "queued" {
		t.Fatal("recent capture was interrupted", got)
	}
	var left, attempts int
	var deferred bool
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM objects WHERE object_key=$1`, removable).Scan(&left))
	if left != 0 {
		t.Fatal("object behind a failing one was not collected")
	}
	must(t, admin.Pool.QueryRow(ctx, `SELECT gc_attempts,gc_after>now() FROM objects WHERE object_key=$1`, stuck).Scan(&attempts, &deferred))
	if attempts != 1 || !deferred {
		t.Fatal("failing object was not deferred", attempts, deferred)
	}
	// While it waits, the failing object is not tried again.
	must(t, s.Maintain(ctx))
	if blobs.attempts[stuck] != 1 {
		t.Fatal("deferred object was retried at once", blobs.attempts[stuck])
	}
	exec(`UPDATE objects SET gc_after=now()-interval '1 second' WHERE object_key=$1`, stuck)
	blobs.refuse[stuck] = false
	must(t, s.Maintain(ctx))
	must(t, admin.Pool.QueryRow(ctx, `SELECT count(*) FROM objects WHERE object_key=$1`, stuck).Scan(&left))
	if left != 0 {
		t.Fatal("object was not collected once storage recovered")
	}

	// Other tests count what the shared collector removes; leave nothing for it.
	exec(`DELETE FROM river_job WHERE args->>'tenant'=$1`, tenant)
	exec(`DELETE FROM captures WHERE tenant_id=$1`, tenant)
	exec(`DELETE FROM collections WHERE id=ANY($1::uuid[])`, fixtures)
}
