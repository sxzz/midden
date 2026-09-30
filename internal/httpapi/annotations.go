package httpapi

import (
	"encoding/json"
	"io"
	"net/http"

	"monitor/internal/app"
)

func annotationBody(w http.ResponseWriter, r *http.Request, v any) bool {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 128<<10))
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

func registerAnnotations(mux *http.ServeMux, s *app.Service) {
	mux.HandleFunc("GET /v1/tags", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Tags(r.Context(), tenant(r))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("GET /v1/collections/{id}/annotation", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		v, e := s.Annotation(r.Context(), tenant(r), r.PathValue("id"))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("PATCH /v1/collections/{id}/annotation", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		var in app.AnnotationUpdate
		if !annotationBody(w, r, &in) {
			return
		}
		v, e := s.UpdateAnnotation(r.Context(), tenant(r), r.PathValue("id"), in)
		respond(w, 200, v, e)
	})
}
