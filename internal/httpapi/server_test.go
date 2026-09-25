package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/riverqueue/river"
	"github.com/riverqueue/river/riverdriver/riverpgxv5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/app"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func TestRESTIsolation(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, e := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	defer admin.Close()
	db, e := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	q, e := river.NewClient(riverpgxv5.New(db.Pool), &river.Config{})
	if e != nil {
		t.Fatal(e)
	}
	s := &app.Service{DB: db, Queue: q, Providers: []*pb.Provider{{Id: "fxtwitter", Authentication: "none", Visibility: pb.Visibility_VISIBILITY_PRIVATE}}, Config: app.Defaults()}
	h := Handler(s)
	makeToken := func() string {
		var tenant string
		if e = admin.Pool.QueryRow(ctx, `INSERT INTO tenants DEFAULT VALUES RETURNING id`).Scan(&tenant); e != nil {
			t.Fatal(e)
		}
		token := uuid.NewString()
		if _, e = admin.Pool.Exec(ctx, `INSERT INTO tokens(tenant_id,digest) VALUES($1,$2)`, tenant, store.Hash(token)); e != nil {
			t.Fatal(e)
		}
		return token
	}
	a, b := makeToken(), makeToken()
	call := func(method, path, body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Idempotency-Key", "same-key")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	w := call("POST", "/v1/captures", `{"url":"https://x.com/u/status/99"}`, a)
	if w.Code != 202 {
		t.Fatal(w.Code, w.Body.String())
	}
	var job domain.Job
	json.Unmarshal(w.Body.Bytes(), &job)
	for _, path := range []string{"/v1/jobs/" + job.ID, "/v1/archives/" + job.ArchiveID} {
		if w = call("GET", path, "", b); w.Code != 404 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if w = call("GET", "/v1/jobs/"+job.ID, "", a); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if w = call("POST", "/v1/captures", `{"url":"https://x.com/u/status/100"}`, a); w.Code != 409 {
		t.Fatal(w.Code)
	}
	if w = call("POST", "/v1/captures", `{"url":"https://x.com/u/status/99","tenant_id":"other"}`, a); w.Code != 400 {
		t.Fatal(w.Code)
	}
	if w = call("GET", "/v1/usage", "", "wrong"); w.Code != http.StatusUnauthorized {
		t.Fatal(w.Code)
	}
	if w = call("DELETE", "/v1/archives/"+job.ArchiveID, "", b); w.Code != 404 {
		t.Fatal("foreign collection deletion", w.Code)
	}
	if w = call("DELETE", "/v1/archives/"+job.ArchiveID, "", a); w.Code != 204 {
		t.Fatal("collection deletion", w.Code, w.Body.String())
	}
	if w = call("DELETE", "/v1/archives/"+job.ArchiveID, "", a); w.Code != 404 {
		t.Fatal("repeated deletion", w.Code)
	}
}
