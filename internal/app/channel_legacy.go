package app

import (
	"context"
	"encoding/json"

	"github.com/jackc/pgx/v5"

	"monitor/internal/channelapi"
	"monitor/internal/domain"
)

// Data-only upgrade compatibility. Telegram parsing/rendering lives in tgchannel.
type legacyAccountImport struct {
	FlowID     string `json:"flow_id,omitempty"`
	AdapterID  string `json:"adapter_id,omitempty"`
	ID         string `json:"id,omitempty"`
	Name       string `json:"name,omitempty"`
	Ciphertext []byte `json:"ciphertext,omitempty"`
	Error      string `json:"error,omitempty"`
}

// NormalizeChannel upgrades an old inbox envelope in place. It never lets a
// caller replace an already normalized event or its sealed credential.
func (s *Service) NormalizeChannel(ctx context.Context, channel, id, lease string, event channelapi.Event) (channelapi.Event, error) {
	tenant, w, e := s.ChannelWork(ctx, channel, id, lease)
	if e != nil {
		return event, e
	}
	var envelope struct {
		Legacy json.RawMessage `json:"legacy"`
	}
	if e = json.Unmarshal(w.Payload, &envelope); e != nil {
		return event, e
	}
	if len(envelope.Legacy) == 0 {
		e = json.Unmarshal(w.Payload, &event)
		return event, e
	}
	var old struct {
		Account *legacyAccountImport `json:"account_import"`
	}
	if e = json.Unmarshal(envelope.Legacy, &old); e != nil {
		return event, e
	}
	identity, e := s.DB.Resolve(ctx, channel, event.Actor, s.Config.Quota)
	if e != nil || identity.TenantID != tenant {
		return event, domain.ErrNotFound
	}
	event.Credential = ""
	event.Ciphertext = nil
	if old.Account != nil {
		event.Command = "account_add"
		event.Adapter = old.Account.AdapterID
		event.Name = old.Account.Name
		event.Flow = old.Account.FlowID
		event.Text = ""
		event.Argument = ""
		event.URLs = nil
		if old.Account.Error != "" {
			event.Problem = "invalid_credentials"
		}
		if len(old.Account.Ciphertext) > 0 {
			if s.Vault == nil {
				return event, ErrConnection
			}
			value, err := s.Vault.Open(tenant, old.Account.ID, old.Account.Ciphertext)
			if err != nil {
				return event, err
			}
			event.Ciphertext, e = s.Vault.Seal(tenant, w.ID, value)
			if e != nil {
				return event, e
			}
		}
	}
	raw, e := json.Marshal(event)
	if e != nil {
		return event, e
	}
	e = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, `UPDATE channel_work SET payload=$2 WHERE id=$1 AND lease=$3 AND payload ? 'legacy'`, id, raw, lease)
		return e
	})
	return event, e
}
