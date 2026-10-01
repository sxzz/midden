package domain

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

var (
	ErrInvalidTarget = errors.New("invalid or unsupported URL")
	ErrNotFound      = errors.New("not found")
	ErrQuota         = errors.New("quota exceeded")
	ErrRate          = errors.New("capture rate exceeded")
	ErrUnsupported   = errors.New("provider operation is not supported")
	ErrConflict      = errors.New("idempotency key conflicts with an earlier request")
)

type Target struct {
	Collection      bool
	RefreshOnSubmit bool
	URL             string
	ExternalID      string
	Platform        string
	Kind            string
	ObjectScope     string
}

// URL transport validation is generic. Only adapters identify platform objects.
func ValidateURL(raw string) error {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Hostname() == "" || u.User != nil {
		return fmt.Errorf("invalid URL")
	}
	return nil
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
		ReplyToMessageID int64  `json:"reply_to_message_id,omitempty"`
		IdentityID       string `json:"identity_id,omitempty"`
		ChannelID        string `json:"channel_id,omitempty"`
		ChatID           string `json:"chat_id,omitempty"`
	}
)

type CaptureInput struct {
	PageCursor          string `json:"-"`
	PageSize            uint32 `json:"-"`
	ParentSubmission    string `json:"-"`
	CollectionLimit     uint32 `json:"-"`
	Automatic           bool   `json:"-"`
	RefreshAfterSeconds uint32 `json:"-"`
	Input               string `json:"-"`
	URL                 string `json:"url"`
	ProviderID          string `json:"provider_id,omitempty"`
	ConnectionID        string `json:"connection_id,omitempty"`
	RefreshID           string `json:"refresh_id,omitempty"`
	Key                 string `json:"-"`
	Origin              Origin `json:"-"`
}

type Job struct {
	ID           string    `json:"id"`
	CollectionID string    `json:"collection_id,omitempty"`
	State        string    `json:"state"`
	Error        string    `json:"error,omitempty"`
	ProviderID   string    `json:"provider_id"`
	ConnectionID string    `json:"connection_id,omitempty"`
	AccessScope  string    `json:"access_scope"`
	CreatedAt    time.Time `json:"created_at"`
}

type Asset struct {
	Purpose   string `json:"purpose,omitempty"`
	Sensitive bool   `json:"sensitive"`
	AltText   string `json:"alt_text,omitempty"`
	ID        string `json:"id"`
	Position  int    `json:"position"`
	State     string `json:"state"`
	Error     string `json:"error,omitempty"`
	Hash      string `json:"sha256,omitempty"`
	MIME      string `json:"mime,omitempty"`
	Size      int64  `json:"size"`
	Key       string `json:"-"`
}

type Entity struct {
	SavedCollectionID string          `json:"saved_collection_id,omitempty"`
	ContextOnly       bool            `json:"context_only,omitempty"`
	ID                string          `json:"id,omitempty"`
	VersionID         string          `json:"version_id,omitempty"`
	Key               string          `json:"key"`
	Type              string          `json:"type"`
	ExternalID        string          `json:"external_id"`
	Data              json.RawMessage `json:"data"`
	Schema            json.RawMessage `json:"schema"`
	ResourceIndices   []uint32        `json:"resource_indices,omitempty"`
	Assets            []Asset         `json:"assets,omitempty"`
}
type EntityRelation struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Type   string `json:"type"`
}
type EntityGraph struct {
	Root      string           `json:"root"`
	Entities  []Entity         `json:"entities"`
	Relations []EntityRelation `json:"relations"`
}
type SourceResponse struct {
	ID             string    `json:"id"`
	CaptureID      string    `json:"capture_id"`
	ProviderID     string    `json:"provider_id"`
	AdapterVersion string    `json:"adapter_version"`
	Visibility     string    `json:"visibility"`
	ContentType    string    `json:"content_type"`
	SourceURL      string    `json:"source_url"`
	SHA256         string    `json:"sha256"`
	Size           int64     `json:"size"`
	CreatedAt      time.Time `json:"created_at"`
	Body           []byte    `json:"-"`
}
type IncomingRelation struct {
	Type   string  `json:"type"`
	Entity Entity  `json:"entity"`
	Author *Entity `json:"author,omitempty"`
}

type Collection struct {
	IncomingRelations []IncomingRelation `json:"incoming_relations,omitempty"`
	RelationTypes     []string           `json:"relation_types,omitempty"`
	StorageBytes      int64              `json:"storage_bytes"`
	AuthorName        string             `json:"author_name,omitempty"`
	PublishedAt       string             `json:"published_at,omitempty"`
	Summary           string             `json:"summary,omitempty"`
	Graph             *EntityGraph       `json:"graph,omitempty"`
	Visibility        string             `json:"visibility"`
	ID                string             `json:"id"`
	URL               string             `json:"url"`
	ExternalID        string             `json:"external_id"`
	ProviderID        string             `json:"provider_id"`
	AccessScope       string             `json:"access_scope"`
	RevisionID        string             `json:"revision_id"`
	Text              string             `json:"text"`
	TextKind          string             `json:"text_kind"`
	TextSource        string             `json:"text_source,omitempty"`
	AdapterVersion    string             `json:"adapter_version"`
	Warnings          []string           `json:"warnings"`
	Assets            []Asset            `json:"assets"`
	ObservedAt        time.Time          `json:"observed_at"`
	CreatedAt         time.Time          `json:"created_at"`
}

type Page struct {
	Items          []Collection `json:"items"`
	NextCursor     string       `json:"next_cursor,omitempty"`
	PreviousCursor string       `json:"previous_cursor,omitempty"`
}

type Usage struct {
	Unlimited bool  `json:"unlimited"`
	Used      int64 `json:"used_bytes"`
	Reserved  int64 `json:"reserved_bytes"`
	Limit     int64 `json:"limit_bytes"`
}

// ChannelMediaCache stores opaque delivery references independently of collections.
type ChannelMediaCache interface {
	GetChannelMedia(context.Context, string, string, string, string) (string, error)
	PutChannelMedia(context.Context, string, string, string, string, string) error
	DeleteChannelMedia(context.Context, string, string, string, string, string) error
}
