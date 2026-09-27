package domain

import "testing"

func TestNormalize(t *testing.T) {
	for _, u := range []string{"https://x.com/fixture_user/status/20?s=1", "https://mobile.twitter.com/fixture_user/status/20/photo/1", "https://www.x.com/i/web/status/20"} {
		v, e := Normalize(u)
		if e != nil || v.ExternalID != "20" || v.URL != "https://x.com/i/web/status/20" {
			t.Fatalf("%s: %+v %v", u, v, e)
		}
	}
	for _, u := range []string{"https://x.com.evil.org/fixture_user/status/20", "https://x.com@127.0.0.1/fixture_user/status/20", "https://x.com:443/a/status/20", "https://t.co/abc", "https://x.com/jack", "file:///tmp/x", "https://x.com/a/status/20/evil"} {
		if _, e := Normalize(u); e == nil {
			t.Fatal(u)
		}
	}
}
