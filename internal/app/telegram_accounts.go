package app

import (
	"context"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5"

	"monitor/internal/adapter"
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

func (s *Service) commandAccount(ctx context.Context, r *commandRequest) error {
	accountProvider, accountErr := s.defaultProvider(ctx, "session")
	canAdd := accountErr == nil && adapter.Supports(accountProvider, adapter.CredentialPrepare, 1, 0) && adapter.Supports(accountProvider, adapter.ConnectionCheck, 1, 0)
	if r.Argument != "" && r.Argument != "public" {
		_, provider, err := s.connectionProvider(ctx, r.Task.Tenant, r.Argument)
		if err == nil {
			_, err = s.requireProvider(ctx, provider, adapter.ConnectionCheck)
		}
		if err != nil {
			r.Text = "账号对应的 Adapter 或能力不可用。"
			return nil
		}
	}
	return s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		if e := lockTenant(ctx, tx, r.Task.Tenant); e != nil {
			return e
		}
		if r.Argument != "" {
			id := r.Argument
			if id == "public" {
				id = ""
			} else {
				if !s.AdapterTLS || s.Vault == nil {
					r.Text = "个人账号接入尚未配置。"
					return nil
				}
				var state string
				e := tx.QueryRow(ctx, `SELECT state FROM connections WHERE id=$1`, id).Scan(&state)
				if e != nil || state != "ready" {
					r.Text = "账号不可用，请重新授权或选择公共来源。"
					return nil
				}
			}
			if _, e := tx.Exec(ctx, `INSERT INTO tenant_preferences(tenant_id,default_connection_id) VALUES($1,nullif($2,'')::uuid) ON CONFLICT(tenant_id) DO UPDATE SET default_connection_id=excluded.default_connection_id`, r.Task.Tenant, id); e != nil {
				return e
			}
		}
		var selected string
		if e := tx.QueryRow(ctx, `SELECT coalesce((SELECT default_connection_id::text FROM tenant_preferences),'')`).Scan(&selected); e != nil {
			return e
		}
		r.Text = "选择保存新链接时使用的来源。此设置在私聊和群聊中通用。"
		label := "公共来源 · 无需账号"
		if selected == "" {
			label = "✓ " + label
		}
		r.Buttons = telegram.Keyboard{{{Text: label, Data: "/account public"}}}
		rows, e := tx.Query(ctx, `SELECT id,name,state,coalesce(username,''),coalesce(account_id,'') FROM connections WHERE state<>'revoked' ORDER BY name,id`)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var id, name, state, username, accountID string
			if e = rows.Scan(&id, &name, &state, &username, &accountID); e != nil {
				return e
			}
			name = connectionLabel(name, username, accountID)
			if selected == id {
				name = "✓ " + name
			}
			if state != "ready" {
				name += "（需重新授权）"
			}
			buttons := []telegram.Button{{Text: name, Data: "/account " + id}}
			if !strings.HasPrefix(r.Origin.ChatID, "-") {
				buttons = append(buttons, telegram.Button{Text: "删除", Data: "/account_delete " + id})
			}
			r.Buttons = append(r.Buttons, buttons)
		}
		if canAdd && !strings.HasPrefix(r.Origin.ChatID, "-") {
			r.Buttons = append(r.Buttons, []telegram.Button{{Text: "添加账号", Data: "/account_add"}})
		}
		return rows.Err()
	})
}

func connectionLabel(name, username, accountID string) string {
	if username != "" {
		label := "@" + strings.TrimPrefix(username, "@")
		if name != "" && name != username && name != label && name != "X 账号" {
			label += " · " + name
		}
		return label
	}
	if accountID != "" {
		return name + " · " + accountID
	}
	return name
}

func validAccountDeleteArgument(arg string) bool {
	return arg == "" || validIDArgument(strings.TrimPrefix(arg, "confirm:"))
}

func (s *Service) commandAccountDelete(ctx context.Context, r *commandRequest) error {
	if r.Argument == "" {
		if err := s.commandAccount(ctx, r); err != nil {
			return err
		}
		r.Text = "点击账号旁的删除按钮，移除采集账号。已保存的归档会保留。"
		return nil
	}
	id := strings.TrimPrefix(r.Argument, "confirm:")
	var name, username, accountID, state string
	err := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT name,coalesce(username,''),coalesce(account_id,''),state FROM connections WHERE id=$1 AND tenant_id=$2`, id, r.Task.Tenant).Scan(&name, &username, &accountID, &state)
	})
	if errors.Is(err, domain.ErrNotFound) {
		r.Text = "账号不存在或无权限。"
		return nil
	}
	if err != nil {
		return err
	}
	r.Buttons = telegram.Keyboard{{{Text: "返回账号列表", Data: "/account"}}}
	if state == "revoked" {
		r.Text = "账号已删除。"
		return nil
	}
	if !strings.HasPrefix(r.Argument, "confirm:") {
		r.Text = "删除采集账号 " + connectionLabel(name, username, accountID) + "？\n已保存的归档会保留，使用此账号的任务和重新采集将无法继续。若它是当前账号，新的保存请求将使用公共来源。"
		r.Buttons = telegram.Keyboard{{{Text: "确认删除", Data: "/account_delete confirm:" + id}, {Text: "取消", Data: "/account"}}}
		return nil
	}
	if err := s.RevokeConnection(ctx, r.Task.Tenant, id); err != nil {
		return err
	}
	r.Text = "账号已删除，已保存的归档保留。"
	return nil
}
