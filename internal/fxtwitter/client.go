package fxtwitter

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

type Client struct {
	HTTP     *http.Client
	Endpoint string
}

// Text retrieves only the requested post's text, never a quoted post or image alt text.
func (c *Client) Text(ctx context.Context, id string) (string, error) {
	endpoint := c.Endpoint
	if endpoint == "" {
		endpoint = "https://api.fxtwitter.com/status/"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(endpoint, "/")+"/"+url.PathEscape(id), nil)
	if err != nil {
		return "", fmt.Errorf("invalid text endpoint")
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Monitor/0.2")
	response, err := c.HTTP.Do(req)
	if err != nil {
		return "", fmt.Errorf("text source request failed")
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("text source unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, (2<<20)+1))
	if err != nil || len(body) > 2<<20 {
		return "", fmt.Errorf("invalid text response")
	}
	var data struct {
		Code  int `json:"code"`
		Tweet *struct {
			ID   string  `json:"id"`
			Text *string `json:"text"`
		} `json:"tweet"`
	}
	if json.Unmarshal(body, &data) != nil || data.Code != 200 || data.Tweet == nil || data.Tweet.ID != id || data.Tweet.Text == nil {
		return "", fmt.Errorf("invalid text response")
	}
	return strings.TrimSpace(*data.Tweet.Text), nil
}
