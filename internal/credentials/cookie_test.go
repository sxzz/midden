package credentials

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestParseCookie(t *testing.T) {
	cookie := "kdt=ignored; auth_token=" + strings.Repeat("a", 40) + ";twid=u%3D123; ct0=" + strings.Repeat("b", 128) + ";"
	for _, enc := range []*base64.Encoding{base64.StdEncoding, base64.RawStdEncoding} {
		c, err := ParseCookie(enc.EncodeToString([]byte(cookie)))
		if err != nil || c.AuthToken != strings.Repeat("a", 40) || c.CsrfToken != strings.Repeat("b", 128) {
			t.Fatal("valid cookie rejected")
		}
	}
	for _, raw := range []string{"", "auth_token=short;ct0=short", "auth_token=" + strings.Repeat("a", 40), cookie + "auth_token=duplicate", cookie + "\r\n", "broken;" + cookie} {
		if _, err := ParseCookie(base64.StdEncoding.EncodeToString([]byte(raw))); err == nil {
			t.Fatal("invalid cookie accepted")
		}
	}
	for _, raw := range []string{"not-base64!", strings.Repeat("A", 16385)} {
		if _, err := ParseCookie(raw); err == nil || strings.Contains(err.Error(), raw) {
			t.Fatal("invalid input accepted or echoed")
		}
	}
}
