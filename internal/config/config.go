package config

import (
	"context"
	"fmt"
	"os"

	"monitor/internal/app"
	"monitor/internal/store"
)

func Get(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func Required(k string) string {
	v := os.Getenv(k)
	if v == "" {
		panic(k + " is required")
	}
	return v
}

// Load reads operating settings from the database; environment overrides are not supported.
func Load(ctx context.Context, db *store.Store) (app.Config, error) {
	var c app.Config
	rows, e := db.Pool.Query(ctx, `SELECT key,value::bigint FROM config WHERE value_type='integer'`)
	if e != nil {
		return c, e
	}
	defer rows.Close()
	values := map[string]int64{}
	for rows.Next() {
		var k string
		var v int64
		if e = rows.Scan(&k, &v); e != nil {
			return c, e
		}
		values[k] = v
	}
	if e = rows.Err(); e != nil {
		return c, e
	}
	for _, k := range []string{"tenant_quota_bytes", "capture_rate", "tenant_concurrency", "capture_workers", "download_workers", "control_workers", "delivery_workers", "max_image_bytes", "max_video_bytes", "max_media"} {
		if values[k] <= 0 {
			return c, fmt.Errorf("missing or invalid config: %s", k)
		}
	}
	c.Quota = values["tenant_quota_bytes"]
	c.Rate = int(values["capture_rate"])
	c.TenantConcurrency = int(values["tenant_concurrency"])
	c.CaptureWorkers = int(values["capture_workers"])
	c.DownloadWorkers = int(values["download_workers"])
	c.ControlWorkers = int(values["control_workers"])
	c.DeliveryWorkers = int(values["delivery_workers"])
	c.MaxImageBytes = values["max_image_bytes"]
	c.MaxVideoBytes = values["max_video_bytes"]
	c.MaxMedia = int(values["max_media"])
	return c, nil
}

func Telegram(ctx context.Context, db *store.Store) (token, channel string, err error) {
	err = db.Pool.QueryRow(ctx, `SELECT t.value,c.value FROM config t CROSS JOIN config c WHERE t.key='telegram_bot_token' AND c.key='telegram_channel_id'`).Scan(&token, &channel)
	if err == nil && token != "" && channel == "" {
		err = fmt.Errorf("telegram_channel_id is required when the bot is enabled")
	}
	return
}
