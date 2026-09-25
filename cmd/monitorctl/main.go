package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"

	"monitor/internal/blob"
	"monitor/internal/store"
)

func main() {
	if e := run(); e != nil {
		fmt.Fprintln(os.Stderr, e)
		os.Exit(1)
	}
}

func run() error {
	if len(os.Args) < 2 {
		return fmt.Errorf("usage: monitorctl storage-init | migrate | tenant-create | token-create TENANT | token-revoke TOKEN_ID | channel-create UUID BOT_ID | app-password")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if os.Args[1] == "storage-init" {
		return initStorage(ctx)
	}
	db, e := store.Open(ctx, os.Getenv("ADMIN_DATABASE_URL"))
	if e != nil {
		return fmt.Errorf("admin database unavailable")
	}
	defer db.Close()
	switch os.Args[1] {
	case "migrate":
		return db.Migrate(ctx)
	case "app-password":
		p := os.Getenv("APP_DB_PASSWORD")
		if p == "" {
			return fmt.Errorf("APP_DB_PASSWORD required")
		}
		_, e = db.Pool.Exec(ctx, "ALTER ROLE monitor_app PASSWORD '"+strings.ReplaceAll(p, "'", "''")+"'")
		return e
	case "tenant-create":
		var id string
		e = db.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&id)
		if e == nil {
			fmt.Println(id)
		}
		return e
	case "token-create":
		if len(os.Args) != 3 {
			return fmt.Errorf("tenant ID required")
		}
		if _, e = uuid.Parse(os.Args[2]); e != nil {
			return fmt.Errorf("invalid tenant ID")
		}
		token := uuid.NewString() + uuid.NewString()
		var id string
		e = db.Pool.QueryRow(ctx, `INSERT INTO tokens(tenant_id,digest) VALUES($1,$2) RETURNING id`, os.Args[2], store.Hash(token)).Scan(&id)
		if e == nil {
			fmt.Printf("token_id=%s\ntoken=%s\n", id, token)
		}
		return e
	case "token-revoke":
		if len(os.Args) != 3 {
			return fmt.Errorf("token ID required")
		}
		_, e = db.Pool.Exec(ctx, `UPDATE tokens SET revoked=true WHERE id=$1`, os.Args[2])
		return e
	case "channel-create":
		if len(os.Args) != 4 {
			return fmt.Errorf("stable channel UUID and numeric Bot ID required")
		}
		_, e = db.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'telegram',$2) ON CONFLICT(id) DO NOTHING`, os.Args[2], os.Args[3])
		return e
	default:
		return fmt.Errorf("unknown command")
	}
}

// initStorage waits for the local service, creates the bucket and verifies its permissions.
func initStorage(ctx context.Context) error {
	s, e := blob.New(os.Getenv("S3_ENDPOINT"), os.Getenv("S3_ACCESS_KEY"), os.Getenv("S3_SECRET_KEY"), os.Getenv("S3_BUCKET"))
	if e != nil {
		return e
	}
	ready := false
	for ctx.Err() == nil {
		exists, err := s.Client.BucketExists(ctx, s.Bucket)
		if err == nil {
			if !exists {
				err = s.Client.MakeBucket(ctx, s.Bucket, minio.MakeBucketOptions{})
			}
			if err == nil {
				ready = true
				break
			}
		}
		select {
		case <-ctx.Done():
		case <-time.After(time.Second):
		}
	}
	if !ready {
		return fmt.Errorf("S3 initialization timed out")
	}
	key := ".health/" + uuid.NewString()
	data := []byte("monitor-storage-check")
	if e = s.Put(ctx, key, bytes.NewReader(data), int64(len(data)), "text/plain"); e != nil {
		return fmt.Errorf("S3 write verification failed")
	}
	defer func() {
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = s.Delete(c, key)
	}()
	r, e := s.Get(ctx, key)
	if e != nil {
		return fmt.Errorf("S3 read verification failed")
	}
	actual, e := io.ReadAll(io.LimitReader(r, 1024))
	r.Close()
	if e != nil || !bytes.Equal(actual, data) {
		return fmt.Errorf("S3 content verification failed")
	}
	if e = s.Delete(ctx, key); e != nil {
		return fmt.Errorf("S3 delete verification failed")
	}
	fmt.Println("S3 bucket ready; write/read/delete verified")
	return nil
}
