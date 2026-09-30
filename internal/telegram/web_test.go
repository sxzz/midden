package telegram

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiniAppEntrySerialization(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if e := r.ParseForm(); e != nil {
			t.Fatal(e)
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/setChatMenuButton") {
			var menu map[string]json.RawMessage
			if json.Unmarshal([]byte(r.Form.Get("menu_button")), &menu) != nil {
				t.Fatal("invalid menu")
			}
			var kind string
			json.Unmarshal(menu["type"], &kind)
			if calls == 1 && kind != "web_app" || calls == 2 && kind != "commands" {
				t.Fatal(kind)
			}
			w.Write([]byte(`{"ok":true,"result":true}`))
			return
		}
		var markup struct {
			Rows [][]Button `json:"inline_keyboard"`
		}
		if e := json.Unmarshal([]byte(r.Form.Get("reply_markup")), &markup); e != nil {
			t.Fatal(e)
		}
		if len(markup.Rows) != 1 || markup.Rows[0][0].WebApp == nil || markup.Rows[0][0].WebApp.URL != "https://collection.test/app/" {
			t.Fatal(markup)
		}
		w.Write([]byte(`{"ok":true,"result":{"message_id":42,"chat":{"id":1,"type":"private"}}}`))
	}))
	defer srv.Close()
	c := &Client{Token: "fixture", Base: srv.URL, HTTP: srv.Client()}
	for _, address := range []string{"https://collection.test/app/", ""} {
		if e := c.ConfigureWebMenu(context.Background(), address); e != nil {
			t.Fatal(e)
		}
	}
	if id, e := c.SendInteractive(context.Background(), "1", "打开", 0, Keyboard{{{Text: "打开", WebApp: &WebAppInfo{URL: "https://collection.test/app/"}}}}); e != nil || id != 42 {
		t.Fatal(id, e)
	}
	buttons := Keyboard{{{Text: "打开", WebApp: &WebAppInfo{URL: "https://collection.test/app/"}}}}
	if id, err := c.SendInteractive(context.Background(), "1", "updated", 42, buttons); err != nil || id != 42 {
		t.Fatal(id, err)
	}
	if err := c.SetButtons(context.Background(), "1", 42, buttons); err != nil {
		t.Fatal(err)
	}
	if calls != 5 {
		t.Fatalf("expected send, edit and markup requests; got %d calls", calls)
	}
}
