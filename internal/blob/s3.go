package blob

import (
	"context"
	"fmt"
	"io"
	"net/url"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type Storage interface {
	Put(context.Context, string, io.Reader, int64, string) error
	Get(context.Context, string) (io.ReadCloser, error)
	Delete(context.Context, string) error
}

type S3 struct {
	Client *minio.Client
	Bucket string
}

func New(endpoint, key, secret, bucket string) (*S3, error) {
	u, e := url.Parse(endpoint)
	if e != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || bucket == "" {
		return nil, fmt.Errorf("invalid S3 configuration")
	}
	c, e := minio.New(u.Host, &minio.Options{Creds: credentials.NewStaticV4(key, secret, ""), Secure: u.Scheme == "https"})
	return &S3{c, bucket}, e
}

func (s *S3) Put(ctx context.Context, key string, r io.Reader, n int64, mime string) error {
	_, e := s.Client.PutObject(ctx, s.Bucket, key, r, n, minio.PutObjectOptions{ContentType: mime, DisableMultipart: true})
	return e
}

func (s *S3) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	o, e := s.Client.GetObject(ctx, s.Bucket, key, minio.GetObjectOptions{})
	if e != nil {
		return nil, e
	}
	if _, e = o.Stat(); e != nil {
		o.Close()
		return nil, e
	}
	return o, nil
}

func (s *S3) Delete(ctx context.Context, key string) error {
	return s.Client.RemoveObject(ctx, s.Bucket, key, minio.RemoveObjectOptions{})
}

// Open returns a seekable stream; minio translates seeks to ranged S3 requests.
func (s *S3) Open(ctx context.Context, key string) (ReadSeekCloser, error) {
	o, e := s.Client.GetObject(ctx, s.Bucket, key, minio.GetObjectOptions{})
	if e != nil {
		return nil, e
	}
	if _, e = o.Stat(); e != nil {
		o.Close()
		return nil, e
	}
	return o, nil
}

type ReadSeekCloser interface {
	io.Reader
	io.Seeker
	io.Closer
}
type Seekable interface {
	Open(context.Context, string) (ReadSeekCloser, error)
}
