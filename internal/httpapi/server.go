package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/jackc/pgx/v5"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"monitor/internal/store"

	"github.com/google/uuid"

	"monitor/internal/app"
	"monitor/internal/domain"
)

type key struct{}

func Handler(s *app.Service) http.Handler { return WebHandler(s, WebConfig{}) }

func WebHandler(s *app.Service, web WebConfig) http.Handler {
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
			if e := domain.ValidateURL(in.URL); e != nil {
				write(w, 400, map[string]string{"error": "unsupported URL"})
				return
			}
		}
		if _, ok := r.Context().Value(sessionKey{}).(bool); ok {
			if in.RefreshID == "" {
				write(w, 400, map[string]string{"error": "save links through the bot"})
				return
			}
			if e := s.WebAccess(r.Context(), tenant(r), "collections", in.RefreshID); e != nil {
				respond(w, 200, nil, e)
				return
			}
		}
		in.Key = r.Header.Get("Idempotency-Key")
		if in.RefreshID != "" {
			available, err := s.CaptureAvailable(r.Context(), tenant(r), in.RefreshID)
			if err != nil {
				respond(w, 200, nil, err)
				return
			}
			if !available {
				respond(w, 200, nil, app.ErrAdapterUnavailable)
				return
			}
		}
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
	mux.HandleFunc("GET /v1/collections", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if _, ok := r.Context().Value(sessionKey{}).(bool); ok || q.Has("q") || q.Has("entity_type") || q.Has("media_type") || q.Has("visibility") || q.Has("saved_from") || q.Has("saved_before") || q.Has("sort") || q.Has("order") {
			v, e := s.Collections(r.Context(), tenant(r), app.CollectionFilter{EntityType: q.Get("entity_type"), Q: q.Get("q"), Media: q.Get("media_type"), Visibility: q.Get("visibility"), From: q.Get("saved_from"), Before: q.Get("saved_before"), Sort: q.Get("sort"), Order: q.Get("order")}, q.Get("cursor"))
			respond(w, 200, v, e)
			return
		}
		v, e := s.Recent(r.Context(), tenant(r), q.Get("cursor"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/entities/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.Entity(r.Context(), tenant(r), r.PathValue("id"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/collections/{id}/sources", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.Sources(r.Context(), tenant(r), r.PathValue("id"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/sources/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.Source(r.Context(), tenant(r), r.PathValue("id"))
		if e != nil {
			respond(w, 200, nil, e)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Write(v.Body)
	})
	mux.HandleFunc("GET /v1/collections/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		if _, ok := r.Context().Value(sessionKey{}).(bool); ok {
			v, e := s.SavedCollection(r.Context(), tenant(r), r.PathValue("id"))
			respond(w, 200, v, e)
			return
		}
		v, e := s.Collection(r.Context(), tenant(r), r.PathValue("id"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("DELETE /v1/collections/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		if e := s.DeleteCollection(r.Context(), tenant(r), r.PathValue("id")); e != nil {
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

		serveAsset(w, r, s.Blobs, a)
	})

	mux.HandleFunc("GET /v1/session", func(w http.ResponseWriter, r *http.Request) { write(w, 200, map[string]string{"tenant_id": tenant(r)}) })
	mux.HandleFunc("DELETE /v1/session", func(w http.ResponseWriter, r *http.Request) {
		if c, e := r.Cookie(sessionCookie); e == nil {
			err := s.DB.Tx(r.Context(), tenant(r), func(tx pgx.Tx) error {
				_, e := tx.Exec(r.Context(), `DELETE FROM web_sessions WHERE digest=$1`, store.Hash(c.Value))
				return e
			})
			if err != nil {
				respond(w, 200, nil, err)
				return
			}
		}
		cookie(w, "", -1)
		w.WriteHeader(204)
	})
	mux.HandleFunc("GET /v1/collections/{id}/revisions", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.Revisions(r.Context(), tenant(r), r.PathValue("id"), r.URL.Query().Get("cursor"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/collections/{id}/revisions/{revision}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		if !valid(r.PathValue("revision")) {
			http.NotFound(w, r)
			return
		}
		v, e := s.Revision(r.Context(), tenant(r), r.PathValue("id"), r.PathValue("revision"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/collections/{id}/availability", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.CaptureAvailable(r.Context(), tenant(r), r.PathValue("id"))
		respond(w, 200, map[string]bool{"available": v}, e)
	})
	secured := authenticate(s, web, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := r.Context().Value(sessionKey{}).(bool); ok {
			parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
			if len(parts) >= 3 && (parts[1] == "collections" || parts[1] == "assets" || parts[1] == "entities") {
				if !valid(parts[2]) {
					http.NotFound(w, r)
					return
				}
				if e := s.WebAccess(r.Context(), tenant(r), parts[1], parts[2]); e != nil {
					respond(w, 200, nil, e)
					return
				}
			}
			if len(parts) >= 2 && parts[1] == "sources" {
				http.NotFound(w, r)
				return
			}
		}
		mux.ServeHTTP(w, r)
	}))
	root := http.NewServeMux()
	root.Handle("/v1/", secured)
	registerDownloads(root, mux, s, web)
	root.HandleFunc("GET /app/", func(w http.ResponseWriter, r *http.Request) {
		dir := os.Getenv("WEB_DIST")
		if dir == "" {
			dir = "web/dist"
		}
		name := strings.TrimPrefix(r.URL.Path, "/app/")
		if name == "" {
			name = "index.html"
		}
		if name != filepath.Base(name) && !strings.HasPrefix(name, "assets/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self' https://web.telegram.org")
		http.ServeFile(w, r, filepath.Join(dir, filepath.Clean("/"+name)))
	})
	return root
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
	case errors.Is(e, app.ErrAdapterUnavailable), status.Code(e) == codes.Unavailable, status.Code(e) == codes.DeadlineExceeded:
		code = 503
		msg = "adapter temporarily unavailable"
	case errors.Is(e, app.ErrInvalidFilter):
		code = 400
		msg = "invalid collection filters"
	case errors.Is(e, domain.ErrInvalidTarget):
		code = 400
		msg = "unsupported URL"
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
	case errors.Is(e, app.ErrConnection):
		code = 422
		msg = "account unavailable; select a public source or authorize again"
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
