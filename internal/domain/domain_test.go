package domain

import "testing"

func TestValidateURL(t *testing.T) {
	for _, u := range []string{"https://example.test/items/123", "http://other.test/path"} {
		if err := ValidateURL(u); err != nil {
			t.Fatal(err)
		}
	}
	for _, u := range []string{"file:///etc/passwd", "https://user:secret@example.test", "invalid"} {
		if ValidateURL(u) == nil {
			t.Fatal("accepted", u)
		}
	}
}
