package runtime

import (
	"github.com/riverqueue/river"

	"monitor/internal/app"
)

func queues(c app.Config) map[string]river.QueueConfig {
	return map[string]river.QueueConfig{"capture": {MaxWorkers: c.CaptureWorkers}, "download": {MaxWorkers: c.DownloadWorkers}, "control": {MaxWorkers: c.ControlWorkers}}
}

func requiredConnections(c app.Config) int {
	return 3*c.CaptureWorkers + c.DownloadWorkers + c.ControlWorkers + 8
}
