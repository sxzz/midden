package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	replyTo  int64
	codeText string
	entities []Entity
	caption  string
	BotID    string
	Cache    domain.ChannelMediaCache
	Username string
	Token    string
	Base     string
	HTTP     *http.Client
	Blobs    blob.Storage
}
type APIError struct {
	Code        int
	RetryAfter  time.Duration
	InvalidFile bool
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
		return &APIError{Code: e.Code, RetryAfter: time.Duration(e.RetryAfter) * time.Second, InvalidFile: invalidFileReference(e.Message)}
	}
	return fmt.Errorf("telegram transport failed")
}

func (c *Client) Me(ctx context.Context) (string, error) {
	u, e := c.sdk(ctx).GetMe()
	if e == nil {
		c.Username = u.UserName
		c.BotID = strconv.FormatInt(u.ID, 10)
	}
	return strconv.FormatInt(u.ID, 10), apiError(e)
}

type Entity struct {
	Type   string `json:"type"`
	Offset int    `json:"offset"`
	Length int    `json:"length"`
	URL    string `json:"url"`
}

type Message struct {
	SenderChat *struct {
		ID int64 `json:"id"`
	} `json:"sender_chat,omitempty"`
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

// ActorMessage derives identity from the actor. Group ownership remains with the individual actor.
func (u Update) ActorMessage() *Message {
	m := u.Message
	if u.Callback != nil {
		q := u.Callback
		if q.Message == nil || q.From.Bot {
			return nil
		}
		copy := *q.Message
		copy.From.ID = q.From.ID
		copy.From.Bot = q.From.Bot
		copy.SenderChat = nil
		m = &copy
	}
	if m == nil || m.From.Bot || m.From.ID <= 0 || m.SenderChat != nil {
		return nil
	}
	switch m.Chat.Type {
	case "private":
		if m.Chat.ID != m.From.ID {
			return nil
		}
	case "group", "supergroup":
		if m.Chat.ID >= 0 {
			return nil
		}
	default:
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

type WebAppInfo struct {
	URL string `json:"url"`
}

type Button struct {
	WebApp *WebAppInfo `json:"web_app,omitempty"`
	Text   string      `json:"text"`
	Data   string      `json:"callback_data,omitempty"`
	URL    string      `json:"url,omitempty"`
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
	// The SDK helper turns an empty variadic list into nil. Telegram requires an array,
	// including [] when editing a message to remove its inline keyboard.
	return tg.InlineKeyboardMarkup{InlineKeyboard: rows}
}

// WithReplyTo binds a copy to one request without changing the shared bot client.
func (c *Client) WithReplyTo(messageID int64) *Client {
	copy := *c
	copy.replyTo = messageID
	return &copy
}

// WithCode formats only the specified literal, leaving archived text untouched.
func (c *Client) WithCode(text string) *Client {
	copy := *c
	copy.codeText = text
	return &copy
}

// WithEntities adds literal-text formatting without interpreting user text as markup.
func (c *Client) WithEntities(entities []Entity) *Client {
	copy := *c
	copy.entities = append([]Entity(nil), entities...)
	return &copy
}

func (c *Client) textEntities(text string) []tg.MessageEntity {
	var result []tg.MessageEntity
	size := len(utf16.Encode([]rune(text)))
	for _, e := range c.entities {
		if e.Offset >= 0 && e.Length > 0 && e.Offset <= size-e.Length {
			result = append(result, tg.MessageEntity{Type: e.Type, Offset: e.Offset, Length: e.Length, URL: e.URL})
		}
	}
	if c.codeText != "" {
		if offset := strings.Index(text, c.codeText); offset >= 0 {
			result = append(result, tg.MessageEntity{Type: "code", Offset: len(utf16.Encode([]rune(text[:offset]))), Length: len(utf16.Encode([]rune(c.codeText)))})
		}
	}
	return result
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
		cfg.Entities = c.textEntities(text)
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
	cfg.Entities = c.textEntities(text)
	cfg.ReplyToMessageID = int(c.replyTo)
	cfg.DisableWebPagePreview = true
	cfg.ReplyMarkup = markup(buttons)
	for _, row := range buttons {
		for _, button := range row {
			if button.WebApp != nil {
				cfg.ReplyMarkup = map[string]any{"inline_keyboard": buttons}
			}
		}
	}
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
	return c.AnswerToast(ctx, id, "")
}

func (c *Client) AnswerToast(ctx context.Context, id, text string) error {
	_, e := c.sdk(ctx).Request(tg.NewCallback(id, text))
	return apiError(e)
}

func (c *Client) MediaItem(ctx context.Context, chat string, a domain.Asset) (int64, error) {
	id, e := c.upload(ctx, chat, a, false)
	var x *APIError
	if errors.Is(e, errVideoMetadata) || (errors.As(e, &x) && x.Code == 400) {
		return c.upload(ctx, chat, a, true)
	}
	return id, e
}

func (c *Client) upload(ctx context.Context, chat string, a domain.Asset, document bool) (int64, error) {
	return c.uploadAttempt(ctx, chat, a, document, true)
}

func (c *Client) uploadAttempt(ctx context.Context, chat string, a domain.Asset, document, useCache bool) (int64, error) {
	p, e := c.prepareFile(ctx, a, mediaKind(a, document), useCache)
	if e != nil {
		if errors.Is(e, errVideoMetadata) {
			return 0, errVideoMetadata
		}
		return 0, fmt.Errorf("archived media unavailable")
	}
	defer p.close()
	var m tg.Message
	e = c.sendMedia(ctx, chat, []domain.Asset{a}, []preparedFile{p}, &m)
	var api *APIError
	if errors.As(e, &api) && api.Code == 400 && api.InvalidFile && p.cachedID != "" {
		c.forgetFile(ctx, a, p)
		return c.uploadAttempt(ctx, chat, a, document, false)
	}
	if e == nil {
		c.rememberFile(ctx, a, p.kind, m)
	}
	return int64(m.MessageID), e
}

func (c *Client) Media(ctx context.Context, chat string, assets []domain.Asset, caption string) (int64, error) {
	copy := *c
	copy.caption = caption
	c = &copy
	if len(assets) == 1 {
		return c.MediaItem(ctx, chat, assets[0])
	}
	if len(assets) < 2 || len(assets) > 10 {
		return 0, fmt.Errorf("invalid album size")
	}
	document := false
	for _, a := range assets {
		if a.MIME == "video/webm" {
			document = true
		}
	}
	id, e := c.album(ctx, chat, assets, document)
	var x *APIError
	if errors.Is(e, errVideoMetadata) || (errors.As(e, &x) && x.Code == 400) {
		return c.album(ctx, chat, assets, true)
	}
	return id, e
}

func (c *Client) album(ctx context.Context, chat string, assets []domain.Asset, document bool) (int64, error) {
	return c.albumAttempt(ctx, chat, assets, document, true)
}

func (c *Client) albumAttempt(ctx context.Context, chat string, assets []domain.Asset, document, useCache bool) (int64, error) {
	var prepared []preparedFile
	defer func() {
		for _, p := range prepared {
			p.close()
		}
	}()
	for _, a := range assets {
		p, e := c.prepareFile(ctx, a, mediaKind(a, document), useCache)
		if e != nil {
			if errors.Is(e, errVideoMetadata) {
				return 0, errVideoMetadata
			}
			return 0, fmt.Errorf("archived media unavailable")
		}
		prepared = append(prepared, p)
	}
	var messages []tg.Message
	e := c.sendMedia(ctx, chat, assets, prepared, &messages)
	if e != nil {
		var api *APIError
		if errors.As(e, &api) && api.Code == 400 && api.InvalidFile {
			cached := false
			for i, p := range prepared {
				if p.cachedID != "" {
					cached = true
					c.forgetFile(ctx, assets[i], p)
				}
			}
			if cached {
				return c.albumAttempt(ctx, chat, assets, document, false)
			}
		}
		return 0, apiError(e)
	}
	if len(messages) == 0 {
		return 0, fmt.Errorf("empty telegram album response")
	}
	if len(messages) == len(assets) {
		for i, m := range messages {
			c.rememberFile(ctx, assets[i], prepared[i].kind, m)
		}
	}
	return int64(messages[0].MessageID), nil
}

func extension(m string) string {
	switch m {
	case "video/webm":
		return ".webm"
	case "video/mp4":
		return ".mp4"
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
	return decodeResponse(response, err, out)
}

func decodeResponse(response *tg.APIResponse, err error, out any) error {
	if err != nil {
		if response != nil && response.ErrorCode != 0 {
			retry := time.Duration(0)
			if response.Parameters != nil {
				retry = time.Duration(response.Parameters.RetryAfter) * time.Second
			}
			return &APIError{Code: response.ErrorCode, RetryAfter: retry, InvalidFile: invalidFileReference(response.Description)}
		}
		return apiError(err)
	}
	if err = json.Unmarshal(response.Result, out); err != nil {
		return fmt.Errorf("invalid telegram response")
	}
	return nil
}

type Command = tg.BotCommand

func (c *Client) ConfigureCommands(ctx context.Context, commands, groupCommands []Command) error {
	_, err := c.sdk(ctx).Request(tg.NewSetMyCommands(commands...))
	if err != nil {
		return apiError(err)
	}
	_, err = c.sdk(ctx).Request(tg.NewSetMyCommandsWithScope(tg.NewBotCommandScopeAllGroupChats(), groupCommands...))
	return apiError(err)
}

func (c *Client) SetButtons(ctx context.Context, chat string, messageID int64, buttons Keyboard) error {
	id, err := strconv.ParseInt(chat, 10, 64)
	if err != nil {
		return err
	}
	_, err = c.sdk(ctx).Request(tg.NewEditMessageReplyMarkup(id, int(messageID), markup(buttons)))
	var api *tg.Error
	if errors.As(err, &api) && api.Code == 400 && strings.Contains(api.Message, "message is not modified") {
		return nil
	}
	return apiError(err)
}

func (c *Client) DeleteProgress(ctx context.Context, chat string, messageID int64) error {
	id, err := strconv.ParseInt(chat, 10, 64)
	if err != nil {
		return err
	}
	_, err = c.sdk(ctx).Request(tg.NewDeleteMessage(id, int(messageID)))
	var api *tg.Error
	if errors.As(err, &api) && api.Code == 400 && strings.Contains(api.Message, "message to delete not found") {
		return nil
	}
	return apiError(err)
}

// SplitCaption leaves a complete UTF-16 character at the caption boundary.
func SplitCaption(text string) (string, string) {
	units := 0
	for offset, r := range text {
		size := 1
		if r > 0xffff {
			size = 2
		}
		if units+size > 1024 {
			return text[:offset], text[offset:]
		}
		units += size
	}
	return text, ""
}

// ConfigureWebMenu changes only the private-chat menu, leaving commands available.
func (c *Client) ConfigureWebMenu(ctx context.Context, address string) error {
	menu := map[string]any{"type": "commands"}
	if address != "" {
		menu = map[string]any{"type": "web_app", "text": "打开归档库", "web_app": map[string]string{"url": address}}
	}
	raw, e := json.Marshal(menu)
	if e != nil {
		return e
	}
	_, e = c.sdk(ctx).MakeRequest("setChatMenuButton", tg.Params{"menu_button": string(raw)})
	return apiError(e)
}
