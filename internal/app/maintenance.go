package app

import (
	"context"
	"encoding/json"
	"errors"
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

// Reconcile terminal River jobs, including processes killed during their final attempt.
func (s *Service) Maintain(ctx context.Context) error {
	rows, e := s.DB.Pool.Query(ctx, `SELECT id,args FROM river_job WHERE kind='monitor_task' AND state IN('discarded','cancelled') AND NOT (metadata @> '{"reconciled":true}') ORDER BY id LIMIT 100`)
	if e != nil {
		return e
	}
	type item struct {
		ID   int64
		Task store.Task
	}
	var items []item
	for rows.Next() {
		var id int64
		var raw []byte
		if e = rows.Scan(&id, &raw); e != nil {
			rows.Close()
			return e
		}
		var task store.Task
		if e = json.Unmarshal(raw, &task); e != nil {
			rows.Close()
			return e
		}
		items = append(items, item{id, task})
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, i := range items {
		if e = s.fail(ctx, i.Task, "job exhausted retries or was interrupted"); e != nil && !errors.Is(e, domain.ErrNotFound) {
			return e
		}
		if _, e = s.DB.Pool.Exec(ctx, `UPDATE river_job SET metadata=metadata || '{"reconciled":true}'::jsonb WHERE id=$1`, i.ID); e != nil {
			return e
		}
	}
	rows, e = s.DB.Pool.Query(ctx, `SELECT tenant_id FROM garbage_tenants()`)
	if e != nil {
		return e
	}
	var tenants []string
	for rows.Next() {
		var id string
		if e = rows.Scan(&id); e != nil {
			rows.Close()
			return e
		}
		tenants = append(tenants, id)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return e
	}
	for _, id := range tenants {
		if e = s.Collect(ctx, id, 24*time.Hour); e != nil {
			return e
		}
	}
	rows, e = s.DB.Pool.Query(ctx, `SELECT queue,state,count(*) FROM river_job GROUP BY queue,state`)
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
