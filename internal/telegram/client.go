package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

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
func (c *Client) endpoint(method string) string {
	base := c.Base
	if base == "" {
		base = "https://api.telegram.org"
	}
	return base + "/bot" + c.Token + "/" + method
}

func (c *Client) call(ctx context.Context, method string, in any, out any) error {
	b, e := json.Marshal(in)
	if e != nil {
		return e
	}
	r, e := http.NewRequestWithContext(ctx, "POST", c.endpoint(method), bytes.NewReader(b))
	if e != nil {
		return fmt.Errorf("telegram request failed")
	}
	r.Header.Set("Content-Type", "application/json")
	res, e := c.HTTP.Do(r)
	if e != nil {
		return fmt.Errorf("telegram transport failed")
	}
	defer res.Body.Close()
	return decode(res.Body, out)
}

func decode(r io.Reader, out any) error {
	var env struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Code   int             `json:"error_code"`
		Params struct {
			Retry int `json:"retry_after"`
		} `json:"parameters"`
	}
	if e := json.NewDecoder(io.LimitReader(r, 8<<20)).Decode(&env); e != nil {
		return fmt.Errorf("invalid telegram response")
	}
	if !env.OK {
		return &APIError{env.Code, time.Duration(env.Params.Retry) * time.Second}
	}
	if out != nil {
		return json.Unmarshal(env.Result, out)
	}
	return nil
}

func (c *Client) Me(ctx context.Context) (string, error) {
	var out struct {
		ID int64 `json:"id"`
	}
	e := c.call(ctx, "getMe", map[string]any{}, &out)
	return strconv.FormatInt(out.ID, 10), e
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
	ID      int64    `json:"update_id"`
	Message *Message `json:"message"`
}

func (c *Client) Updates(ctx context.Context, offset int64) ([]Update, error) {
	var out []Update
	e := c.call(ctx, "getUpdates", map[string]any{"offset": offset, "timeout": 30, "limit": 100, "allowed_updates": []string{"message"}}, &out)
	return out, e
}

func (c *Client) Send(ctx context.Context, chat, text string, previous int64) (int64, error) {
	method := "sendMessage"
	in := map[string]any{"chat_id": chat, "text": text, "link_preview_options": map[string]bool{"is_disabled": true}}
	if previous != 0 {
		method = "editMessageText"
		in["message_id"] = previous
	}
	var out struct {
		ID int64 `json:"message_id"`
	}
	e := c.call(ctx, method, in, &out)
	if a, ok := e.(*APIError); ok && a.Code == 400 && previous != 0 { // Verify an ambiguous edit by sending a new status; duplicate delivery is permitted.
		return c.Send(ctx, chat, text, 0)
	}
	return out.ID, e
}

func (c *Client) Image(ctx context.Context, chat string, a domain.Asset) (int64, error) {
	id, e := c.upload(ctx, "sendPhoto", "photo", chat, a)
	if x, ok := e.(*APIError); ok && x.Code == 400 {
		return c.upload(ctx, "sendDocument", "document", chat, a)
	}
	return id, e
}

func (c *Client) upload(ctx context.Context, method, field, chat string, a domain.Asset) (int64, error) {
	r, e := c.Blobs.Get(ctx, a.Key)
	if e != nil {
		return 0, fmt.Errorf("archived image unavailable")
	}
	defer r.Close()
	reader, writer := io.Pipe()
	multi := multipart.NewWriter(writer)
	done := make(chan error, 1)
	go func() {
		err := multi.WriteField("chat_id", chat)
		if err == nil {
			var part io.Writer
			part, err = multi.CreateFormFile(field, a.Hash+extension(a.MIME))
			if err == nil {
				_, err = io.Copy(part, r)
			}
		}
		if err == nil {
			err = multi.Close()
		}
		writer.CloseWithError(err)
		done <- err
	}()
	req, e := http.NewRequestWithContext(ctx, "POST", c.endpoint(method), reader)
	if e != nil {
		reader.Close()
		<-done
		return 0, fmt.Errorf("telegram request failed")
	}
	req.Header.Set("Content-Type", multi.FormDataContentType())
	res, e := c.HTTP.Do(req)
	reader.Close()
	<-done
	if e != nil {
		return 0, fmt.Errorf("telegram upload failed")
	}
	defer res.Body.Close()
	var out struct {
		ID int64 `json:"message_id"`
	}
	e = decode(res.Body, &out)
	return out.ID, e
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

// Images sends one album (2–10 items), with a document-album fallback.
func (c *Client) Images(ctx context.Context, chat string, assets []domain.Asset) (int64, error) {
	if len(assets) == 1 {
		return c.Image(ctx, chat, assets[0])
	}
	if len(assets) < 2 || len(assets) > 10 {
		return 0, fmt.Errorf("invalid album size")
	}
	id, e := c.album(ctx, chat, assets, "photo")
	if a, ok := e.(*APIError); ok && a.Code == 400 {
		return c.album(ctx, chat, assets, "document")
	}
	return id, e
}

func (c *Client) album(ctx context.Context, chat string, assets []domain.Asset, kind string) (int64, error) {
	reader, writer := io.Pipe()
	multi := multipart.NewWriter(writer)
	done := make(chan error, 1)
	go func() {
		err := multi.WriteField("chat_id", chat)
		media := make([]map[string]string, len(assets))
		for i := range assets {
			media[i] = map[string]string{"type": kind, "media": fmt.Sprintf("attach://file%d", i)}
		}
		encoded, _ := json.Marshal(media)
		if err == nil {
			err = multi.WriteField("media", string(encoded))
		}
		for i, a := range assets {
			if err != nil {
				break
			}
			var r io.ReadCloser
			r, err = c.Blobs.Get(ctx, a.Key)
			if err != nil {
				break
			}
			var part io.Writer
			part, err = multi.CreateFormFile(fmt.Sprintf("file%d", i), a.Hash+extension(a.MIME))
			if err == nil {
				_, err = io.Copy(part, r)
			}
			r.Close()
		}
		if err == nil {
			err = multi.Close()
		}
		writer.CloseWithError(err)
		done <- err
	}()
	req, e := http.NewRequestWithContext(ctx, "POST", c.endpoint("sendMediaGroup"), reader)
	if e != nil {
		reader.Close()
		<-done
		return 0, fmt.Errorf("telegram request failed")
	}
	req.Header.Set("Content-Type", multi.FormDataContentType())
	res, e := c.HTTP.Do(req)
	reader.Close()
	<-done
	if e != nil {
		return 0, fmt.Errorf("telegram album upload failed")
	}
	defer res.Body.Close()
	var messages []struct {
		ID int64 `json:"message_id"`
	}
	if e = decode(res.Body, &messages); e != nil {
		return 0, e
	}
	if len(messages) == 0 {
		return 0, fmt.Errorf("empty telegram album response")
	}
	return messages[0].ID, nil
}
