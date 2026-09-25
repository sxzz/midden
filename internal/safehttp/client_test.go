package safehttp

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
	"time"
)

func TestPublic(t *testing.T) {
	for _, ip := range []string{"127.0.0.1", "10.0.0.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2002:7f00::1", "fc00::1", "224.0.0.1", "192.0.2.1"} {
		if Public(netip.MustParseAddr(ip)) {
			t.Fatal(ip)
		}
	}
	if !Public(netip.MustParseAddr("8.8.8.8")) {
		t.Fatal("public rejected")
	}
}

func TestLocalBlocked(t *testing.T) {
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("reached private server") }))
	defer h.Close()
	if _, e := New(time.Second).Get(h.URL); e == nil {
		t.Fatal("SSRF permitted")
	}
}
