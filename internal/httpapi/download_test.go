package httpapi

import (
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"monitor/internal/domain"
)

func TestDownloadGrant(t *testing.T) {
	now := time.Now()
	g := downloadGrant{uuid.NewString(), uuid.NewString(), now.Add(5 * time.Minute).Unix()}
	token := signDownload(g, "secret")
	if got, ok := verifyDownload(token, "secret", now); !ok || got != g {
		t.Fatal(got, ok)
	}
	for _, tc := range []struct {
		token, secret string
		now           time.Time
	}{
		{token, "other", now},
		{token, "", now},
		{token + "x", "secret", now},
		{token, "secret", now.Add(5 * time.Minute)},
		{signDownload(downloadGrant{g.Tenant, "invalid", g.Expires}, "secret"), "secret", now},
	} {
		if _, ok := verifyDownload(tc.token, tc.secret, tc.now); ok {
			t.Fatal("accepted invalid grant")
		}
	}
}

func TestDownloadHeaders(t *testing.T) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/download", nil)
	serveAsset(downloadResponse{w, "image.png"}, r, streamMediaStorage{}, domain.Asset{MIME: "image/png", Size: 10})
	if w.Code != 200 || w.Header().Get("Content-Disposition") != "attachment; filename=image.png" || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatal(w.Code, w.Header())
	}
}
