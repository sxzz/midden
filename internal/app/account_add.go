package app

import (
	"context"
	"encoding/json"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"monitor/internal/credentials"
	"monitor/internal/telegram"
)

type accountImport struct {
	ID         string `json:"id,omitempty"`
	Name       string `json:"name,omitempty"`
	Ciphertext []byte `json:"ciphertext,omitempty"`
	Error      string `json:"error,omitempty"`
}

type persistedUpdate struct {
	telegram.Update
	AccountImport *accountImport `json:"account_import,omitempty"`
}

// This runs before inbox persistence. Never enqueue or persist the raw cookie.
func (s *Service) prepareUpdate(u telegram.Update, tenant, channel, username string) ([]byte, bool, error) {
	envelope := persistedUpdate{Update: u}
	if u.Callback == nil && u.Message != nil {
		m := *u.Message
		input := m.Text
		if m.Chat.ID < 0 {
			input, _ = m.AddressedText(username)
		}
		fields := strings.Fields(input)
		if len(fields) > 0 && strings.Split(fields[0], "@")[0] == "/account_add" {
			a := &accountImport{}
			envelope.AccountImport = a
			// Replace all user-controlled text/entity fields, including malformed/group input.
			m.Text, m.Caption, m.Entities, m.CaptionEntities = "/account_add", "", nil, nil
			envelope.Message = &m
			if len(fields) > 1 && m.Chat.Type == "private" {
				switch {
				case s.Vault == nil || !s.AdapterTLS:
					a.Error = "个人账号接入尚未配置，请联系服务管理员。"
				default:
					c, err := credentials.ParseCookie(fields[1])
					if err != nil {
						a.Error = "Cookie 格式无效，请提供含 auth_token 和 ct0 的 Base64 Cookie 字符串。"
					} else {
						a.Name = strings.Join(fields[2:], " ")
						if a.Name == "" {
							a.Name = "X 账号"
						}
						if len(a.Name) > 100 {
							a.Error = "账号名称过长，请缩短名称后重试。"
							a.Name = ""
						} else {
							a.ID = uuid.NewSHA1(uuid.NameSpaceOID, []byte("telegram-account:"+channel+":"+strconv.FormatInt(u.ID, 10))).String()
							a.Ciphertext, err = s.Vault.Seal(tenant, a.ID, c)
							if err != nil {
								return nil, false, err
							}
						}
					}
				}
			}
			raw, err := json.Marshal(envelope)
			return raw, len(fields) > 1 && m.Chat.Type == "private", err
		}
	}
	raw, err := json.Marshal(envelope)
	return raw, false, err
}

func (s *Service) commandAccountAdd(ctx context.Context, r *commandRequest) error {
	r.Buttons = nil
	a := r.AccountImport
	if a == nil || (a.Error == "" && len(a.Ciphertext) == 0) {
		r.Buttons = telegram.Keyboard{{{Text: "返回账号列表", Data: "/account"}}}
		r.Text = "用法：/account_add <Base64 Cookie> [账号名称]\nCookie 需包含 auth_token 和 ct0，仅限私聊。验证通过后可用 /account 选择账号。"
		return nil
	}
	if a.Error != "" {
		r.Text = a.Error
		return nil
	}
	// Retry after a crash must not replace credentials or resurrect a revoked connection.
	var exists bool
	if err := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT EXISTS(SELECT FROM connections WHERE id=$1)`, a.ID).Scan(&exists)
	}); err != nil {
		return err
	}
	if !exists {
		c, err := s.Vault.Open(r.Task.Tenant, a.ID, a.Ciphertext)
		if err != nil {
			r.Text = "无法读取账号会话，请重新添加。"
			return nil
		}
		_, err = s.importConnection(ctx, r.Task.Tenant, a.ID, a.Name, c, true)
		if err != nil {
			// Adapter and SQL errors may carry arbitrary detail; never echo them to Telegram.
			slog.Warn("account verification failed", "code", status.Code(err).String())
			switch status.Code(err) {
			case codes.Unauthenticated:
				r.Text = "X 登录会话已失效，请重新登录 X 后添加新的 Cookie。"
			case codes.PermissionDenied:
				r.Text = "X 拒绝了账号访问，请先在浏览器中确认账号状态。"
			case codes.FailedPrecondition, codes.Unimplemented:
				r.Text = "账号添加失败：X 账号验证接口暂不兼容，请联系管理员。"
			case codes.Unavailable, codes.DeadlineExceeded, codes.ResourceExhausted:
				r.Text = "账号添加失败：X 服务暂时不可用或请求受限，请稍后重试。"
			default:
				r.Text = "账号添加失败：服务暂时无法处理，请稍后重试。"
			}
			return nil
		}
	}
	var state string
	if err := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state FROM connections WHERE id=$1`, a.ID).Scan(&state)
	}); err != nil {
		return err
	}
	if state != "ready" {
		r.Text = "此账号当前不可用，请重新添加会话。"
		return nil
	}
	r.Text = "账号已添加。点击下方按钮用于后续保存，或使用 /account 切换来源。"
	r.Buttons = telegram.Keyboard{{{Text: "使用此账号", Data: "/account " + a.ID}}}
	return nil
}

func deleteAccountInput(ctx context.Context, sender Sender, chat string, message int64) {
	if c, ok := sender.(interface {
		DeleteProgress(context.Context, string, int64) error
	}); ok {
		call, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()
		_ = c.DeleteProgress(call, chat, message)
	}
}
