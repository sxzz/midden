package config

import (
	"context"
	"os"
	"strconv"
	"testing"

	"monitor/internal/store"
)

func TestDatabaseSettings(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Close()
	original, e := Load(ctx, db)
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Pool.Exec(ctx, `UPDATE config SET value=$1 WHERE key='capture_rate'`, strconv.Itoa(original.Rate))
	if _, e = admin.Pool.Exec(ctx, `UPDATE config SET value=23 WHERE key='capture_rate'`); e != nil {
		t.Fatal(e)
	}
	t.Setenv("CAPTURE_RATE", "99")
	got, e := Load(ctx, db)
	if e != nil {
		t.Fatal(e)
	}
	if got.Rate != 23 {
		t.Fatal("environment overrides database", got.Rate)
	}
	if _, e = db.Pool.Exec(ctx, `UPDATE config SET value=3 WHERE key='capture_rate'`); e == nil {
		t.Fatal("runtime can modify global settings")
	}
	if _, e = db.Pool.Exec(ctx, `DELETE FROM config WHERE key='capture_rate'`); e == nil {
		t.Fatal("runtime can delete settings")
	}
	for _, q := range []string{
		`UPDATE config SET value=0 WHERE key='collection_retention_days'`,
		`UPDATE config SET value=-1 WHERE key='max_media'`,
		`INSERT INTO config(key,value) VALUES('unknown',1)`,
	} {
		if _, e = admin.Pool.Exec(ctx, q); e == nil {
			t.Fatal("invalid setting accepted", q)
		}
	}
}
