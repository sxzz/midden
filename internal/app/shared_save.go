package app

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"monitor/internal/domain"
	"monitor/internal/store"
	"monitor/internal/telegram"
)

// SavePublicArchive adds only a tenant reference, without fetching or delivering content.
func (s *Service) SavePublicArchive(ctx context.Context, tenant, id string) (added bool, err error) {
	if !validIDArgument(id) {
		return false, domain.ErrNotFound
	}
	if s.Registry != nil || len(s.adapterBindings()) > 0 {
		var raw string
		err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
			return tx.QueryRow(ctx, "SELECT url FROM archives WHERE id=$1 AND visibility='public'", id).Scan(&raw)
		})
		if err != nil {
			return false, err
		}
		scoped, e := s.forURL(ctx, raw)
		if e != nil {
			return false, e
		}
		return scoped.SavePublicArchive(ctx, tenant, id)
	}
	d, err := s.descriptor(ctx)
	if err != nil {
		return false, err
	}
	p, err := s.defaultProvider(ctx, "none")
	if err != nil {
		return false, err
	}
	err = s.DB.Tx(ctx, tenant, func(tx pgx.Tx) error {
		if err := lockTenant(ctx, tx, tenant); err != nil {
			return err
		}
		var archive string
		if err := tx.QueryRow(ctx, `SELECT id FROM archives WHERE id=$1 AND visibility='public' AND current_revision IS NOT NULL FOR UPDATE`, id).Scan(&archive); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return domain.ErrNotFound
			}
			return err
		}
		tag, err := tx.Exec(ctx, `INSERT INTO tenant_archives(tenant_id,archive_id,provider_id,adapter_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, tenant, archive, p.Id, d.AdapterId)
		if err != nil {
			return err
		}
		added = tag.RowsAffected() > 0
		if added {
			var within bool
			if err := tx.QueryRow(ctx, `SELECT tenant_unlimited() OR tenant_usage()+reserved_bytes<=quota_bytes FROM tenants WHERE id=$1`, tenant).Scan(&within); err != nil {
				return err
			}
			if !within {
				return domain.ErrQuota
			}
		}
		_, err = tx.Exec(ctx, `UPDATE archives SET unreferenced_at=NULL WHERE id=$1`, archive)
		return err
	})
	if err != nil {
		added = false
	}
	return
}

func sharedSaveCallback(data string) bool {
	fields := strings.Fields(data)
	return len(fields) > 0 && fields[0] == "/save"
}

func (s *Service) saveSharedCallback(ctx context.Context, t store.Task, channel string, m *telegram.Message, q *telegram.Callback) error {
	text := "这条内容无法保存，仅支持公开归档。"
	fields := strings.Fields(q.Data)
	if m.Chat.ID < 0 && len(fields) == 2 && validIDArgument(fields[1]) {
		added, err := s.SavePublicArchive(ctx, t.Tenant, fields[1])
		switch {
		case err == nil && added:
			text = "已保存"
		case err == nil:
			text = "已经保存过了"
		case errors.Is(err, domain.ErrQuota):
			text = "存储额度不足，未保存。"
		case errors.Is(err, domain.ErrNotFound):
		default:
			text = "保存失败，请稍后重试。"
		}
	}
	sender, ok := s.sender(channel).(interface {
		AnswerToast(context.Context, string, string) error
	})
	if !ok {
		return &PermanentError{"Telegram toast sender unavailable"}
	}
	short, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := sender.AnswerToast(short, q.ID, text); err != nil {
		return telegramError(err)
	}
	return s.DB.Tx(ctx, t.Tenant, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE inbox SET state='processed' WHERE id=$1`, t.ID)
		return err
	})
}
