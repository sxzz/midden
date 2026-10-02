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
		// A finished profile still waits for its posts.
		{domain.RefreshBatch{State: "complete", UpdateMode: "full", Total: 1, Submitted: 1, Complete: 1, Members: domain.MemberProgress{Total: 100, Complete: 60, Pending: 40}}, "批量完整更新中…\n已提交 1/1 · 已抓取 1\n帖子：60/100 · 抓取中 40 · 已保存 60"},
		// A profile still updating lists its posts beside the others in progress.
		{domain.RefreshBatch{State: "running", UpdateMode: "full", Total: 47, Submitted: 2, Running: 2, Members: domain.MemberProgress{Total: 40, Complete: 12, Pending: 8}, Active: []domain.RefreshItem{
			{URL: "https://x.test/a", Members: domain.MemberProgress{Total: 20, Complete: 12, Pending: 8}},
			{URL: "https://x.test/b", Running: true, Members: domain.MemberProgress{Total: 20}},
			{URL: "https://x.test/c", Running: true},
			{URL: "https://x.test/d"},
		}}, "批量完整更新中…\n已提交 2/47 · 抓取中 2\n帖子：12/40 · 抓取中 8 · 已保存 12\n\n进行中：\n• x.test/a：帖子 12/20 · 抓取中 8 · 已保存 12\n• x.test/b：抓取中 · 帖子 0/20\n• x.test/c：抓取中\n• x.test/d：提交帖子中"},
		{domain.RefreshBatch{State: "complete", UpdateMode: "full", Total: 1, Submitted: 1, Complete: 1, Members: domain.MemberProgress{Total: 100, Complete: 98, Failed: 2, Done: true}, Done: true}, "批量完整更新完成，共 1 项\n已抓取 1\n帖子：已保存 98 · 失败 2"},
		{domain.RefreshBatch{State: "complete", UpdateMode: "append", Total: 10, Submitted: 10, Complete: 8, Reused: 5, Failed: 1, Rejected: 1, Done: true}, "批量附加更新完成，共 10 项\n已抓取 3 · 无变化 5 · 失败 1 · 无法更新 1"},
		{domain.RefreshBatch{State: "failed", Error: "storage quota exceeded", UpdateMode: "full", Total: 4, Submitted: 1, Done: true}, "批量完整更新已中止：存储空间不足\n已提交 1/4"},
	} {
		if got := batchMessage(c.batch); got != c.want {
			t.Errorf("batchMessage(%+v) = %q, want %q", c.batch, got, c.want)
		}
	}
}
