package httpapi

import (
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// timedWriter stamps how long the server took before the first byte, so a
// browser's network panel separates server time from time spent in transit.
type timedWriter struct {
	http.ResponseWriter
	start  time.Time
	status int
	first  time.Duration
}

func (w *timedWriter) WriteHeader(status int) {
	if w.status == 0 {
		w.status = status
		w.first = time.Since(w.start)
		w.Header().Set("Server-Timing", "app;dur="+strconv.FormatFloat(float64(w.first.Microseconds())/1000, 'f', 1, 64))
	}
	w.ResponseWriter.WriteHeader(status)
}

func (w *timedWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(p)
}

// slowRequest is when any API request is logged; the collection list is
// always logged with its parameters, since its cost depends on them.
const slowRequest = time.Second

func serverTiming(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t := &timedWriter{ResponseWriter: w, start: time.Now()}
		next.ServeHTTP(t, r)
		total := time.Since(t.start)
		if r.URL.Path == "/v1/collections" || total >= slowRequest {
			slog.InfoContext(r.Context(), "web request", "method", r.Method, "path", r.URL.Path, "query", r.URL.RawQuery, "status", t.status, "first_byte_ms", t.first.Milliseconds(), "total_ms", total.Milliseconds())
		}
	})
}
