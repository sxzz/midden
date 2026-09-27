package app

import (
	"context"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

// Labels are supplied by the adapter; the ID is the generic unnamed fallback.
func adapterDisplayName(d *pb.DescribeResponse) string {
	if d.GetDisplayName() != "" {
		return d.GetDisplayName()
	}
	return d.GetAdapterId()
}

func (s *Service) prepareInteractiveUpdate(ctx context.Context, u telegram.Update, tenant, channel, username string) ([]byte, bool, error) {
	m := u.Message
	if u.Callback != nil || m == nil || m.Chat.Type != "private" {
		return s.prepareUpdate(u, tenant, channel, username)
	}
	if fields := strings.Fields(m.Text); len(fields) > 0 {
		if _, known := lookupCommand(strings.Split(fields[0], "@")[0]); known {
			return s.prepareUpdate(u, tenant, channel, username)
		}
	}
	var adapterID, flow string
	var expired bool
	err := s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT d.adapter_id,d.flow_id,d.expires_at<=now() FROM account_dialogs d JOIN identities i ON i.id=d.identity_id AND i.tenant_id=d.tenant_id WHERE i.channel_id=$1 AND i.external_id=$2 AND d.chat_id=$3`, channel, strconv.FormatInt(m.From.ID, 10), strconv.FormatInt(m.Chat.ID, 10)).Scan(&adapterID, &flow, &expired)
	})
	if errors.Is(err, domain.ErrNotFound) || errors.Is(err, pgx.ErrNoRows) {
		return s.prepareUpdate(u, tenant, channel, username)
	}
	if err != nil {
		return nil, false, err
	}
	// The incoming text is never persisted: preparation encrypts and redacts it.
	copyMessage := *m
	copyMessage.Text = "/account_add @" + adapterID + " dialog-input"
	u.Message = &copyMessage
	raw, _, err := s.prepareUpdate(u, tenant, channel, username)
	if err != nil {
		return nil, false, err
	}
	var envelope persistedUpdate
	if err = json.Unmarshal(raw, &envelope); err != nil {
		return nil, false, err
	}
	if envelope.AccountImport == nil {
		return nil, false, errors.New("missing account envelope")
	}
	envelope.AccountImport.FlowID = flow
	if !expired && envelope.AccountImport.Error == "" {
		value := &pb.Credential{Data: []byte(strings.TrimSpace(m.Text))}
		if credentials.Validate(value) != nil {
			envelope.AccountImport.Error = "请发送有效的文本凭据，再重新添加账号。"
			envelope.AccountImport.Ciphertext = nil
		} else {
			envelope.AccountImport.Name = "采集账号"
			envelope.AccountImport.Ciphertext, err = s.Vault.Seal(tenant, envelope.AccountImport.ID, value)
			if err != nil {
				return nil, false, err
			}
		}
	}

	if expired {
		envelope.AccountImport.Ciphertext = nil
		envelope.AccountImport.Error = "添加账号已超时，请重新点击添加账号。"
	}
	raw, err = json.Marshal(envelope)
	return raw, true, err
}

func (s *Service) beginAccountDialog(ctx context.Context, r *commandRequest) error {
	d, e := s.descriptor(ctx)
	if e != nil {
		return e
	}
	p, e := s.defaultProvider(ctx, "session")
	if e != nil || !adapter.Supports(p, adapter.CredentialPrepare, 1, 0) || !adapter.Supports(p, adapter.ConnectionCheck, 1, 0) {
		r.Text = "此平台暂不支持添加账号。"
		return nil
	}
	if s.Vault == nil || !s.AdapterTLS {
		r.Text = "个人账号接入尚未配置，请联系服务管理员。"
		return nil
	}
	e = s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO account_dialogs(tenant_id,identity_id,chat_id,flow_id,adapter_id,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '10 minutes') ON CONFLICT(tenant_id,identity_id,chat_id) DO UPDATE SET flow_id=excluded.flow_id,adapter_id=excluded.adapter_id,expires_at=excluded.expires_at WHERE account_dialogs.flow_id<>excluded.flow_id`, r.Task.Tenant, r.Origin.IdentityID, r.Origin.ChatID, r.Task.ID, d.AdapterId)
		return err
	})
	if e != nil {
		return e
	}
	r.Text = "添加 " + adapterDisplayName(d) + " 账号\n\n" + p.CredentialHelp + "\n\n请直接发送凭据，无需输入命令。10 分钟内有效。"
	r.Buttons = telegram.Keyboard{{{Text: "取消添加", Data: "/account_cancel"}}}
	return nil
}

func (s *Service) finishAccountDialog(ctx context.Context, r *commandRequest) error {
	if r.AccountImport == nil || r.AccountImport.FlowID == "" {
		return nil
	}
	return s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, "DELETE FROM account_dialogs WHERE identity_id=$1 AND chat_id=$2 AND flow_id=$3", r.Origin.IdentityID, r.Origin.ChatID, r.AccountImport.FlowID)
		return e
	})
}

func (s *Service) commandAccountCancel(ctx context.Context, r *commandRequest) error {
	e := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		_, e := tx.Exec(ctx, "DELETE FROM account_dialogs WHERE identity_id=$1 AND chat_id=$2", r.Origin.IdentityID, r.Origin.ChatID)
		return e
	})
	r.Text = "已取消添加账号。"
	r.Buttons = telegram.Keyboard{{{Text: "返回账号列表", Data: "/account"}}}
	return e
}
