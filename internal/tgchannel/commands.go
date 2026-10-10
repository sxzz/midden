package tgchannel

import (
	"context"
	"fmt"
	"net/url"
	"strings"
	"unicode/utf16"

	"monitor/internal/buildinfo"
	"monitor/internal/channelapi"
	"monitor/internal/telegram"
)

type response struct {
	Text     string
	Buttons  telegram.Keyboard
	Entities []telegram.Entity
	Previous int64
	Toast    string
}

func (r *Runner) command(ctx context.Context, w channelapi.Work, event channelapi.Event) (response, error) {
	out := response{Buttons: menuButtons()}
	if event.Problem == "foreign_message" {
		return response{Text: "仅限发起者操作。"}, nil
	}
	if event.CallbackID != "" && event.Private && !event.Protected {
		out.Previous = event.MessageID
	}
	for _, c := range commands {
		if c.Name == event.Command && c.Private && !event.Private {
			out.Text = "请在私聊中使用此命令。"
			return out, nil
		}
	}
	op := event.Command
	if op == "" {
		op = "save"
	}
	if op == "help" || op == "start" {
		out.Text = "发送支持的平台链接保存内容（每次最多 200 个）。"
		for _, c := range commands {
			if !event.Private && c.Private {
				continue
			}
			out.Text += "\n/" + c.Name + " — " + c.Description
		}
		if op == "start" {
			out.Text += "\n\n版本："
			out.Entities = append(out.Entities, telegram.Entity{Type: "code", Offset: len(utf16.Encode([]rune(out.Text))), Length: len(utf16.Encode([]rune(buildinfo.Version())))})
			out.Text += buildinfo.Version()
		}
		if op == "start" && r.Config.WebURL != "" {
			out.Previous = 0
			out.Buttons = append(out.Buttons, []telegram.Button{{Text: "打开", WebApp: &telegram.WebAppInfo{URL: r.Config.WebURL}}})
		}
		return out, nil
	}
	if op == "account_add" {
		return r.accountWebResponse(event), nil
	}
	if op == "save" && len(event.URLs) > 200 {
		out.Text = "每次最多 200 个链接。"
		return out, nil
	}
	v, e := r.API.Action(ctx, w, op)
	if e != nil {
		return out, e
	}
	switch op {
	case "list":
		out.Buttons = nil
		if v.Page != nil {
			for i, a := range v.Page.Items {
				if i > 0 {
					out.Text += "\n\n"
				}
				out.Text += fmt.Sprintf("%d. ", i+1)
				summary := collectionListSummary(a.Summary, a.Text)
				out.Entities = append(out.Entities, telegram.Entity{Type: "text_link", Offset: len(utf16.Encode([]rune(out.Text))), Length: len(utf16.Encode([]rune(summary))), URL: a.URL})
				out.Text += summary
				out.Buttons = append(out.Buttons, []telegram.Button{{Text: fmt.Sprintf("查看第%d条", i+1), Data: "/show " + a.ID}, {Text: "原文", URL: a.URL}})
			}
			var nav []telegram.Button
			if v.Page.PreviousCursor != "" {
				nav = append(nav, telegram.Button{Text: "← 上一页", Data: "/list " + v.Page.PreviousCursor})
			}
			if v.Page.NextCursor != "" {
				nav = append(nav, telegram.Button{Text: "下一页 →", Data: "/list " + v.Page.NextCursor})
			}
			if len(nav) > 0 {
				out.Buttons = append(out.Buttons, nav)
			}
		}
		if out.Text == "" {
			out.Text = "暂无收藏。"
		}
	case "usage":
		if v.Usage != nil {
			out.Text = usageText(*v.Usage)
		}
	case "status":
		if v.Job != nil {
			out.Text = jobState(v.Job.State) + "\n" + v.Job.Error
			out.Buttons = telegram.Keyboard{{{Text: "更新状态", Data: "/status " + v.Job.ID}}}
			if v.Job.State == "complete" || v.Job.State == "partial" {
				out.Buttons = append(out.Buttons, []telegram.Button{{Text: "查看收藏", Data: "/show " + v.Job.CollectionID}})
			}
		}
	case "save":
		if v.Count == 0 && len(v.Errors) == 0 && event.Private {
			out.Text = "请发送支持的链接，或使用 /help。"
		}
		out.Text += strings.Join(v.Errors, "\n")
		out.Previous = 0
	case "save_shared":
		out.Toast = "已保存。"
		out.Previous = 0
	case "collection_stop":
		out.Text = "已中止。"
		out.Previous = 0
	case "delete":
		out.Text = "已删除。"
		out.Previous = 0
	case "delete_all":
		if v.Code == "confirm_delete_all" {
			out.Text = "删除你保存的全部收藏？"
			out.Buttons = telegram.Keyboard{{{Text: "确认删除全部", Data: "/delete_all confirm"}, {Text: "取消", Data: "/help"}}}
		} else {
			out.Text = fmt.Sprintf("已删除 %d 条保存记录。", v.Count)
			out.Previous = 0
		}
	case "more", "more1000", "page_retry":
		if v.Code == "no_more" {
			out.Text = "没有更多帖子了。"
		}
	case "account", "account_delete":
		out = r.accountResponse(event, v)
	}
	return out, nil
}

