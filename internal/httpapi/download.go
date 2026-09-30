package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"mime"
	"net/http"
	"strings"
	"time"

	"monitor/internal/app"
)

// Download grants authorize a single saved asset for five minutes. Telegram's
// native downloader does not carry the Mini App's session cookie.
type downloadGrant struct {
	Tenant  string `json:"tenant"`
	Asset   string `json:"asset"`
	Expires int64  `json:"expires"`
}

func signDownload(g downloadGrant, secret string) string {
	raw, _ := json.Marshal(g)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("midden-download:" + payload))
	return payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func verifyDownload(token, secret string, now time.Time) (downloadGrant, bool) {
	var g downloadGrant
	payload, signature, ok := strings.Cut(token, ".")
	if !ok || secret == "" || len(token) > 2048 {
		return g, false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("midden-download:" + payload))
	sig, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return g, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil || json.Unmarshal(raw, &g) != nil {
		return g, false
	}
	return g, valid(g.Tenant) && valid(g.Asset) && g.Expires > now.Unix() && g.Expires <= now.Add(5*time.Minute).Unix()
}

func downloadFilename(id, contentType string) string {
	extensions := map[string]string{"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif", "video/mp4": ".mp4", "video/webm": ".webm"}
	return id + extensions[contentType]
}

func registerDownloads(root, secured *http.ServeMux, s *app.Service, web WebConfig) {
	secured.HandleFunc("POST /v1/assets/{id}/download", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		if web.URL == "" || web.Token == "" {
			http.NotFound(w, r)
			return
		}
		id := r.PathValue("id")
		if err := s.WebAccess(r.Context(), tenant(r), "assets", id); err != nil {
			respond(w, 200, nil, err)
			return
		}
		a, err := s.Asset(r.Context(), tenant(r), id)
		if err != nil {
			respond(w, 200, nil, err)
			return
		}
		grant := signDownload(downloadGrant{tenant(r), id, time.Now().Add(5 * time.Minute).Unix()}, web.Token)
		write(w, 200, map[string]string{"url": webOrigin(web) + "/v1/downloads/" + grant, "file_name": downloadFilename(id, a.MIME)})
	})
	root.HandleFunc("GET /v1/downloads/{grant}", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "private, no-store")
		w.Header().Set("Referrer-Policy", "no-referrer")
		g, ok := verifyDownload(r.PathValue("grant"), web.Token, time.Now())
		if !ok || web.URL == "" {
			http.NotFound(w, r)
			return
		}
		// Recheck membership so deleting a saved collection revokes its grants.
		if err := s.WebAccess(r.Context(), g.Tenant, "assets", g.Asset); err != nil {
			respond(w, 200, nil, err)
			return
		}
		a, err := s.Asset(r.Context(), g.Tenant, g.Asset)
		if err != nil {
			respond(w, 200, nil, err)
			return
		}
		r.URL.RawQuery = ""
		a.Hash = "" // Short-lived grants must never produce immutable cache responses.
		w.Header().Set("Access-Control-Allow-Origin", "https://web.telegram.org")
		serveAsset(downloadResponse{w, downloadFilename(g.Asset, a.MIME)}, r, s.Blobs, a)
	})
}

type downloadResponse struct {
	http.ResponseWriter
	filename string
}

func (w downloadResponse) WriteHeader(status int) {
	if status < 400 {
		w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": w.filename}))
	}
	w.ResponseWriter.WriteHeader(status)
}
