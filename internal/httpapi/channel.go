package httpapi

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"monitor/internal/app"
	"monitor/internal/channelapi"
)

// ChannelHandler must only be mounted on the dedicated internal listener.
// Service authentication is intentionally absent; public routes do not expose it.
func ChannelHandler(s *app.Service) http.Handler {
	mux := http.NewServeMux()
	const base = "/internal/v1/channels/{channel}"
	decode := func(w http.ResponseWriter, r *http.Request, v any) bool {
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
		d.DisallowUnknownFields()
		if d.Decode(v) != nil {
			write(w, 400, map[string]string{"error": "invalid request"})
			return false
		}
		var extra any
		if d.Decode(&extra) != io.EOF {
			write(w, 400, map[string]string{"error": "invalid request"})
			return false
		}
		return true
	}
	mux.HandleFunc("GET "+base+"/config", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.ChannelConfig(r.Context(), r.PathValue("channel"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("POST "+base+"/events", func(w http.ResponseWriter, r *http.Request) {
		var in channelapi.Event
		if !decode(w, r, &in) {
			return
		}
		secret, e := s.ChannelEvent(r.Context(), r.PathValue("channel"), in)
		respond(w, 200, map[string]bool{"delete_input": secret}, e)
	})
	mux.HandleFunc("POST "+base+"/work/claim", func(w http.ResponseWriter, r *http.Request) {
		deadline := time.NewTimer(20 * time.Second)
		defer deadline.Stop()
		for {
			v, e := s.ClaimChannel(r.Context(), r.PathValue("channel"))
			if e != nil || v != nil {
				respond(w, 200, v, e)
				return
			}
			timer := time.NewTimer(500 * time.Millisecond)
			select {
			case <-r.Context().Done():
				timer.Stop()
				return
			case <-deadline.C:
				timer.Stop()
				w.WriteHeader(204)
				return
			case <-timer.C:
			}
		}
	})
	mux.HandleFunc("POST "+base+"/work/{id}/ack", func(w http.ResponseWriter, r *http.Request) {
		var in channelapi.Ack
		if !decode(w, r, &in) {
			return
		}
		e := s.AckChannel(r.Context(), r.PathValue("channel"), r.PathValue("id"), in)
		respond(w, 200, map[string]bool{"ok": e == nil}, e)
	})
	mux.HandleFunc("GET "+base+"/work/{id}/delivery", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.ChannelDelivery(r.Context(), r.PathValue("channel"), r.PathValue("id"), r.Header.Get("X-Work-Lease"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("POST "+base+"/work/{id}/normalize", func(w http.ResponseWriter, r *http.Request) {
		var in channelapi.Event
		if !decode(w, r, &in) {
			return
		}
		v, e := s.NormalizeChannel(r.Context(), r.PathValue("channel"), r.PathValue("id"), r.Header.Get("X-Work-Lease"), in)
		respond(w, 200, v, e)
	})

	mux.HandleFunc("POST "+base+"/actions", func(w http.ResponseWriter, r *http.Request) {
		var in channelapi.Action
		if !decode(w, r, &in) {
			return
		}
		v, e := s.ChannelAction(r.Context(), r.PathValue("channel"), in)
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET "+base+"/work/{id}/assets/{asset}", func(w http.ResponseWriter, r *http.Request) {
		tenant, _, e := s.ChannelWork(r.Context(), r.PathValue("channel"), r.PathValue("id"), r.Header.Get("X-Work-Lease"))
		if e != nil {
			respond(w, 200, nil, e)
			return
		}
		if e = s.WebAccess(r.Context(), tenant, "assets", r.PathValue("asset")); e != nil {
			respond(w, 200, nil, e)
			return
		}
		asset, e := s.Asset(r.Context(), tenant, r.PathValue("asset"))
		if e != nil {
			respond(w, 200, nil, e)
			return
		}
		serveAsset(w, r, s.Blobs, asset)
	})
	// Bot-specific file references remain in core, reached through HTTP.
	mux.HandleFunc(base+"/media-cache", func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		cfg, e := s.ChannelConfig(r.Context(), r.PathValue("channel"))
		if e != nil {
			respond(w, 200, nil, e)
			return
		}
		a, b := q.Get("blob"), q.Get("kind")
		switch r.Method {
		case "GET":
			v, e := s.DB.GetChannelMedia(r.Context(), "telegram", cfg.BotID, a, b)
			respond(w, 200, map[string]string{"file_id": v}, e)
		case "PUT", "DELETE":
			var in struct {
				FileID string `json:"file_id"`
			}
			if !decode(w, r, &in) {
				return
			}
			if r.Method == "PUT" {
				e = s.DB.PutChannelMedia(r.Context(), "telegram", cfg.BotID, a, b, in.FileID)
			} else {
				e = s.DB.DeleteChannelMedia(r.Context(), "telegram", cfg.BotID, a, b, in.FileID)
			}
			respond(w, 200, map[string]bool{"ok": e == nil}, e)
		default:
			w.WriteHeader(405)
		}
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		// Browser origins are not channel clients. No CORS is enabled here.
		if r.Header.Get("Origin") != "" {
			write(w, 403, map[string]string{"error": "channel endpoint"})
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 4 || parts[0] != "internal" || parts[1] != "v1" || parts[2] != "channels" || !valid(parts[3]) {
			http.NotFound(w, r)
			return
		}
		if _, e := s.ChannelConfig(r.Context(), parts[3]); e != nil {
			http.NotFound(w, r)
			return
		}
		mux.ServeHTTP(w, r)
	})
}
