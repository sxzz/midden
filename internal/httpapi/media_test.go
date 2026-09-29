package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"monitor/internal/app"
	"monitor/internal/blob"
	"monitor/internal/domain"
)

type streamMediaStorage struct {
	blob.Storage
	fail bool
}

func (s streamMediaStorage) Get(context.Context, string) (io.ReadCloser, error) {
	if s.fail {
		return nil, errors.New("storage unavailable")
	}
	return io.NopCloser(strings.NewReader("0123456789")), nil
}

type seekMediaStorage struct {
	streamMediaStorage
	failSeek bool
}

func (s seekMediaStorage) Open(context.Context, string) (blob.ReadSeekCloser, error) {
	if s.fail {
		return nil, errors.New("storage unavailable")
	}
	if s.failSeek {
		return brokenMediaSeeker{}, nil
	}
	return seekReader{bytes.NewReader([]byte("0123456789"))}, nil
}

type brokenMediaSeeker struct{}

func (brokenMediaSeeker) Read([]byte) (int, error)       { return 0, io.EOF }
func (brokenMediaSeeker) Seek(int64, int) (int64, error) { return 0, errors.New("seek failed") }
func (brokenMediaSeeker) Close() error                   { return nil }

func TestMediaCache(t *testing.T) {
	sum := sha256.Sum256([]byte("0123456789"))
	hash := hex.EncodeToString(sum[:])
	etag := `"` + hash + `"`
	for _, seekable := range []bool{false, true} {
		t.Run(map[bool]string{false: "stream", true: "seekable"}[seekable], func(t *testing.T) {
			var storage blob.Storage = streamMediaStorage{}
			if seekable {
				storage = seekMediaStorage{}
			}
			for _, tc := range []struct {
				name, method, query, noneMatch, ifRange, byteRange string
				code                                               int
				body, contentRange                                 string
			}{
				{name: "image", code: 200, body: "0123456789"},
				{name: "inline", query: "?inline=1", code: 200, body: "0123456789"},
				{name: "head", method: "HEAD", code: 200},
				{name: "match", noneMatch: etag, code: 304},
				{name: "weak-match", noneMatch: "W/" + etag, code: 304},
				{name: "list-match", noneMatch: `"other", W/` + etag, code: 304},
				{name: "wildcard", noneMatch: "*", code: 304},
				{name: "head-match", method: "HEAD", noneMatch: etag, code: 304},
				{name: "miss", noneMatch: `"other"`, code: 200, body: "0123456789"},
				{name: "range", byteRange: "bytes=2-5", code: 206, body: "2345", contentRange: "bytes 2-5/10"},
				{name: "suffix", byteRange: "bytes=-3", code: 206, body: "789", contentRange: "bytes 7-9/10"},
				{name: "open-ended", byteRange: "bytes=7-", code: 206, body: "789", contentRange: "bytes 7-9/10"},
				{name: "if-range-match", byteRange: "bytes=2-5", ifRange: etag, code: 206, body: "2345", contentRange: "bytes 2-5/10"},
				{name: "if-range-miss", byteRange: "bytes=2-5", ifRange: `"other"`, code: 200, body: "0123456789"},
				{name: "if-range-weak", byteRange: "bytes=2-5", ifRange: "W/" + etag, code: 200, body: "0123456789"},
				{name: "if-range-date", byteRange: "bytes=2-5", ifRange: "Wed, 21 Oct 2015 07:28:00 GMT", code: 200, body: "0123456789"},
				{name: "range-match", byteRange: "bytes=2-5", noneMatch: etag, code: 304},
				{name: "unsatisfiable", byteRange: "bytes=99-", code: 416, contentRange: "bytes */10"},
				{name: "malformed", byteRange: "bytes=invalid", code: 416},
				{name: "multiple", byteRange: "bytes=0-1,3-4", code: 416, contentRange: "bytes */10"},
				{name: "multiple-stale", byteRange: "bytes=0-1,3-4", ifRange: `"other"`, code: 200, body: "0123456789"},
				{name: "multiple-not-modified", byteRange: "bytes=0-1,3-4", noneMatch: etag, code: 304},
			} {
				t.Run(tc.name, func(t *testing.T) {
					method := tc.method
					if method == "" {
						method = "GET"
					}
					r := httptest.NewRequest(method, "/v1/assets/fixture"+tc.query, nil)
					r.Header.Set("If-None-Match", tc.noneMatch)
					r.Header.Set("If-Range", tc.ifRange)
					r.Header.Set("Range", tc.byteRange)
					w := httptest.NewRecorder()
					mime := "video/mp4"
					if tc.name == "image" {
						mime = "image/jpeg"
					}
					serveAsset(w, r, storage, domain.Asset{Hash: hash, Size: 10, MIME: mime})
					if w.Code != tc.code || w.Header().Get("Content-Range") != tc.contentRange {
						t.Fatalf("status/headers: %d %v", w.Code, w.Header())
					}
					if tc.code < 400 {
						if w.Body.String() != tc.body {
							t.Fatalf("body: %q", w.Body.String())
						}
						if w.Header().Get("Cache-Control") != mediaCacheControl || w.Header().Get("ETag") != etag {
							t.Fatal(w.Header())
						}
						disposition := "attachment"
						if tc.query != "" {
							disposition = "inline"
						}
						if w.Header().Get("Content-Disposition") != disposition {
							t.Fatal(w.Header())
						}
					} else if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("ETag") != "" {
						t.Fatal(w.Header())
					}
				})
			}
		})
	}
	for _, storage := range []blob.Storage{streamMediaStorage{fail: true}, seekMediaStorage{streamMediaStorage: streamMediaStorage{fail: true}}, seekMediaStorage{failSeek: true}} {
		r := httptest.NewRequest("GET", "/v1/assets/fixture", nil)
		r.Header.Set("If-None-Match", etag)
		// Open failures precede validators. Seek errors require a nonmatching request.
		if s, ok := storage.(seekMediaStorage); ok && s.failSeek {
			r.Header.Del("If-None-Match")
		}
		w := httptest.NewRecorder()
		serveAsset(w, r, storage, domain.Asset{Hash: hash, Size: 10, MIME: "image/png"})
		if w.Code < 500 || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("ETag") != "" {
			t.Fatalf("storage error: %d %v", w.Code, w.Header())
		}
	}
	for _, storage := range []blob.Storage{streamMediaStorage{}, seekMediaStorage{}} {
		r := httptest.NewRequest("GET", "/v1/assets/fixture", nil)
		r.Header.Set("If-Match", `"stale"`)
		w := httptest.NewRecorder()
		serveAsset(w, r, storage, domain.Asset{Hash: hash, Size: 10, MIME: "image/png"})
		if w.Code != http.StatusPreconditionFailed || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("ETag") != "" {
			t.Fatal("failed precondition", w.Code, w.Header())
		}
	}

	for _, asset := range []domain.Asset{{Size: 10, MIME: "image/png"}, {Hash: "bad", Size: 10, MIME: "image/png"}, {Hash: hash, Size: 10, MIME: "application/octet-stream"}} {
		w := httptest.NewRecorder()
		serveAsset(w, httptest.NewRequest("GET", "/v1/assets/fixture", nil), streamMediaStorage{}, asset)
		if w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("ETag") != "" {
			t.Fatal(w.Code, w.Header())
		}
	}
}

func TestMediaUnauthenticatedValidator(t *testing.T) {
	h := WebHandler(&app.Service{}, WebConfig{})
	for _, method := range []string{"GET", "HEAD"} {
		r := httptest.NewRequest(method, "/v1/assets/11111111-1111-4111-8111-111111111111", nil)
		r.Header.Set("If-None-Match", "*")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("ETag") != "" {
			t.Fatal(w.Code, w.Header())
		}
	}
}
