package telegram

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"monitor/internal/domain"
)

func TestVideoDimensions(t *testing.T) {
	for _, tc := range []struct {
		raw           string
		width, height int
	}{
		{`{"Width":1920,"Height":1080,"sample_aspect_ratio":"1:1"}`, 1920, 1080},
		{`{"Width":720,"Height":576,"sample_aspect_ratio":"16:15"}`, 768, 576},
		{`{"Width":1920,"Height":1080,"side_data_list":[{"rotation":-90}]}`, 1080, 1920},
	} {
		var stream videoStream
		if err := json.Unmarshal([]byte(tc.raw), &stream); err != nil {
			t.Fatal(err)
		}
		w, h := stream.dimensions()
		if w != tc.width || h != tc.height {
			t.Fatal(w, h)
		}
	}
}

func TestVideoProbeAndCleanup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("TMPDIR", dir)
	p, err := prepareVideo(context.Background(), bytes.NewReader(testVideo), "test.mp4")
	if err != nil {
		t.Fatal(err)
	}
	if p.width != 192 || p.height != 108 {
		t.Fatal(p.width, p.height)
	}
	raw, err := io.ReadAll(p.closer.(temporaryVideo).File)
	if err != nil || !bytes.Equal(raw, testVideo) {
		t.Fatal("upload bytes changed", err)
	}
	p.close()
	_, err = prepareVideo(context.Background(), bytes.NewReader([]byte("invalid MP4")), "bad.mp4")
	if !errors.Is(err, errVideoMetadata) {
		t.Fatal(err)
	}
	files, err := os.ReadDir(dir)
	if err != nil || len(files) != 0 {
		t.Fatal("temporary files leaked", files, err)
	}
}

func TestUnprobeableVideoUsesDocument(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "sendDocument") {
			t.Error("video sent without dimensions", r.URL.Path)
		}
		if err := r.ParseMultipartForm(1 << 20); err != nil {
			t.Error(err)
		}
		defer r.MultipartForm.RemoveAll()
		if r.FormValue("caption") != "caption" {
			t.Error("caption lost")
		}
		fmt.Fprint(w, `{"ok":true,"result":{"message_id":1}}`)
	}))
	defer server.Close()
	c := Client{Token: "test", Base: server.URL, HTTP: server.Client(), Blobs: testBlob{}}
	_, err := c.Media(context.Background(), "42", []domain.Asset{{MIME: "video/mp4"}}, "caption")
	if err != nil {
		t.Fatal(err)
	}
}
