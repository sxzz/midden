package tgchannel

import (
	"encoding/base64"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"

	"monitor/internal/domain"

	"monitor/internal/channelapi"
	"monitor/internal/telegram"
)

type command struct {
	Name, Description, Usage string
	Private                  bool
}

var commands = []command{
	{"start", "开始使用", "", true},
	{"save", "保存帖子", "<帖子链接…>", false},
	{"list", "查看收藏列表", "[游标]", true},
	{"show", "查看指定收藏", "<收藏 ID>", false},
	{"status", "查看采集状态", "<任务 ID>", false},
	{"retry", "使用当前账号重试", "<收藏 ID>", false},
	{"refresh", "重新抓取帖子", "<收藏 ID>", false},
	{"delete", "删除", "<收藏 ID>", false},
	{"delete_all", "删除全部保存记录", "", false},
	{"account_add", "添加采集账号", "", true},
	{"account_cancel", "取消添加账号", "", true},
	{"account_delete", "删除采集账号", "[账号 ID]", true},
	{"account", "选择采集账号", "", false},
	{"usage", "查看存储用量", "", false},
	{"help", "查看使用帮助", "", false},
}

func Commands(group bool) []telegram.Command {
	var out []telegram.Command
	for _, v := range commands {
		if group && v.Private {
			continue
		}
		out = append(out, telegram.Command{Command: v.Name, Description: v.Description})
	}
	return out
}

func menuButtons() telegram.Keyboard {
	return telegram.Keyboard{{{Text: "收藏列表", Data: "/list"}, {Text: "存储用量", Data: "/usage"}}}
}

func Normalize(u telegram.Update, username string) channelapi.Event {
	out := channelapi.Event{UpdateID: u.ID}
	m := u.ActorMessage()
	if m == nil {
		return out
	}
	input := m.Text
	if u.Callback != nil {
		input = u.Callback.Data
		out.CallbackID = u.Callback.ID
	} else if m.Chat.ID < 0 {
		if !groupTrigger(m, username) {
			return out
		}
		var addressed bool
		input, addressed = m.AddressedText(username)
		if !addressed {
			return out
		}
		fields := strings.Fields(input)
		if len(fields) > 0 {
			parts := strings.SplitN(fields[0], "@", 2)
			if len(parts) == 2 && !strings.EqualFold(parts[1], username) {
				return out
			}
		}
	}
	out.Actor = strconv.FormatInt(m.From.ID, 10)
	out.ActorProfile = &channelapi.ActorProfile{FirstName: m.From.FirstName, LastName: m.From.LastName, Username: m.From.Username}
	out.Chat = strconv.FormatInt(m.Chat.ID, 10)
	out.MessageID = m.ID
	out.Private = m.Chat.Type == "private"
	out.Text = input
	out.URLs = telegram.URLs(m)
	fields := strings.Fields(input)
	if len(fields) > 0 && strings.HasPrefix(fields[0], "/") {
		out.Command = strings.TrimPrefix(strings.Split(fields[0], "@")[0], "/")
		out.Argument = strings.TrimSpace(strings.TrimPrefix(input, fields[0]))
	}
	if out.Command == "account_add" {
		f := strings.Fields(out.Argument)
		if len(f) > 0 && strings.HasPrefix(f[0], "@") {
			out.Adapter = strings.TrimPrefix(f[0], "@")
			f = f[1:]
		}
		if len(f) > 0 {
			out.Credential = f[0]
			out.Name = strings.Join(f[1:], " ")
		}
		out.Text = ""
		out.Argument = ""
		out.URLs = nil
	}
	if out.Command == "save" && u.Callback != nil && !strings.Contains(out.Argument, " ") {
		out.Command = "save_shared"
	}
	if u.Callback != nil && !validCallback(input) {
		out.Command = "help"
		out.Argument = ""
	}
	return out
}

func groupButtons(keys telegram.Keyboard) telegram.Keyboard {
	var out telegram.Keyboard
	for _, row := range keys {
		var kept []telegram.Button
		for _, b := range row {
			private := false
			for _, c := range commands {
				if c.Private && (b.Data == "/"+c.Name || strings.HasPrefix(b.Data, "/"+c.Name+" ")) {
					private = true
				}
			}
			if !private {
				kept = append(kept, b)
			}
		}
		if len(kept) > 0 {
			out = append(out, kept)
		}
	}
	return out
}

func buttonsForChat(chat string, keys telegram.Keyboard) telegram.Keyboard {
	if strings.HasPrefix(chat, "-") {
		return groupButtons(keys)
	}
	return keys
}

func groupTrigger(m *telegram.Message, username string) bool {
	text, addressed := m.AddressedText(username)
	if !addressed {
		return false
	}
	if fields := strings.Fields(text); len(fields) > 0 {
		parts := strings.SplitN(fields[0], "@", 2)
		if len(parts) == 2 && !strings.EqualFold(parts[1], username) {
			return false
		}
		for _, c := range commands {
			if parts[0] == "/"+c.Name {
				return true
			}
		}
	}
	for _, raw := range telegram.URLs(m) {
		if domain.ValidateURL(raw) == nil {
			return true
		}
	}
	return false
}

func validCallback(data string) bool {
	if len(data) > 64 {
		return false
	}
	f := strings.Fields(data)
	if len(f) < 1 || len(f) > 2 {
		return false
	}
	arg := ""
	if len(f) == 2 {
		arg = f[1]
	}
	id := func(s string) bool { _, e := uuid.Parse(s); return e == nil }
	adapter := func(s string) bool { return regexp.MustCompile(`^[a-zA-Z0-9_-]{1,32}$`).MatchString(s) }
	switch f[0] {
	case "/show", "/status", "/refresh", "/retry", "/delete", "/more", "/more1000", "/page_retry", "/collection_stop", "/save":
		return id(arg)
	case "/list":
		if arg == "" {
			return true
		}
		raw, e := base64.RawURLEncoding.DecodeString(arg)
		return e == nil && id(strings.TrimPrefix(string(raw), "p:"))
	case "/usage", "/help", "/account_cancel":
		return arg == ""
	case "/delete_all":
		return arg == "" || arg == "confirm"
	case "/account_add":
		return arg == "" || strings.HasPrefix(arg, "@") && adapter(strings.TrimPrefix(arg, "@"))
	case "/account_delete":
		return arg == "" || id(strings.TrimPrefix(arg, "confirm:"))
	case "/account":
		return arg == "" || arg == "public" || id(arg) || strings.HasPrefix(arg, "public:") && adapter(strings.TrimPrefix(arg, "public:"))
	}
	return false
}
