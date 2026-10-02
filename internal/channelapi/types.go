// Package channelapi is the HTTP contract shared by core and channel clients.
// It has no database, object store, queue, or adapter client dependencies.
package channelapi

import (
	"encoding/json"
	"time"

	"monitor/internal/domain"
)

type Config struct {
	Token  string `json:"token"`
	BotID  string `json:"bot_id"`
	WebURL string `json:"web_url"`
	Offset int64  `json:"offset"`
}
type ActorProfile struct {
	FirstName string `json:"first_name"`
	LastName  string `json:"last_name"`
	Username  string `json:"username"`
}

type Event struct {
	ActorProfile *ActorProfile `json:"actor_profile,omitempty"`
	Sensitive    bool          `json:"sensitive,omitempty"`
	Protected    bool          `json:"protected,omitempty"`
	UpdateID     int64         `json:"update_id"`
	Actor        string        `json:"actor"`
	Chat         string        `json:"chat"`
	MessageID    int64         `json:"message_id"`
	CallbackID   string        `json:"callback_id,omitempty"`
	Private      bool          `json:"private"`
	Command      string        `json:"command"`
	Argument     string        `json:"argument,omitempty"`
	URLs         []string      `json:"urls,omitempty"`
	Text         string        `json:"text,omitempty"`
	Credential   string        `json:"credential,omitempty"`
	Problem      string        `json:"problem,omitempty"`
}
type Work struct {
	ID        string          `json:"id"`
	Lease     string          `json:"lease"`
	Kind      string          `json:"kind"`
	Resource  string          `json:"resource"`
	Payload   json.RawMessage `json:"payload"`
	Progress  int             `json:"progress"`
	MessageID int64           `json:"message_id"`
	CreatedAt time.Time       `json:"created_at"`
}
type Action struct {
	WorkID   string `json:"work_id"`
	Lease    string `json:"lease"`
	Name     string `json:"name"`
	Argument string `json:"argument,omitempty"`
}
type Ack struct {
	Lease        string `json:"lease"`
	Progress     int    `json:"progress"`
	MessageID    int64  `json:"message_id"`
	Done         bool   `json:"done"`
	RetrySeconds int    `json:"retry_seconds,omitempty"`
	Permanent    bool   `json:"permanent,omitempty"`
}
type Account struct {
	ID, Name, Username, AccountID, State, Adapter string
	Selected                                      bool
}
type Platform struct {
	ID, Name, Help string
	Public, CanAdd bool
	Selected       string
}
type AccountList struct {
	Accounts  []Account
	Platforms []Platform
}
type Result struct {
	Code       string             `json:"code,omitempty"`
	Count      int64              `json:"count,omitempty"`
	Page       *domain.Page       `json:"page,omitempty"`
	Usage      *domain.Usage      `json:"usage,omitempty"`
	Job        *domain.Job        `json:"job,omitempty"`
	Collection *domain.Collection `json:"collection,omitempty"`
	Accounts   *AccountList       `json:"accounts,omitempty"`
	Account    *Account           `json:"account,omitempty"`
	Platform   *Platform          `json:"platform,omitempty"`
	Errors     []string           `json:"errors,omitempty"`
}
type Delivery struct {
	Paused, Protected      bool
	Chat                   string
	ReplyTo                int64
	State, Input, LastText string
	Job                    domain.Job
	Collection             *domain.Collection
	ProgressDetails        *CollectionProgress
	Batch                  *domain.RefreshBatch
	// Legacy rendered replies are retained only for upgrade draining.
	Legacy json.RawMessage
}
type FailureReason struct {
	Reason string
	Count  int
}

type CollectionProgress struct {
	Reasons                                             []FailureReason
	URL, CollectionID, Next, Error                      string
	Total, Complete, Partial, Failed, Pending, MaxBatch int
	Done, Stopped                                       bool
}
