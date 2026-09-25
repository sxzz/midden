package app

import "github.com/prometheus/client_golang/prometheus"

var (
	TaskDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "monitor_task_duration_seconds", Help: "Worker execution duration", Buckets: prometheus.DefBuckets}, []string{"type"})
	TaskResults  = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "monitor_task_results_total", Help: "Worker outcomes"}, []string{"type", "result"})
)

func init() { prometheus.MustRegister(TaskDuration, TaskResults) }
