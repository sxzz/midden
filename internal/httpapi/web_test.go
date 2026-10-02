package httpapi

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"monitor/internal/app"
	"monitor/internal/blob"
	"monitor/internal/domain"
	"monitor/internal/store"
)

func signedData(token string, at int64) string {
	v := url.Values{"auth_date": {strconv.FormatInt(at, 10)}, "user": {`{"id":9007199254740991}`}, "query_id": {"fixture"}}
	keys := []string{}
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		parts = append(parts, k+"="+v.Get(k))
	}
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	secret.Write([]byte(token))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	mac.Write([]byte(strings.Join(parts, "\n")))
	v.Set("hash", hex.EncodeToString(mac.Sum(nil)))
	return v.Encode()
}

func TestTelegramLoginValidation(t *testing.T) {
	now := time.Unix(1800000000, 0)
	token := "123:test"
	raw := signedData(token, now.Unix())
	user, e := telegramUser(raw, token, now)
	if e != nil || user != "9007199254740991" {
		t.Fatal(user, e)
	}
	for _, bad := range []string{raw + "&user=%7B%7D", signedData(token, now.Unix()-301), signedData(token, now.Unix()+31), signedData("other", now.Unix()), raw + "%"} {
		if _, e = telegramUser(bad, token, now); e == nil {
			t.Fatal("accepted invalid initData")
		}
	}
}

