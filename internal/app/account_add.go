package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	pb "monitor/api/adapter/v1"
	"monitor/internal/adapter"
	"monitor/internal/credentials"
	"monitor/internal/domain"
	"monitor/internal/telegram"
)

type accountImport struct {
	FlowID     string `json:"flow_id,omitempty"`
	AdapterID  string `json:"adapter_id,omitempty"`
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
			selected := s
			if len(fields) > 1 && strings.HasPrefix(fields[1], "@") {
				a.AdapterID = strings.TrimPrefix(fields[1], "@")
				fields = append(fields[:1], fields[2:]...)
				var e error
				selected, e = s.forAdapter(a.AdapterID)
				if e != nil {
					a.Error = "Adapter 不可用。"
					selected = nil
				}
			} else if len(s.Adapters) == 1 {
				a.AdapterID = s.adapterIDs()[0]
				selected, _ = s.forAdapter(a.AdapterID)
			} else if len(s.Adapters) > 1 {
				if len(fields) > 1 {
					a.Error = "请先选择添加账号的平台。"
				}
				selected = nil
			}

			// Replace all user-controlled text/entity fields, including malformed/group input.
			m.Text, m.Caption, m.Entities, m.CaptionEntities = "/account_add", "", nil, nil
			envelope.Message = &m
			if len(fields) > 1 && m.Chat.Type == "private" {
				switch {
				case selected == nil:
				case selected.Vault == nil || !selected.AdapterTLS:
					a.Error = "个人账号接入尚未配置，请联系服务管理员。"
				default:
					c := &pb.Credential{Data: []byte(fields[1])}
					err := credentials.Validate(c)
					if err != nil {
						a.Error = "凭据输入为空或过长，请按 Adapter 的格式要求重试。"
					} else {
						a.Name = strings.Join(fields[2:], " ")
						if a.Name == "" {
							a.Name = "采集账号"
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
	if len(s.Adapters) > 0 {
		id := strings.TrimPrefix(r.Argument, "@")
		if r.AccountImport != nil {
			id = r.AccountImport.AdapterID
			if r.AccountImport.Error != "" {
				r.Text = r.AccountImport.Error
				r.Buttons = telegram.Keyboard{{{Text: "重新添加", Data: "/account_add"}}}
				return s.finishAccountDialog(ctx, r)
			}
		}
		if id == "" && len(s.Adapters) == 1 {
			id = s.adapterIDs()[0]
		}
		scoped, e := s.forAdapter(id)
		if e != nil {
			r.Text = "请选择添加账号的平台。"
			r.Buttons = nil
			for _, id := range s.adapterIDs() {
				scoped, _ := s.forAdapter(id)
				p, err := scoped.defaultProvider(ctx, "session")
				if err != nil || !adapter.Supports(p, adapter.CredentialPrepare, 1, 0) || !adapter.Supports(p, adapter.ConnectionCheck, 1, 0) {
					continue
				}
				r.Buttons = append(r.Buttons, []telegram.Button{{Text: adapterDisplayName(s.Adapters[id].Descriptor), Data: "/account_add @" + id}})
			}
			return nil
		}
		if e = scoped.commandAccountAdd(ctx, r); e != nil {
			return e
		}
		return nil
	}

	r.Buttons = nil
	a := r.AccountImport
	if a == nil || (a.Error == "" && len(a.Ciphertext) == 0) {
		return s.beginAccountDialog(ctx, r)
	}
	if a.Error != "" {
		r.Text = a.Error
		return s.finishAccountDialog(ctx, r)
	}
	// Finish only this prompt; a newer platform selection remains active.
	if err := s.finishAccountDialog(ctx, r); err != nil {
		return err
	}
	d, err := s.descriptor(ctx)
	if err != nil {
		return err
	}
	r.Buttons = telegram.Keyboard{{{Text: "重新添加", Data: "/account_add @" + d.AdapterId}}}
	// Retry after a crash must not replace credentials or resurrect a revoked connection.
	connectionID, lookupErr := s.importedConnection(ctx, r.Task.Tenant, a.ID)
	if lookupErr != nil && !errors.Is(lookupErr, domain.ErrNotFound) && !errors.Is(lookupErr, pgx.ErrNoRows) {
		return lookupErr
	}
	if lookupErr != nil {
		c, err := s.Vault.Open(r.Task.Tenant, a.ID, a.Ciphertext)
		if err != nil {
			r.Text = "无法读取账号会话，请重新添加。"
			return nil
		}
		connectionID, err = s.importConnection(ctx, r.Task.Tenant, a.ID, a.Name, c, true)
		if err != nil {
			// Adapter and SQL errors may carry arbitrary detail; never echo them to Telegram.
			slog.Warn("account verification failed", "code", status.Code(err).String())
			switch status.Code(err) {
			case codes.InvalidArgument:
				r.Text = "凭据格式无效，请按账号添加说明重试。"
			case codes.Unauthenticated:
				r.Text = "登录会话已失效，请重新登录对应平台后更新凭据。"
			case codes.PermissionDenied:
				r.Text = "平台拒绝了账号访问，请先在浏览器中确认账号状态。"
			case codes.FailedPrecondition, codes.Unimplemented:
				r.Text = "账号添加失败：账号验证接口暂不兼容，请联系管理员。"
			case codes.Unavailable, codes.DeadlineExceeded, codes.ResourceExhausted:
				r.Text = "账号添加失败：平台服务暂时不可用或请求受限，请稍后重试。"
			default:
				r.Text = "账号添加失败：服务暂时无法处理，请稍后重试。"
			}
			return nil
		}
	}
	var state, name, username, accountID string
	if err := s.DB.Tx(ctx, r.Task.Tenant, func(tx pgx.Tx) error {
		return tx.QueryRow(ctx, `SELECT state,name,coalesce(username,''),coalesce(account_id,'') FROM connections WHERE id=$1`, connectionID).Scan(&state, &name, &username, &accountID)
	}); err != nil {
		return err
	}
	if state != "ready" {
		r.Text = "此账号当前不可用，请重新添加会话。"
		return nil
	}
	selected, err := s.DefaultConnection(ctx, r.Task.Tenant)
	if err != nil {
		return err
	}
	r.Text = "账号已添加：" + connectionLabel(name, username, accountID) + "。"
	if selected == connectionID {
		r.Text += "已自动选中，用于后续保存。"
	}
	r.Buttons = telegram.Keyboard{{{Text: "管理账号", Data: "/account"}}}
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
