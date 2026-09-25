package config

import (
	"fmt"
	"os"
	"strconv"

	"monitor/internal/app"
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

func Limits() (app.Config, error) {
	c := app.Defaults()
	items := []struct {
		k string
		p *int
	}{{"CAPTURE_RATE", &c.Rate}, {"TENANT_CONCURRENCY", &c.TenantConcurrency}, {"CAPTURE_WORKERS", &c.CaptureWorkers}, {"DOWNLOAD_WORKERS", &c.DownloadWorkers}, {"MAX_IMAGES", &c.MaxImages}}
	for _, i := range items {
		if v := os.Getenv(i.k); v != "" {
			n, e := strconv.Atoi(v)
			if e != nil || n < 1 || n > 1000 {
				return c, fmt.Errorf("invalid %s", i.k)
			}
			*i.p = n
		}
	}
	for _, i := range []struct {
		k string
		p *int64
	}{{"TENANT_QUOTA_BYTES", &c.Quota}, {"MAX_IMAGE_BYTES", &c.MaxImageBytes}} {
		if v := os.Getenv(i.k); v != "" {
			n, e := strconv.ParseInt(v, 10, 64)
			if e != nil || n < 1 {
				return c, fmt.Errorf("invalid %s", i.k)
			}
			*i.p = n
		}
	}
	return c, nil
}
