package httpapi

import (
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"monitor/internal/blob"
	"monitor/internal/domain"
)

func serveAsset(w http.ResponseWriter, r *http.Request, storage blob.Storage, a domain.Asset) {
	w.Header().Set("Content-Type", a.MIME)
	w.Header().Set("Content-Disposition", "attachment")
	if r.URL.Query().Get("inline") == "1" && (a.MIME == "image/jpeg" || a.MIME == "image/png" || a.MIME == "image/webp" || a.MIME == "video/mp4" || a.MIME == "video/webm") {
		w.Header().Set("Content-Disposition", "inline")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-store")
	if strings.Contains(r.Header.Get("Range"), ",") {
		w.Header().Set("Content-Range", "bytes */"+strconv.FormatInt(a.Size, 10))
		w.WriteHeader(416)
		return
	}
	if seeker, ok := storage.(blob.Seekable); ok {
		body, e := seeker.Open(r.Context(), a.Key)
		if e != nil {
			write(w, 503, map[string]string{"error": "resource temporarily unavailable"})
			return
		}
		defer body.Close()
		http.ServeContent(w, r, "", time.Time{}, body)
		return
	}
	body, e := storage.Get(r.Context(), a.Key)
	if e != nil {
		write(w, 503, map[string]string{"error": "resource temporarily unavailable"})
		return
	}
	defer body.Close()
	w.Header().Set("Content-Length", strconv.FormatInt(a.Size, 10))
	if r.Method != "HEAD" {
		io.Copy(w, body)
	}
}
