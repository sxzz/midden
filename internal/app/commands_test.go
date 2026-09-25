package app

import (
	"context"
	"encoding/json"
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
		for _, c := range commands {
			if c.Command == "recent" {
				recent = true
			}
			if c.Command == "probe" && c.Description == "测试注册命令" {
				found = true
			}
		}
		group := strings.Contains(r.Form.Get("scope"), "all_group_chats")
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
