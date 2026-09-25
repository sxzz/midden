package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"monitor/internal/app"
	"monitor/internal/domain"
)

type key struct{}

func Handler(s *app.Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/captures", func(w http.ResponseWriter, r *http.Request) {
		var in domain.CaptureInput
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		d.DisallowUnknownFields()
		if d.Decode(&in) != nil {
			write(w, 400, map[string]string{"error": "invalid request"})
			return
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			write(w, 400, map[string]string{"error": "invalid request"})
			return
		}
		if in.RefreshID != "" && !valid(in.RefreshID) || in.ConnectionID != "" && !valid(in.ConnectionID) {
			write(w, 400, map[string]string{"error": "invalid identifier"})
			return
		}
		if in.RefreshID == "" {
			if _, e := domain.Normalize(in.URL); e != nil {
				write(w, 400, map[string]string{"error": "unsupported URL"})
				return
			}
		}
		in.Key = r.Header.Get("Idempotency-Key")
		j, e := s.Submit(r.Context(), tenant(r), in)
		respond(w, 202, j, e)
	})
	mux.HandleFunc("GET /v1/jobs/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.Job(r.Context(), tenant(r), r.PathValue("id"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/archives", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Recent(r.Context(), tenant(r), r.URL.Query().Get("cursor"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/archives/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.Archive(r.Context(), tenant(r), r.PathValue("id"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("DELETE /v1/archives/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		if e := s.Forget(r.Context(), tenant(r), r.PathValue("id")); e != nil {
			respond(w, 200, nil, e)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("GET /v1/usage", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Usage(r.Context(), tenant(r))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/assets/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		a, e := s.Asset(r.Context(), tenant(r), r.PathValue("id"))
		if e != nil {
			respond(w, 200, nil, e)
			return
		}
		body, e := s.Blobs.Get(r.Context(), a.Key)
		if e != nil {
			write(w, 503, map[string]string{"error": "resource temporarily unavailable"})
			return
		}
		defer body.Close()
		w.Header().Set("Content-Type", a.MIME)
		w.Header().Set("Content-Disposition", "attachment")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Cache-Control", "private, no-store")
		io.Copy(w, body)
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		v := r.Header.Get("Authorization")
		if !strings.HasPrefix(v, "Bearer ") {
			write(w, 401, map[string]string{"error": "authentication required"})
			return
		}
		t, e := s.DB.Authenticate(r.Context(), strings.TrimPrefix(v, "Bearer "))
		if e != nil {
			write(w, 401, map[string]string{"error": "invalid token"})
			return
		}
		mux.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), key{}, t)))
	})
}

func tenant(r *http.Request) string { return r.Context().Value(key{}).(string) }
func valid(s string) bool           { _, e := uuid.Parse(s); return e == nil }
func checkID(w http.ResponseWriter, r *http.Request) bool {
	if !valid(r.PathValue("id")) {
		write(w, 404, map[string]string{"error": "not found"})
		return false
	}
	return true
}

func respond(w http.ResponseWriter, code int, v any, e error) {
	if e == nil {
		write(w, code, v)
		return
	}
	msg := "internal error"
	code = 500
	switch {
	case errors.Is(e, domain.ErrNotFound):
		code = 404
		msg = "not found"
	case errors.Is(e, domain.ErrQuota):
		code = 409
		msg = "storage quota exceeded"
	case errors.Is(e, domain.ErrRate):
		code = 429
		msg = "capture rate exceeded"
		w.Header().Set("Retry-After", "60")
	case errors.Is(e, domain.ErrUnsupported):
		code = 422
		msg = e.Error()
	case errors.Is(e, domain.ErrConflict):
		code = 409
		msg = e.Error()
	case e.Error() == "invalid cursor" || e.Error() == "idempotency key too long":
		code = 400
		msg = e.Error()
	}
	write(w, code, map[string]string{"error": msg})
}

func write(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}
