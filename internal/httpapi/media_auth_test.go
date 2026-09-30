package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/google/uuid"

	"monitor/internal/app"
	"monitor/internal/store"
)

func TestMediaCacheAuthorization(t *testing.T) {
	if os.Getenv("TEST_DATABASE_URL") == "" {
		t.Skip("Docker database required")
	}
	ctx := context.Background()
	admin, err := store.Open(ctx, os.Getenv("TEST_ADMIN_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer admin.Close()
	db, err := store.Open(ctx, os.Getenv("TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	tenant, other, collection, capture, revision, asset, blobID := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	sum := sha256.Sum256([]byte("0123456789"))
	hash := hex.EncodeToString(sum[:])
	etag := `"` + hash + `"`
	exec := func(sql string, args ...any) {
		t.Helper()
		if _, err := admin.Pool.Exec(ctx, sql, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO tenants(id) VALUES($1),($2)`, tenant, other)
	exec(`INSERT INTO collections(id,tenant_id,visibility,platform,kind,external_id,url,provider_id) VALUES($1,$2,'public','fixture','post',$1::uuid::text,'https://example.test/post','fixture')`, collection, tenant)
	exec(`INSERT INTO captures(id,tenant_id,visibility,collection_id,provider_id,scope,adapter_id,state) VALUES($1,$2,'public',$3,'fixture','public','fixture','complete')`, capture, tenant, collection)
	exec(`INSERT INTO revisions(id,tenant_id,visibility,collection_id,capture_id,content_hash,payload,content_bytes) VALUES($1,$2,'public',$3,$4,'fixture','{}',2)`, revision, tenant, collection, capture)
	exec(`UPDATE collections SET current_revision=$2 WHERE id=$1`, collection, revision)
	exec(`INSERT INTO blobs(id,tenant_id,visibility,hash,object_key,size,mime) VALUES($1,$2,'public',$3,$1::uuid::text,10,'image/png')`, blobID, tenant, hash)
	exec(`INSERT INTO assets(id,tenant_id,visibility,capture_id,position,source_url,kind,state,blob_id) VALUES($1,$2,'public',$3,0,'https://example.test/image','image','ready',$4)`, asset, tenant, capture, blobID)
	exec(`INSERT INTO tenant_collections(tenant_id,collection_id,provider_id,adapter_id) VALUES($1,$2,'fixture','fixture')`, tenant, collection)
	session, foreign, expired := uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO web_sessions(digest,tenant_id) VALUES($1,$2),($3,$4)`, store.Hash(session), tenant, store.Hash(foreign), other)
	exec(`INSERT INTO web_sessions(digest,tenant_id,expires_at) VALUES($1,$2,now()-interval '1 second')`, store.Hash(expired), tenant)
	h := WebHandler(&app.Service{DB: db, Blobs: streamMediaStorage{}, Config: app.Defaults()}, WebConfig{URL: "https://collection.test/app/", Token: "test-secret"})
	call := func(method, path, credential, origin, validator string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		if credential != "" {
			r.AddCookie(&http.Cookie{Name: sessionCookie, Value: credential})
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		r.Header.Set("If-None-Match", validator)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	path := "/v1/assets/" + asset + "?inline=1"
	for _, tc := range []struct {
		name, session, method, origin, validator string
		status                                   int
	}{
		{name: "success", session: session, method: "GET", status: 200},
		{name: "authorized-304", session: session, method: "GET", validator: etag, status: 304},
		{name: "authorized-head-304", session: session, method: "HEAD", validator: etag, status: 304},
		{name: "anonymous", method: "GET", validator: etag, status: 401},
		{name: "expired", session: expired, method: "GET", validator: etag, status: 401},
		{name: "invalid", session: "invalid", method: "GET", validator: "*", status: 401},
		{name: "unsaved-public-asset", session: foreign, method: "GET", validator: etag, status: 404},
		{name: "forbidden-origin", session: session, method: "POST", origin: "https://evil.test", validator: etag, status: 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := call(tc.method, path, tc.session, tc.origin, tc.validator)
			if w.Code != tc.status {
				t.Fatal(w.Code, w.Body.String())
			}
			if tc.status < 400 {
				if w.Header().Get("Cache-Control") != mediaCacheControl || w.Header().Get("ETag") != etag {
					t.Fatal(w.Header())
				}
			} else if !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("ETag") != "" {
				t.Fatal(w.Header())
			}
		})
	}
	for _, path := range []string{"/v1/session", "/v1/collections?q=", "/v1/usage"} {
		w := call("GET", path, session, "", etag)
		if w.Code != 200 || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") || w.Header().Get("ETag") != "" {
			t.Fatal(path, w.Code, w.Header(), w.Body.String())
		}
	}
	grantResponse := call("POST", "/v1/assets/"+asset+"/download", session, "https://collection.test", "")
	var download struct {
		URL string `json:"url"`
	}
	if grantResponse.Code != 200 || json.Unmarshal(grantResponse.Body.Bytes(), &download) != nil || download.URL == "" {
		t.Fatal(grantResponse.Code, grantResponse.Body.String())
	}
	for _, credential := range []string{"", foreign} {
		w := call("POST", "/v1/assets/"+asset+"/download", credential, "https://collection.test", "")
		if w.Code < 400 {
			t.Fatal("unauthorized grant", w.Code)
		}
	}
	wDownload := call("GET", download.URL, "", "", "")
	if wDownload.Code != 200 || wDownload.Body.String() != "0123456789" || wDownload.Header().Get("Access-Control-Allow-Origin") != "https://web.telegram.org" || !strings.Contains(wDownload.Header().Get("Content-Disposition"), asset+".png") {
		t.Fatal(wDownload.Code, wDownload.Header(), wDownload.Body.String())
	}
	exec(`DELETE FROM tenant_collections WHERE tenant_id=$1 AND collection_id=$2`, tenant, collection)
	wDownload = call("GET", download.URL, "", "", "")
	if wDownload.Code != 404 {
		t.Fatal("deleted grant still works", wDownload.Code)
	}
	w := call("GET", path, session, "", etag)
	if w.Code != 404 || !strings.Contains(w.Header().Get("Cache-Control"), "no-store") {
		t.Fatal("deleted collection", w.Code, w.Header())
	}
}
