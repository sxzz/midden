package tgchannel

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"monitor/internal/channelapi"
)

type Client struct {
	Base, Channel string
	HTTP          *http.Client
}
type APIError struct{ Status int }

func (e *APIError) Error() string { return fmt.Sprintf("core API returned %d", e.Status) }
func (c *Client) request(ctx context.Context, method, path, lease string, in any) (*http.Response, error) {
	var body io.Reader
	if in != nil {
		b, e := json.Marshal(in)
		if e != nil {
			return nil, e
		}
		body = bytes.NewReader(b)
	}
	req, e := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.Base, "/")+"/internal/v1/channels/"+url.PathEscape(c.Channel)+path, body)
	if e != nil {
		return nil, e
	}
	req.Header.Set("Content-Type", "application/json")
	if lease != "" {
		req.Header.Set("X-Work-Lease", lease)
	}
	client := c.HTTP
	if client == nil {
		client = &http.Client{Timeout: 5 * time.Minute}
	}
	r, e := client.Do(req)
	if e != nil {
		return nil, fmt.Errorf("core API unavailable")
	}
	if r.StatusCode >= 300 {
		r.Body.Close()
		return nil, &APIError{r.StatusCode}
	}
	return r, nil
}

func (c *Client) call(ctx context.Context, method, path, lease string, in, out any) error {
	r, e := c.request(ctx, method, path, lease, in)
	if e != nil {
		return e
	}
	defer r.Body.Close()
	if r.StatusCode == 204 {
		return nil
	}
	if out == nil {
		_, e = io.Copy(io.Discard, r.Body)
		return e
	}
	return json.NewDecoder(io.LimitReader(r.Body, 16<<20)).Decode(out)
}

func (c *Client) Config(ctx context.Context) (v channelapi.Config, e error) {
	e = c.call(ctx, "GET", "/config", "", nil, &v)
	return
}

func (c *Client) Event(ctx context.Context, v channelapi.Event) (bool, error) {
	var result struct {
		Delete bool `json:"delete_input"`
	}
	e := c.call(ctx, "POST", "/events", "", v, &result)
	return result.Delete, e
}

func (c *Client) Claim(ctx context.Context) (*channelapi.Work, error) {
	var v *channelapi.Work
	e := c.call(ctx, "POST", "/work/claim", "", nil, &v)
	return v, e
}

func (c *Client) Ack(ctx context.Context, w channelapi.Work, a channelapi.Ack) error {
	a.Lease = w.Lease
	return c.call(ctx, "POST", "/work/"+w.ID+"/ack", "", a, nil)
}

func (c *Client) Action(ctx context.Context, w channelapi.Work, name string) (v channelapi.Result, e error) {
	e = c.call(ctx, "POST", "/actions", "", channelapi.Action{WorkID: w.ID, Lease: w.Lease, Name: name}, &v)
	return
}

func (c *Client) Delivery(ctx context.Context, w channelapi.Work) (v channelapi.Delivery, e error) {
	e = c.call(ctx, "GET", "/work/"+w.ID+"/delivery", w.Lease, nil, &v)
	return
}

type mediaReader struct {
	client *Client
	work   channelapi.Work
}

func (m mediaReader) Get(ctx context.Context, id string) (io.ReadCloser, error) {
	r, e := m.client.request(ctx, "GET", "/work/"+m.work.ID+"/assets/"+url.PathEscape(id), m.work.Lease, nil)
	if e != nil {
		return nil, e
	}
	return r.Body, nil
}

func (c *Client) cachePath(a, b, d string) string {
	return "/media-cache?" + url.Values{"blob": {a}, "kind": {b}, "variant": {d}}.Encode()
}

func (c *Client) GetChannelMedia(ctx context.Context, bot, a, b, d string) (string, error) {
	var v struct {
		FileID string `json:"file_id"`
	}
	e := c.call(ctx, "GET", c.cachePath(b, d, ""), "", nil, &v)
	return v.FileID, e
}

func (c *Client) PutChannelMedia(ctx context.Context, bot, a, b, d, value string) error {
	return c.call(ctx, "PUT", c.cachePath(b, d, ""), "", map[string]string{"file_id": value}, nil)
}

func (c *Client) DeleteChannelMedia(ctx context.Context, bot, a, b, d, value string) error {
	return c.call(ctx, "DELETE", c.cachePath(b, d, ""), "", map[string]string{"file_id": value}, nil)
}
