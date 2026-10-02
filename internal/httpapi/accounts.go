package httpapi

import (
	"net/http"

	"monitor/internal/app"
)

func registerAccounts(mux *http.ServeMux, s *app.Service) {
	mux.HandleFunc("GET /v1/accounts", func(w http.ResponseWriter, r *http.Request) {
		v, e := s.Accounts(r.Context(), tenant(r))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("POST /v1/accounts", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Platform   string `json:"platform"`
			Name       string `json:"name"`
			Credential string `json:"credential"`
		}
		if !annotationBody(w, r, &in) {
			return
		}
		v, e := s.AddAccount(r.Context(), tenant(r), in.Platform, in.Name, in.Credential)
		respond(w, 201, v, e)
	})
	mux.HandleFunc("PUT /v1/accounts/selection", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Platform  string `json:"platform"`
			AccountID string `json:"account_id"`
		}
		if !annotationBody(w, r, &in) {
			return
		}
		if in.Platform == "" {
			write(w, 400, map[string]string{"error": "invalid request"})
			return
		}
		if e := s.SelectAccount(r.Context(), tenant(r), in.Platform, in.AccountID); e != nil {
			respond(w, 200, nil, e)
			return
		}
		v, e := s.Accounts(r.Context(), tenant(r))
		respond(w, 200, v, e)
	})
	mux.HandleFunc("DELETE /v1/accounts/{id}", func(w http.ResponseWriter, r *http.Request) {
		if !checkID(w, r) {
			return
		}
		if e := s.RevokeConnection(r.Context(), tenant(r), r.PathValue("id")); e != nil {
			respond(w, 200, nil, e)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
}
