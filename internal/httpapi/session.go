package httpapi

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"monitor/internal/app"
	"monitor/internal/store"
)

type WebConfig struct{ URL, Token, Channel string }
type sessionKey struct{}

const sessionCookie = "__Host-midden"

func ValidateWebConfig(c WebConfig) error {
	if c.URL == "" {
		return nil
	}
	u, e := url.Parse(c.URL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Path != "/app/" || u.RawQuery != "" || u.Fragment != "" || c.Token == "" || c.Channel == "" {
		return fmt.Errorf("web_app_url requires an HTTPS /app/ URL and configured Telegram bot")
	}
	return nil
}

func telegramUser(raw, token string, now time.Time) (string, error) {
	v, e := url.ParseQuery(raw)
	if e != nil {
		return "", fmt.Errorf("invalid data")
	}
	keys := []string{}
	for k, values := range v {
		if len(values) != 1 {
			return "", fmt.Errorf("duplicate field")
		}
		if k != "hash" {
			keys = append(keys, k)
		}
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
	signature, e := hex.DecodeString(v.Get("hash"))
	if e != nil || !hmac.Equal(signature, mac.Sum(nil)) {
		return "", fmt.Errorf("invalid signature")
	}
	ts, e := strconv.ParseInt(v.Get("auth_date"), 10, 64)
	if e != nil || ts > now.Unix()+30 || ts < now.Unix()-300 {
		return "", fmt.Errorf("expired data")
	}
	var user struct {
		ID int64 `json:"id"`
	}
	if json.Unmarshal([]byte(v.Get("user")), &user) != nil || user.ID <= 0 {
		return "", fmt.Errorf("invalid user")
	}
	return strconv.FormatInt(user.ID, 10), nil
}
func webOrigin(c WebConfig) string {
	u, e := url.Parse(c.URL)
	if e != nil {
		return ""
	}
	return u.Scheme + "://" + u.Host
}
func cookie(w http.ResponseWriter, value string, age int) {
	http.SetCookie(w, &http.Cookie{Name: sessionCookie, Value: value, Path: "/", Secure: true, HttpOnly: true, SameSite: http.SameSiteNoneMode, MaxAge: age})
}
func login(s *app.Service, c WebConfig, w http.ResponseWriter, r *http.Request) {
	if c.URL == "" {
		http.NotFound(w, r)
		return
	}
	if r.Header.Get("Origin") != webOrigin(c) {
		write(w, 403, map[string]string{"error": "invalid origin"})
		return
	}
	var in struct {
		InitData string `json:"init_data"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 16384)).Decode(&in) != nil {
		write(w, 400, map[string]string{"error": "invalid request"})
		return
	}
	user, e := telegramUser(in.InitData, c.Token, time.Now())
	if e != nil {
		write(w, 401, map[string]string{"error": "reopen Telegram Mini App"})
		return
	}
	id, e := s.DB.Resolve(r.Context(), c.Channel, user, s.Config.Quota)
	if e != nil {
		respond(w, 200, nil, e)
		return
	}
	secret := make([]byte, 32)
	if _, e = rand.Read(secret); e != nil {
		respond(w, 200, nil, e)
		return
	}
	value := hex.EncodeToString(secret)
	e = s.DB.Tx(r.Context(), id.TenantID, func(tx pgx.Tx) error {
		_, e := tx.Exec(r.Context(), `INSERT INTO web_sessions(digest,tenant_id) VALUES($1,$2)`, store.Hash(value), id.TenantID)
		return e
	})
	if e != nil {
		respond(w, 200, nil, e)
		return
	}
	cookie(w, value, 43200)
	write(w, 200, map[string]string{"tenant_id": id.TenantID})
}
func authenticate(s *app.Service, c WebConfig, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if r.URL.Path == "/v1/auth/telegram" && r.Method == "POST" {
			login(s, c, w, r)
			return
		}
		var t string
		var e error
		if v := r.Header.Get("Authorization"); v != "" {
			if !strings.HasPrefix(v, "Bearer ") {
				write(w, 401, map[string]string{"error": "authentication required"})
				return
			}
			t, e = s.DB.Authenticate(r.Context(), strings.TrimPrefix(v, "Bearer "))
		} else {
			ck, err := r.Cookie(sessionCookie)
			if err != nil || c.URL == "" {
				write(w, 401, map[string]string{"error": "authentication required"})
				return
			}
			var tenantID *string
			e = s.DB.Pool.QueryRow(r.Context(), `SELECT authenticate_web_session($1)`, store.Hash(ck.Value)).Scan(&tenantID)
			if tenantID != nil {
				t = *tenantID
			}
			if r.Method != "GET" && r.Method != "HEAD" && r.Header.Get("Origin") != webOrigin(c) {
				write(w, 403, map[string]string{"error": "invalid origin"})
				return
			}
			r = r.WithContext(context.WithValue(r.Context(), sessionKey{}, true))
		}
		if e != nil || t == "" {
			write(w, 401, map[string]string{"error": "invalid session or token"})
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), key{}, t)))
	})
}
