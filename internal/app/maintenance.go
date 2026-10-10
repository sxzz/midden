package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"monitor/internal/domain"
	"monitor/internal/store"
)

var (
	QueueDepth = prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "monitor_queue_jobs", Help: "Queue size by state"}, []string{"queue", "state"})
	QueueAge   = prometheus.NewGauge(prometheus.GaugeOpts{Name: "monitor_queue_oldest_seconds", Help: "Age of oldest waiting job"})
)

func init() { prometheus.MustRegister(QueueDepth, QueueAge) }

// Each pass removes at most this many rows per statement; a pass repeats while
// it fills its batch, up to maintenanceBudget.
const (
	maintenanceBatch  = 100
	maintenanceBudget = 30 * time.Second
	// A capture this old with no job left to finish it was interrupted.
	staleCaptureAge = time.Hour
)

// Maintain runs every housekeeping step. The steps are independent: one that
// fails is reported with its name and the rest still run, so a single bad row
// or object cannot stop collection, cleanup and metrics behind it.
func (s *Service) Maintain(ctx context.Context) error {
	steps := []struct {
		name string
		run  func(context.Context) error
	}{
		{"web sessions", func(ctx context.Context) error {
			_, e := s.DB.Pool.Exec(ctx, `SELECT cleanup_web_sessions()`)
			return e
		}},
		{"terminal jobs", s.reconcileJobs},
		{"stale captures", s.failStaleCaptures},
		{"unreferenced collections", s.collectCollections},
		{"garbage objects", func(ctx context.Context) error {
			var graceHours int64
			if e := s.DB.Pool.QueryRow(ctx, `SELECT value::bigint FROM config WHERE key='object_gc_grace_hours'`).Scan(&graceHours); e != nil {
				return e
			}
			return s.Collect(ctx, time.Duration(graceHours)*time.Hour)
		}},
		{"thumbnail backfill", s.backfillThumbnails},
		{"queue metrics", s.queueMetrics},
	}
	var failed []error
	for _, step := range steps {
		if e := step.run(ctx); e != nil {
			failed = append(failed, fmt.Errorf("%s: %w", step.name, e))
		}
	}
	return errors.Join(failed...)
}

// Reconcile terminal River jobs, including processes killed during their final attempt.
func (s *Service) reconcileJobs(ctx context.Context) error {
	rows, e := s.DB.Pool.Query(ctx, `SELECT id,args FROM river_job WHERE kind='monitor_task' AND state IN('discarded','cancelled') AND NOT (metadata @> '{"reconciled":true}') ORDER BY id LIMIT $1`, maintenanceBatch)
	if e != nil {
		return e
	}
	type item struct {
		ID  int64
		Raw []byte
	}
	var items []item
	for rows.Next() {
		var i item
		if e = rows.Scan(&i.ID, &i.Raw); e != nil {
			rows.Close()
			return e
		}
		items = append(items, i)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	var failed []error
	for _, i := range items {
		var task store.Task
		// Arguments that cannot be read name nothing to fail; the job is settled as it is.
		if e = json.Unmarshal(i.Raw, &task); e == nil {
			if e = s.fail(ctx, task, "job exhausted retries or was interrupted"); e != nil && !errors.Is(e, domain.ErrNotFound) {
				// Left unreconciled for the next pass; the jobs after it still settle.
				failed = append(failed, fmt.Errorf("job %d: %w", i.ID, e))
				continue
			}
		}
		if _, e = s.DB.Pool.Exec(ctx, `UPDATE river_job SET metadata=metadata || '{"reconciled":true}'::jsonb WHERE id=$1`, i.ID); e != nil {
			failed = append(failed, fmt.Errorf("job %d: %w", i.ID, e))
		}
	}
	return errors.Join(failed...)
}

// failStaleCaptures ends captures that no queue job can finish any more, for
// example after job rows were lost. Left running they hold their reservation,
// keep later submissions waiting on them and keep their collection from
// being collected.
func (s *Service) failStaleCaptures(ctx context.Context) error {
	rows, e := s.DB.Pool.Query(ctx, `SELECT id,tenant_id FROM stale_captures($1::interval,$2)`, fmt.Sprintf("%f seconds", staleCaptureAge.Seconds()), maintenanceBatch)
	if e != nil {
		return e
	}
	var tasks []store.Task
	for rows.Next() {
		task := store.Task{Type: "capture"}
		if e = rows.Scan(&task.ID, &task.Tenant); e != nil {
			rows.Close()
			return e
		}
		tasks = append(tasks, task)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	var failed []error
	for _, task := range tasks {
		if e = s.fail(ctx, task, "capture was interrupted"); e != nil && !errors.Is(e, domain.ErrNotFound) {
			failed = append(failed, fmt.Errorf("capture %s: %w", task.ID, e))
		}
	}
	return errors.Join(failed...)
}

func (s *Service) collectCollections(ctx context.Context) error {
	deadline := time.Now().Add(maintenanceBudget)
	for {
		var removed int
		if e := s.DB.Pool.QueryRow(ctx, `SELECT collect_unreferenced_collections((SELECT value::bigint FROM config WHERE key='collection_retention_days') * interval '1 day')`).Scan(&removed); e != nil {
			return e
		}
		if removed < maintenanceBatch || time.Now().After(deadline) {
			return nil
		}
	}
}

func (s *Service) queueMetrics(ctx context.Context) error {
	rows, e := s.DB.Pool.Query(ctx, `SELECT queue,state,count(*) FROM river_job GROUP BY queue,state`)
	if e != nil {
		return e
	}
	QueueDepth.Reset()
	for rows.Next() {
		var q, state string
		var count float64
		if e = rows.Scan(&q, &state, &count); e != nil {
			rows.Close()
			return e
		}
		QueueDepth.WithLabelValues(q, state).Set(count)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	var age float64
	e = s.DB.Pool.QueryRow(ctx, `SELECT coalesce(extract(epoch FROM now()-min(created_at)),0) FROM river_job WHERE state IN('available','retryable','scheduled')`).Scan(&age)
	if e == nil {
		QueueAge.Set(age)
	}
	return e
}
