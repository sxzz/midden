package app

import (
	"encoding/binary"
	"net/http"
	"os"
	"testing"
)

func TestTwitterISOMVideo(t *testing.T) {
	header, err := os.ReadFile("testdata/twitter-isom.header")
	if err != nil {
		t.Fatal(err)
	}
	if http.DetectContentType(header) != "application/octet-stream" {
		t.Fatal("fixture no longer reproduces failed detection")
	}
	if got := mediaType(header); got != "video/mp4" {
		t.Fatal(got)
	}
	for _, length := range []int{0, 4, 8, 15, 23} {
		if mediaType(header[:length]) == "video/mp4" {
			t.Fatal("truncated header accepted", length)
		}
	}
	for _, brand := range []string{"avif", "heic", "M4A ", "fake"} {
		b := append([]byte{}, header...)
		copy(b[8:12], brand)
		if mediaType(b) == "video/mp4" {
			t.Fatal("non-video major brand accepted", brand)
		}
	}
	bad := append([]byte{}, header...)
	binary.BigEndian.PutUint32(bad, 4096)
	if mediaType(bad) == "video/mp4" {
		t.Fatal("out-of-bounds ftyp accepted")
	}
	if mediaType([]byte("<html>error</html>")) == "video/mp4" {
		t.Fatal("HTML accepted")
	}
}
