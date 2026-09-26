package credentials

import (
	"encoding/base64"
	"fmt"
	"strings"
	"unicode/utf8"

	pb "monitor/api/adapter/v1"
)

// ParseCookie imports a base64-encoded Cookie header, retaining only session fields.
func ParseCookie(encoded string) (*pb.SessionCredential, error) {
	invalid := fmt.Errorf("expected base64 Cookie containing auth_token and ct0")
	if len(encoded) == 0 || len(encoded) > 16384 {
		return nil, invalid
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil {
		raw, err = base64.RawStdEncoding.Strict().DecodeString(encoded)
	}
	if err != nil || !utf8.Valid(raw) || strings.ContainsAny(string(raw), "\r\n\x00") {
		return nil, invalid
	}
	c := &pb.SessionCredential{}
	seen := map[string]bool{}
	for _, item := range strings.Split(string(raw), ";") {
		if strings.TrimSpace(item) == "" {
			continue
		}
		key, value, ok := strings.Cut(strings.TrimSpace(item), "=")
		if !ok {
			return nil, invalid
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		if key != "auth_token" && key != "ct0" {
			continue
		}
		if seen[key] {
			return nil, invalid
		}
		seen[key] = true
		switch key {
		case "auth_token":
			c.AuthToken = value
		case "ct0":
			c.CsrfToken = value
		}
	}
	if Validate(c) != nil {
		return nil, invalid
	}
	return c, nil
}
