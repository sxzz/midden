package httpapi

import (
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"monitor/internal/blob"
	"monitor/internal/domain"
)

const mediaCacheControl = "private, max-age=31536000, immutable"

// Cache policy is committed with the status, never before ServeContent has
// evaluated preconditions/ranges. Its error paths may remove cache headers.
type mediaResponse struct {
	http.ResponseWriter
	cacheable bool
}

func (w mediaResponse) WriteHeader(status int) {
	if w.cacheable && (status == http.StatusOK || status == http.StatusPartialContent || status == http.StatusNotModified) {
		w.Header().Set("Cache-Control", mediaCacheControl)
	} else {
		w.Header().Set("Cache-Control", "private, no-store")
		if status >= 400 {
			w.Header().Del("ETag")
		}
	}
	w.ResponseWriter.WriteHeader(status)
}

// serveAsset is reached only after authenticate, WebAccess (for browser
// sessions), and Service.Asset have checked access and resolved a ready asset.
func serveAsset(w http.ResponseWriter, r *http.Request, storage blob.Storage, a domain.Asset) {
	w.Header().Set("Cache-Control", "private, no-store")
	w.Header().Set("Content-Type", a.MIME)
	w.Header().Set("Content-Disposition", "attachment")
	if r.URL.Query().Get("inline") == "1" && (a.MIME == "image/jpeg" || a.MIME == "image/png" || a.MIME == "image/webp" || a.MIME == "video/mp4" || a.MIME == "video/webm") {
		w.Header().Set("Content-Disposition", "inline")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")

	// Ready assets bind to a content-addressed blob exactly once. Missing or
	// malformed hashes must never yield a shared validator or immutable response.
	hash, err := hex.DecodeString(a.Hash)
	cacheable := err == nil && len(hash) == 32 && (strings.HasPrefix(a.MIME, "image/") || strings.HasPrefix(a.MIME, "video/"))
	var body blob.ReadSeekCloser
	if seeker, ok := storage.(blob.Seekable); ok {
		body, err = seeker.Open(r.Context(), a.Key)
	} else {
		var stream io.ReadCloser
		stream, err = storage.Get(r.Context(), a.Key)
		if err == nil {
			body = &mediaStream{ReadCloser: stream, size: a.Size}
		}
	}
	if err != nil {
		write(w, http.StatusServiceUnavailable, map[string]string{"error": "resource temporarily unavailable"})
		return
	}
	defer body.Close()
	if cacheable {
		w.Header().Set("ETag", `"`+hex.EncodeToString(hash)+`"`)
	}
	if strings.Contains(r.Header.Get("Range"), ",") {
		// Preserve the single-range policy, but let ServeContent first evaluate
		// If-None-Match / If-Range. A stale If-Range must still return the full file.
		r = r.Clone(r.Context())
		r.Header.Set("Range", "bytes="+strconv.FormatInt(a.Size, 10)+"-")
	}
	http.ServeContent(mediaResponse{w, cacheable}, r, "", time.Time{}, body)
}

// mediaStream adapts a forward-only storage stream to ServeContent's size probe
// and single-range seek. Range prefixes are discarded before headers are sent;
// the file is neither buffered in memory nor copied to a temporary file.
type mediaStream struct {
	io.ReadCloser
	size, offset int64
}

func (s *mediaStream) Read(p []byte) (int, error) {
	n, err := s.ReadCloser.Read(p)
	s.offset += int64(n)
	return n, err
}

func (s *mediaStream) Seek(offset int64, whence int) (int64, error) {
	if whence == io.SeekEnd && offset == 0 {
		return s.size, nil
	}
	if whence != io.SeekStart || offset < s.offset || offset > s.size {
		return 0, errors.New("unsupported media seek")
	}
	if offset > s.offset {
		n, err := io.CopyN(io.Discard, s.ReadCloser, offset-s.offset)
		s.offset += n
		if err != nil {
			return s.offset, err
		}
	}
	return s.offset, nil
}
