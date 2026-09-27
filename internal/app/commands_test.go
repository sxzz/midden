package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"monitor/internal/telegram"
)

func TestRegisteredCommandDrivesMenuHelpAndRouting(t *testing.T) {
	original := channelCommands
	t.Cleanup(func() { channelCommands = original })
	channelCommands = append(append([]channelCommand{}, original...), channelCommand{
		Name: "probe", Description: "测试注册命令", Callback: true, Validate: noArgument,
		Handle: func(_ *Service, _ context.Context, r *commandRequest) error { r.Text = "handled"; return nil },
	})
	h := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "setMyCommands") {
			t.Error("wrong SDK method")
		}
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		var commands []telegram.Command
		if err := json.Unmarshal([]byte(r.Form.Get("commands")), &commands); err != nil {
			t.Error(err)
		}
		found := false
		recent := false
		start, save := false, false
		for _, c := range commands {
			if c.Command == "start" {
				start = true
			}
			if c.Command == "save" {
				save = true
			}
			if c.Command == "recent" {
				recent = true
			}
			if c.Command == "probe" && c.Description == "测试注册命令" {
				found = true
			}
		}
		group := strings.Contains(r.Form.Get("scope"), "all_group_chats")
		if start == group || !save {
			t.Error("incorrect start/save menu scope")
		}
		if recent == group {
			t.Error("incorrect recent availability", r.Form.Get("scope"))
		}
		if !found {
			t.Error("new registered command missing from Telegram menu")
		}
		w.Write([]byte(`{"ok":true,"result":true}`))
	}))
	defer h.Close()
	c := telegram.Client{Token: "test", Base: h.URL, HTTP: h.Client()}
	if err := c.ConfigureCommands(context.Background(), TelegramCommands(false), TelegramCommands(true)); err != nil {
		t.Fatal(err)
	}
	command, ok := lookupCommand("/probe")
	if !ok || !validCallback("/probe") {
		t.Fatal("new command not routed")
	}
	var service Service
	request := &commandRequest{}
	if err := command.Handle(&service, context.Background(), request); err != nil || request.Text != "handled" {
		t.Fatal("wrong handler", err)
	}
	if err := service.commandHelp(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(request.Text, "/probe — 测试注册命令") {
		t.Fatal("new command missing from help")
	}
	request.Origin.ChatID = "-42"
	if err := service.commandHelp(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(request.Text, "/recent") || !strings.Contains(request.Text, "/show") {
		t.Fatal("incorrect group help", request.Text)
	}
}

func TestSaveCommandGuidance(t *testing.T) {
	c, ok := lookupCommand("/save")
	if !ok || c.Callback || !c.Validate("https://x.com/a/status/20 https://x.com/a/status/21") {
		t.Fatal("save registration")
	}
	r := &commandRequest{Message: &telegram.Message{Text: "/save"}}
	if err := c.Handle(&Service{}, context.Background(), r); err != nil || !strings.Contains(r.Text, "帖子链接") {
		t.Fatal(r.Text, err)
	}
	var urls strings.Builder
	for i := 0; i < 201; i++ {
		fmt.Fprintf(&urls, "https://x.com/a/status/%d ", i+20)
	}
	r = &commandRequest{Message: &telegram.Message{Text: "/save " + urls.String()}}
	if err := c.Handle(&Service{}, context.Background(), r); err != nil || !strings.Contains(r.Text, "最多 200 个") {
		t.Fatal(r.Text, err)
	}
}

func TestArchiveListSummary(t *testing.T) {
	for _, tc := range []struct{ summary, text, want string }{
		{"作者：第一行\n第二行", "unused", "作者：第一行 第二行"},
		{"", "旧归档\n正文", "旧归档 正文"},
		{"", "", "无文字内容"},
		{strings.Repeat("字", 100), "", strings.Repeat("字", 100)},
		{strings.Repeat("🙂", 101), "", strings.Repeat("🙂", 99) + "…"},
	} {
		if got := archiveListSummary(tc.summary, tc.text); got != tc.want {
			t.Fatalf("got %q, want %q", got, tc.want)
		}
	}
}