// widgetData signs a Login Widget user object the way Telegram does.
func widgetData(token string, at int64) map[string]any {
	v := map[string]any{"id": int64(9007199254740991), "first_name": "测试", "username": "fixture", "auth_date": at}
	keys := []string{}
	for k := range v {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := []string{}
	for _, k := range keys {
		parts = append(parts, k+"="+strings.Trim(fmt.Sprint(v[k]), " "))
	}
	secret := sha256.Sum256([]byte(token))
	mac := hmac.New(sha256.New, secret[:])
	mac.Write([]byte(strings.Join(parts, "\n")))
	v["hash"] = hex.EncodeToString(mac.Sum(nil))
	return v
}

func decodeWidget(t *testing.T, v map[string]any) map[string]json.RawMessage {
	t.Helper()
	raw, _ := json.Marshal(v)
	var out map[string]json.RawMessage
	if e := json.Unmarshal(raw, &out); e != nil {
		t.Fatal(e)
	}
	return out
}

func TestTelegramWidgetValidation(t *testing.T) {
	now := time.Unix(1800000000, 0)
	token := "123:test"
	user, e := widgetUser(decodeWidget(t, widgetData(token, now.Unix())), token, now)
	if e != nil || user != "9007199254740991" {
		t.Fatal(user, e)
	}
	// An earlier authorization from the same browser is still accepted.
	if _, e = widgetUser(decodeWidget(t, widgetData(token, now.Add(-23*time.Hour).Unix())), token, now); e != nil {
		t.Fatal(e)
	}
	tampered := widgetData(token, now.Unix())
	tampered["id"] = 1
	initDataSecret := widgetData(token, now.Unix())
	initDataSecret["hash"] = "00"
	for _, bad := range []map[string]any{
		tampered,
		initDataSecret,
		widgetData(token, now.Add(-25*time.Hour).Unix()),
		widgetData(token, now.Unix()+31),
		widgetData("other", now.Unix()),
	} {
		if _, e = widgetUser(decodeWidget(t, bad), token, now); e == nil {
			t.Fatal("accepted invalid widget data", bad)
		}
	}
}

func TestWebConfig(t *testing.T) {
	for _, address := range []string{"http://example.test/app/", "https://u:p@example.test/app/", "https://example.test/app/?foo=bar"} {
		if ValidateWebConfig(WebConfig{address, "token", "channel"}) == nil {
			t.Fatal(address)
		}
	}
	if e := ValidateWebConfig(WebConfig{"https://example.test/app/", "token", "channel"}); e != nil {
		t.Fatal(e)
	}
}

type seekReader struct{ *bytes.Reader }

func (seekReader) Close() error { return nil }

type mediaStorage struct{ blob.Storage }

func (mediaStorage) Open(context.Context, string) (blob.ReadSeekCloser, error) {
	return seekReader{bytes.NewReader([]byte("0123456789"))}, nil
}

func TestMediaRanges(t *testing.T) {
	for _, tc := range []struct {
		method, rangeHeader string
		code                int
		body, contentRange  string
	}{{"GET", "bytes=2-5", 206, "2345", "bytes 2-5/10"}, {"GET", "bytes=-3", 206, "789", "bytes 7-9/10"}, {"GET", "bytes=99-", 416, "", "bytes */10"}, {"GET", "bytes=0-1,3-4", 416, "", "bytes */10"}, {"HEAD", "", 200, "", ""}} {
		t.Run(tc.method+tc.rangeHeader, func(t *testing.T) {
			r := httptest.NewRequest(tc.method, "/v1/assets/fixture?inline=1", nil)
			r.Header.Set("Range", tc.rangeHeader)
			w := httptest.NewRecorder()
			serveAsset(w, r, mediaStorage{}, domain.Asset{MIME: "video/mp4", Size: 10})
			if w.Code != tc.code || w.Header().Get("Content-Range") != tc.contentRange {
				t.Fatal(w.Code, w.Header())
			}
			if tc.code != 416 && w.Body.String() != tc.body {
				t.Fatal(w.Body.String())
			}
		})
	}
}

func TestWebSessions(t *testing.T) {
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
	channel := uuid.NewString()
	if _, e = admin.Pool.Exec(ctx, `INSERT INTO channels(id,kind,external_id) VALUES($1,'telegram',$2)`, channel, channel); e != nil {
		t.Fatal(e)
	}
	s := &app.Service{DB: db, Config: app.Defaults()}
	c := WebConfig{"https://collection.test/app/", "123:test", channel}
	h := WebHandler(s, c)
	call := func(method, path, body, origin string, cookie *http.Cookie) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		if cookie != nil {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	raw, _ := json.Marshal(map[string]string{"init_data": signedData(c.Token, time.Now().Unix())})
	w := call("POST", "/v1/auth/telegram", string(raw), "https://collection.test", nil)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || !cookies[0].HttpOnly || !cookies[0].Secure {
		t.Fatal(cookies)
	}
	ck := cookies[0]
	var session map[string]string
	json.Unmarshal(w.Body.Bytes(), &session)
	identity, e := db.Resolve(ctx, channel, "9007199254740991", s.Config.Quota)
	if e != nil || identity.TenantID != session["tenant_id"] {
		t.Fatal(identity, e)
	}
	for _, path := range []string{"/v1/session", "/v1/collections?q=中文", "/v1/collections/authors", "/v1/usage"} {
		w = call("GET", path, "", "", ck)
		if w.Code != 200 {
			t.Fatal(path, w.Code, w.Body.String())
		}
	}

	r := httptest.NewRequest("GET", "/v1/session", nil)
	r.AddCookie(ck)
	r.Header.Set("Authorization", "Bearer invalid")
	invalid := httptest.NewRecorder()
	h.ServeHTTP(invalid, r)
	if invalid.Code != 401 {
		t.Fatal("invalid bearer fell back to session")
	}

	// A browser outside Telegram logs in with the Login Widget as the same tenant.
	lookupBot = func(context.Context, string) (string, error) { return "fixture_bot", nil }
	w = call("GET", "/v1/auth/telegram", "", "", nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"bot_username":"fixture_bot"`) {
		t.Fatal(w.Code, w.Body.String())
	}
	raw, _ = json.Marshal(map[string]any{"login": widgetData(c.Token, time.Now().Unix())})
	w = call("POST", "/v1/auth/telegram", string(raw), "https://collection.test", nil)
	json.Unmarshal(w.Body.Bytes(), &session)
	if w.Code != 200 || session["tenant_id"] != identity.TenantID || len(w.Result().Cookies()) != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	raw, _ = json.Marshal(map[string]any{"login": widgetData(c.Token, time.Now().Unix()), "init_data": signedData(c.Token, time.Now().Unix())})
	if w = call("POST", "/v1/auth/telegram", string(raw), "https://collection.test", nil); w.Code != 400 {
		t.Fatal("accepted both credentials", w.Code)
	}

	w = call("DELETE", "/v1/session", "", "https://evil.test", ck)
	if w.Code != 403 {
		t.Fatal(w.Code)
	}
	w = call("DELETE", "/v1/session", "", "https://collection.test", ck)
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = call("GET", "/v1/session", "", "", ck)
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
	if _, e = admin.Pool.Exec(ctx, `SELECT cleanup_web_sessions()`); e != nil {
		t.Fatal(e)
	}
}

func TestStaticWeb(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("web fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WEB_DIST", dir)
	h := WebHandler(&app.Service{}, WebConfig{})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/app/", nil))
	if w.Code != 200 || w.Body.String() != "web fixture" {
		t.Fatal(w.Code, w.Body.String())
	}
	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/v1/session", nil))
	if w.Code != 401 {
		t.Fatal(w.Code)
	}
}
