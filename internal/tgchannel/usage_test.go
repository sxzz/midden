package tgchannel

import (
	"testing"

	"monitor/internal/domain"
)

func TestUsageText(t *testing.T) {
	for _, c := range []struct {
		usage domain.Usage
		want  string
	}{
		{domain.Usage{Used: 3 << 20, Limit: 1 << 30}, "已用 3.0 MiB，共 1.0 GiB"},
		{domain.Usage{Used: 3 << 20, Reserved: 1 << 20, Limit: 1 << 30}, "已用 3.0 MiB，共 1.0 GiB\n保存中 1.0 MiB"},
		// The configured limit does not apply to an unlimited tenant.
		{domain.Usage{Unlimited: true, Used: 5 << 30, Limit: 1 << 30}, "已用 5.0 GiB，不限额"},
	} {
		if got := usageText(c.usage); got != c.want {
			t.Errorf("usageText(%+v) = %q, want %q", c.usage, got, c.want)
		}
	}
}
