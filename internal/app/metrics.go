package app

import "github.com/prometheus/client_golang/prometheus"

var (
	ProviderResults  = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "monitor_provider_requests_total", Help: "Provider RPC outcomes"}, []string{"provider", "result"})
	ProviderDuration = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "monitor_provider_duration_seconds", Help: "Provider RPC duration", Buckets: prometheus.DefBuckets}, []string{"provider"})
	TaskDuration     = prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "monitor_task_duration_seconds", Help: "Worker execution duration", Buckets: prometheus.DefBuckets}, []string{"type"})
	TaskResults      = prometheus.NewCounterVec(prometheus.CounterOpts{Name: "monitor_task_results_total", Help: "Worker outcomes"}, []string{"type", "result"})
)

func init() { prometheus.MustRegister(TaskDuration, TaskResults, ProviderResults, ProviderDuration) }
