package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	tg "github.com/go-telegram-bot-api/telegram-bot-api/v5"

	"monitor/internal/blob"
	"monitor/internal/domain"
)

type Client struct {
	Token string
	Base  string
	HTTP  *http.Client
	Blobs blob.Storage
}
type APIError struct {
	Code       int
	RetryAfter time.Duration
}

func (e *APIError) Error() string { return fmt.Sprintf("telegram API error %d", e.Code) }

// Attach cancellation to SDK requests and never expose token-bearing transport errors.
type contextClient struct {
	ctx    context.Context
	client *http.Client
}

func (c contextClient) Do(r *http.Request) (*http.Response, error) {
	if r.Body != nil {
		defer r.Body.Close()
	}
	return c.client.Do(r.WithContext(c.ctx))
}

func (c *Client) sdk(ctx context.Context) *tg.BotAPI {
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 75 * time.Second}
	}
	b := &tg.BotAPI{Token: c.Token, Client: contextClient{ctx, client}}
	base := c.Base
	if base == "" {
		base = "https://api.telegram.org"
	}
	b.SetAPIEndpoint(base + "/bot%s/%s")
	return b
}

func apiError(err error) error {
	if err == nil {
		return nil
	}
	var existing *APIError
	if errors.As(err, &existing) {
		return existing
	}
	var e *tg.Error
	if errors.As(err, &e) {
		return &APIError{e.Code, time.Duration(e.RetryAfter) * time.Second}
	}
	return fmt.Errorf("telegram transport failed")
}

func (c *Client) Me(ctx context.Context) (string, error) {
	u, e := c.sdk(ctx).GetMe()
	return strconv.FormatInt(u.ID, 10), apiError(e)
}

type Entity struct {
	Type   string `json:"type"`
	Offset int    `json:"offset"`
	Length int    `json:"length"`
	URL    string `json:"url"`
}