func (r *Runner) accountResponse(event channelapi.Event, v channelapi.Result) response {
	out := response{Buttons: telegram.Keyboard{{{Text: "返回账号列表", Data: "/account"}}}}
	switch v.Code {
	case "confirm_account_delete":
		out.Text = "删除采集账号 " + v.Account.Name + "？"
		out.Buttons = telegram.Keyboard{{{Text: "确认删除", Data: "/account_delete confirm:" + v.Account.ID}, {Text: "取消", Data: "/account"}}}
	case "account_deleted":
		out.Text = "账号已删除。"
	default:
		out.Text = "选择采集来源。"
		out.Buttons = nil
		canAdd := false
		if v.Accounts != nil {
			for _, p := range v.Accounts.Platforms {
				canAdd = canAdd || p.CanAdd
				if !p.Public && p.Selected == "" {
					out.Text += "\n" + p.Name + " 需要添加并选择自己的账号凭据后才能采集。"
				}
				if p.Public {
					label := p.Name + " · 公共来源"
					if p.Selected == "" {
						label = "✓ " + label
					}
					out.Buttons = append(out.Buttons, []telegram.Button{{Text: label, Data: "/account public:" + p.ID}})
				}
			}
			for _, a := range v.Accounts.Accounts {
				label := a.Name
				if a.Username != "" {
					label = "@" + strings.TrimPrefix(a.Username, "@")
					if a.Name != "" {
						label += " · " + a.Name
					}
				}
				if a.Selected {
					label = "✓ " + label
				}
				if a.State != "ready" {
					label += "（需重新授权）"
				}
				row := []telegram.Button{{Text: label, Data: "/account " + a.ID}}
				if event.Private {
					row = append(row, telegram.Button{Text: "删除", Data: "/account_delete " + a.ID})
				}
				out.Buttons = append(out.Buttons, row)
			}
		}
		if button := r.accountsButton(); canAdd && event.Private && button != nil {
			out.Buttons = append(out.Buttons, []telegram.Button{*button})
		}
	}
	return out
}

// accountWebResponse answers the retired /account_add command and its old
// buttons: credentials are entered on the web, never in the chat.
func (r *Runner) accountWebResponse(event channelapi.Event) response {
	out := response{Text: "在网页中添加采集账号。", Buttons: telegram.Keyboard{{{Text: "返回账号列表", Data: "/account"}}}}
	if event.Credential != "" {
		out.Text = "不要在聊天中发送凭据。在网页中添加采集账号。"
	}
	if !event.Private {
		out.Text = "在私聊中打开网页添加采集账号。"
		return out
	}
	if button := r.accountsButton(); button != nil {
		out.Buttons = append(telegram.Keyboard{{*button}}, out.Buttons...)
	} else {
		out.Text = "未配置网页入口。"
	}
	return out
}

func (r *Runner) accountsButton() *telegram.Button {
	entry, err := url.Parse(r.Config.WebURL)
	if r.Config.WebURL == "" || err != nil || entry.Scheme != "https" || entry.Host == "" {
		return nil
	}
	entry.Fragment = "/accounts"
	return &telegram.Button{Text: "添加账号", WebApp: &telegram.WebAppInfo{URL: entry.String()}}
}
