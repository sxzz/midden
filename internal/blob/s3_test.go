package blob

import (
	"bytes"
	"context"
	"io"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/minio/minio-go/v7"
)

func TestSeekableS3(t *testing.T) {
	endpoint := os.Getenv("TEST_S3_ENDPOINT")
	if endpoint == "" {
		t.Skip("isolated S3 required")
	}
	ctx := context.Background()
	s, e := New(endpoint, "monitor-test", "monitor-test-secret", "web-ranges")
	if e != nil {
		t.Fatal(e)
	}
	if e = s.Client.MakeBucket(ctx, s.Bucket, minio.MakeBucketOptions{}); e != nil {
		t.Fatal(e)
	}
	key := uuid.NewString()
	data := bytes.Repeat([]byte("0123456789"), 1024)
	if e = s.Put(ctx, key, bytes.NewReader(data), int64(len(data)), "video/mp4"); e != nil {
		t.Fatal(e)
	}
	defer s.Delete(ctx, key)
	r, e := s.Open(ctx, key)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	end, e := r.Seek(0, io.SeekEnd)
	if e != nil || end != int64(len(data)) {
		t.Fatal(end, e)
	}
	if _, e = r.Seek(124, io.SeekStart); e != nil {
		t.Fatal(e)
	}
	buf := make([]byte, 5)
	if _, e = io.ReadFull(r, buf); e != nil || string(buf) != "45678" {
		t.Fatal(string(buf), e)
	}
	if _, e = r.Seek(0, io.SeekStart); e != nil {
		t.Fatal(e)
	}
	if _, e = io.ReadFull(r, buf); e != nil || string(buf) != "01234" {
		t.Fatal(string(buf), e)
	}
}