type Message struct {
	ID   int64 `json:"message_id"`
	From struct {
		ID  int64 `json:"id"`
		Bot bool  `json:"is_bot"`
	} `json:"from"`
	Chat struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"chat"`
	Text            string   `json:"text"`
	Caption         string   `json:"caption"`
	Entities        []Entity `json:"entities"`
	CaptionEntities []Entity `json:"caption_entities"`
}

type Update struct {
	ID       int64     `json:"update_id"`
	Message  *Message  `json:"message"`
	Callback *Callback `json:"callback_query,omitempty"`
}

type Callback struct {
	ID   string `json:"id"`
	From struct {
		ID  int64 `json:"id"`
		Bot bool  `json:"is_bot"`
	} `json:"from"`
	Message *Message `json:"message"`
	Data    string   `json:"data"`
}

// PrivateMessage derives identity from the actor, never from callback data.
func (u Update) PrivateMessage() *Message {
	m := u.Message
	if u.Callback != nil {
		q := u.Callback
		if q.Message == nil || q.From.Bot || q.Message.Chat.ID != q.From.ID {
			return nil
		}
		copy := *q.Message
		copy.From.ID = q.From.ID
		copy.From.Bot = q.From.Bot
		m = &copy
	}
	if m == nil || m.Chat.Type != "private" || m.From.Bot || m.Chat.ID != m.From.ID {
		return nil
	}
	return m
}

func (c *Client) Updates(ctx context.Context, offset int64) ([]Update, error) {
	cfg := tg.NewUpdate(int(offset))
	cfg.Timeout = 30
	cfg.Limit = 100
	cfg.AllowedUpdates = []string{"message", "callback_query"}
	updates, e := c.sdk(ctx).GetUpdates(cfg)
	if e != nil {
		return nil, apiError(e)
	}
	raw, e := json.Marshal(updates)
	if e != nil {
		return nil, e
	}
	var out []Update
	e = json.Unmarshal(raw, &out)
	return out, e
}

type Button struct {
	Text string `json:"text"`
	Data string `json:"callback_data,omitempty"`
	URL  string `json:"url,omitempty"`
}
type Keyboard [][]Button

func markup(buttons Keyboard) tg.InlineKeyboardMarkup {
	rows := make([][]tg.InlineKeyboardButton, 0, len(buttons))
	for _, row := range buttons {
		r := []tg.InlineKeyboardButton{}
		for _, b := range row {
			if b.URL != "" {
				r = append(r, tg.NewInlineKeyboardButtonURL(b.Text, b.URL))
			} else {
				r = append(r, tg.NewInlineKeyboardButtonData(b.Text, b.Data))
			}
		}
		rows = append(rows, r)
	}
	return tg.NewInlineKeyboardMarkup(rows...)
}

func (c *Client) Send(ctx context.Context, chat, text string, previous int64) (int64, error) {
	return c.SendInteractive(ctx, chat, text, previous, nil)
}

func (c *Client) SendInteractive(ctx context.Context, chat, text string, previous int64, buttons Keyboard) (int64, error) {
	id, e := strconv.ParseInt(chat, 10, 64)
	if e != nil {
		return 0, fmt.Errorf("invalid chat")
	}
	b := c.sdk(ctx)
	if previous != 0 {
		cfg := tg.NewEditMessageTextAndMarkup(id, int(previous), text, markup(buttons))
		cfg.DisableWebPagePreview = true
		m, err := b.Send(cfg)
		if err == nil {
			return int64(m.MessageID), nil
		}
		var a *tg.Error
		if errors.As(err, &a) && a.Code == 400 {
			if strings.Contains(a.Message, "message is not modified") {
				return previous, nil
			}
			if strings.Contains(a.Message, "message to edit not found") || strings.Contains(a.Message, "message can't be edited") {
				return c.SendInteractive(ctx, chat, text, 0, buttons)
			}
		}
		return 0, apiError(err)
	}
	cfg := tg.NewMessage(id, text)
	cfg.DisableWebPagePreview = true
	cfg.ReplyMarkup = markup(buttons)
	m, e := b.Send(cfg)
	return int64(m.MessageID), apiError(e)
}

func (c *Client) Action(ctx context.Context, chat, action string) error {
	id, e := strconv.ParseInt(chat, 10, 64)
	if e != nil {
		return e
	}
	_, e = c.sdk(ctx).Request(tg.NewChatAction(id, action))
	return apiError(e)
}

func (c *Client) Answer(ctx context.Context, id string) error {
	_, e := c.sdk(ctx).Request(tg.NewCallback(id, ""))
	return apiError(e)
}

func (c *Client) Image(ctx context.Context, chat string, a domain.Asset) (int64, error) {
	id, e := c.upload(ctx, chat, a, false)
	var x *APIError
	if errors.As(e, &x) && x.Code == 400 {
		return c.upload(ctx, chat, a, true)
	}
	return id, e
}

func (c *Client) upload(ctx context.Context, chat string, a domain.Asset, document bool) (int64, error) {
	id, e := strconv.ParseInt(chat, 10, 64)
	if e != nil {
		return 0, e
	}
	r, e := c.Blobs.Get(ctx, a.Key)
	if e != nil {
		return 0, fmt.Errorf("archived image unavailable")
	}
	defer r.Close()
	file := tg.FileReader{Name: a.Hash + extension(a.MIME), Reader: r}
	var cfg tg.Chattable = tg.NewPhoto(id, file)
	if document {
		cfg = tg.NewDocument(id, file)
	}
	var m tg.Message
	e = c.request(ctx, cfg, &m)
	return int64(m.MessageID), e
}

func (c *Client) Images(ctx context.Context, chat string, assets []domain.Asset) (int64, error) {
	if len(assets) == 1 {
		return c.Image(ctx, chat, assets[0])
	}
	if len(assets) < 2 || len(assets) > 10 {
		return 0, fmt.Errorf("invalid album size")
	}
	id, e := c.album(ctx, chat, assets, false)
	var x *APIError
	if errors.As(e, &x) && x.Code == 400 {
		return c.album(ctx, chat, assets, true)
	}
	return id, e
}

func (c *Client) album(ctx context.Context, chat string, assets []domain.Asset, document bool) (int64, error) {
	id, e := strconv.ParseInt(chat, 10, 64)
	if e != nil {
		return 0, e
	}
	files := []interface{}{}
	var readers []io.ReadCloser
	defer func() {
		for _, r := range readers {
			r.Close()
		}
	}()
	for _, a := range assets {
		r, e := c.Blobs.Get(ctx, a.Key)
		if e != nil {
			return 0, fmt.Errorf("archived image unavailable")
		}
		readers = append(readers, r)
		file := tg.FileReader{Name: a.Hash + extension(a.MIME), Reader: r}
		if document {
			files = append(files, tg.NewInputMediaDocument(file))
		} else {
			files = append(files, tg.NewInputMediaPhoto(file))
		}
	}
	var messages []tg.Message
	e = c.request(ctx, tg.NewMediaGroup(id, files), &messages)
	if e != nil {
		return 0, apiError(e)
	}
	if len(messages) == 0 {
		return 0, fmt.Errorf("empty telegram album response")
	}
	return int64(messages[0].MessageID), nil
}

func extension(m string) string {
	switch m {
	case "image/png":
		return ".png"
	case "image/webp":
		return ".webp"
	default:
		return ".jpg"
	}
}

func URLs(m *Message) []string {
	out := []string{}
	extract := func(text string, entities []Entity) {
		units := utf16.Encode([]rune(text))
		for _, e := range entities {
			switch e.Type {
			case "text_link":
				out = append(out, e.URL)
			case "url":
				if e.Offset >= 0 && e.Length > 0 && e.Offset+e.Length <= len(units) {
					out = append(out, string(utf16.Decode(units[e.Offset:e.Offset+e.Length])))
				}
			}
		}
		for _, w := range strings.Fields(text) {
			w = strings.Trim(w, "<>[]()，。！,!")
			if strings.HasPrefix(w, "https://") || strings.HasPrefix(w, "http://") {
				out = append(out, w)
			}
		}
	}
	extract(m.Text, m.Entities)
	extract(m.Caption, m.CaptionEntities)
	return out
}

// Split uses Telegram's UTF-16 length units and does not split surrogate pairs.
func Split(s string) []string {
	out := []string{}
	var b strings.Builder
	n := 0
	for _, r := range s {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if n+size > 3500 {
			out = append(out, b.String())
			b.Reset()
			n = 0
		}
		b.WriteRune(r)
		n += size
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

// v5.5.1 omits Error.Code on uploads; retain it from the SDK response envelope.
func (c *Client) request(ctx context.Context, cfg tg.Chattable, out any) error {
	response, err := c.sdk(ctx).Request(cfg)
	if err != nil {
		if response != nil && response.ErrorCode != 0 {
			retry := time.Duration(0)
			if response.Parameters != nil {
				retry = time.Duration(response.Parameters.RetryAfter) * time.Second
			}
			return &APIError{response.ErrorCode, retry}
		}
		return apiError(err)
	}
	if err = json.Unmarshal(response.Result, out); err != nil {
		return fmt.Errorf("invalid telegram response")
	}
	return nil
}

type Command = tg.BotCommand

func (c *Client) ConfigureCommands(ctx context.Context, commands []Command) error {
	_, err := c.sdk(ctx).Request(tg.NewSetMyCommands(commands...))
	return apiError(err)
}
