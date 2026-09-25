package domain

import (
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var (
	ErrNotFound    = errors.New("not found")
	ErrQuota       = errors.New("quota exceeded")
	ErrRate        = errors.New("capture rate exceeded")
	ErrUnsupported = errors.New("account authentication is not supported in this version")
	ErrConflict    = errors.New("idempotency key conflicts with an earlier request")
)

type Target struct {
	URL        string `json:"url"`
	ExternalID string `json:"external_id"`
}

var pathRE = regexp.MustCompile(`^/(?:[A-Za-z0-9_]{1,20}|i/web)/status/([0-9]+)(?:/(?:photo|video)/[0-9]+)?/?$`)

func Normalize(raw string) (Target, error) {
	u, e := url.Parse(strings.TrimSpace(raw))
	if e != nil || (u.Scheme != "https" && u.Scheme != "http") || u.User != nil || u.Port() != "" {
		return Target{}, fmt.Errorf("invalid post URL")
	}
	host := strings.ToLower(u.Hostname())
	host = strings.TrimPrefix(strings.TrimPrefix(host, "www."), "mobile.")
	if host != "x.com" && host != "twitter.com" {
		return Target{}, fmt.Errorf("unsupported URL host")
	}
	m := pathRE.FindStringSubmatch(u.Path)
	if m == nil {
		return Target{}, fmt.Errorf("only X post URLs are supported")
	}
	return Target{URL: "https://x.com/i/web/status/" + m[1], ExternalID: m[1]}, nil
}

type Identity struct {
	ID         string `json:"id"`
	TenantID   string `json:"tenant_id"`
	ChannelID  string `json:"channel_instance_id"`
	ExternalID string `json:"external_user_id"`
}

type (
	Connection struct{ ID, TenantID, AdapterID, ProviderID, Name, AccountID, State, CredentialRef string }
	Origin     struct {
		IdentityID string `json:"identity_id,omitempty"`
		ChannelID  string `json:"channel_id,omitempty"`
		ChatID     string `json:"chat_id,omitempty"`
	}
)

type CaptureInput struct {
	URL          string `json:"url"`
	ProviderID   string `json:"provider_id,omitempty"`
	ConnectionID string `json:"connection_id,omitempty"`
	RefreshID    string `json:"refresh_id,omitempty"`
	Key          string `json:"-"`
	Origin       Origin `json:"-"`
}

type Job struct {
	ID           string    `json:"id"`
	ArchiveID    string    `json:"archive_id,omitempty"`
	State        string    `json:"state"`
	Error        string    `json:"error,omitempty"`
	ProviderID   string    `json:"provider_id"`
	ConnectionID string    `json:"connection_id,omitempty"`
	AccessScope  string    `json:"access_scope"`
	CreatedAt    time.Time `json:"created_at"`
}

type Asset struct {
	ID       string `json:"id"`
	Position int    `json:"position"`
	State    string `json:"state"`
	Error    string `json:"error,omitempty"`
	Hash     string `json:"sha256,omitempty"`
	MIME     string `json:"mime,omitempty"`
	Size     int64  `json:"size"`
	Key      string `json:"-"`
}

type Archive struct {
	ID             string    `json:"id"`
	URL            string    `json:"url"`
	ExternalID     string    `json:"external_id"`
	ProviderID     string    `json:"provider_id"`
	AccessScope    string    `json:"access_scope"`
	RevisionID     string    `json:"revision_id"`
	Text           string    `json:"text"`
	TextKind       string    `json:"text_kind"`
	AdapterVersion string    `json:"adapter_version"`
	Warnings       []string  `json:"warnings"`
	Assets         []Asset   `json:"assets"`
	ObservedAt     time.Time `json:"observed_at"`
	CreatedAt      time.Time `json:"created_at"`
}

type Page struct {
	Items      []Archive `json:"items"`
	NextCursor string    `json:"next_cursor,omitempty"`
}

type Usage struct {
	Used     int64 `json:"used_bytes"`
	Reserved int64 `json:"reserved_bytes"`
	Limit    int64 `json:"limit_bytes"`
}
