package tgchannel

import (
	"testing"

	"monitor/internal/domain"
)

func TestBatchMessage(t *testing.T) {
	for _, c := range []struct {
		batch domain.RefreshBatch
		want  string
	}{
		{domain.RefreshBatch{State: "running", UpdateMode: "append", Total: 10, Submitted: 3, Running: 2, Complete: 1}, "批量附加更新中…\n已提交 3/10 · 抓取中 2 · 已抓取 1"},
		// Submission is over but captures still run: the batch is not done yet.
		{domain.RefreshBatch{State: "complete", UpdateMode: "full", Total: 2, Submitted: 2, Running: 1, Complete: 1}, "批量完整更新中…\n已提交 2/2 · 抓取中 1 · 已抓取 1"},
		{domain.RefreshBatch{State: "complete", UpdateMode: "append", Total: 10, Submitted: 10, Complete: 8, Reused: 5, Failed: 1, Rejected: 1}, "批量附加更新完成，共 10 项\n已抓取 3 · 无变化 5 · 失败 1 · 无法更新 1"},
		{domain.RefreshBatch{State: "failed", Error: "storage quota exceeded", UpdateMode: "full", Total: 4, Submitted: 1}, "批量完整更新已中止：存储空间不足\n已提交 1/4"},
	} {
		if got := batchMessage(c.batch); got != c.want {
			t.Errorf("batchMessage(%+v) = %q, want %q", c.batch, got, c.want)
		}
	}
}
