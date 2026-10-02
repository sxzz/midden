package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServerTiming(t *testing.T) {
	for _, h := range []http.HandlerFunc{
		func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte("ok")) },
		func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) },
	} {
		w := httptest.NewRecorder()
		serverTiming(h).ServeHTTP(w, httptest.NewRequest("GET", "/v1/collections?sort=published", nil))
		if !strings.HasPrefix(w.Header().Get("Server-Timing"), "app;dur=") {
			t.Fatal(w.Code, w.Header())
		}
	}
}
