package telegram

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	tg "github.com/go-telegram-bot-api/telegram-bot-api/v5"
)

var errVideoMetadata = errors.New("video dimensions unavailable")

type videoStream struct {
	Width             int
	Height            int
	SampleAspectRatio string                       `json:"sample_aspect_ratio"`
	SideData          []struct{ Rotation float64 } `json:"side_data_list"`
}

func (s videoStream) dimensions() (int, int) {
	w, h := s.Width, s.Height
	if parts := strings.Split(s.SampleAspectRatio, ":"); len(parts) == 2 {
		n, _ := strconv.ParseFloat(parts[0], 64)
		d, _ := strconv.ParseFloat(parts[1], 64)
		if n > 0 && d > 0 {
			w = int(math.Round(float64(w) * n / d))
		}
	}
	for _, side := range s.SideData {
		if math.Abs(math.Remainder(side.Rotation, 180)) == 90 {
			w, h = h, w
			break
		}
	}
	return w, h
}

type temporaryVideo struct{ *os.File }

func (f temporaryVideo) Close() error {
	err := f.File.Close()
	os.Remove(f.Name())
	return err
}

// Probe the original bytes without transcoding. A seekable file also supports
// MP4s with the moov box at the end; cleanup happens after the upload.
func prepareVideo(ctx context.Context, reader io.Reader, name string) (preparedFile, error) {
	f, err := os.CreateTemp("", "midden-video-*.mp4")
	if err != nil {
		return preparedFile{}, err
	}
	temp := temporaryVideo{f}
	ok := false
	defer func() {
		if !ok {
			temp.Close()
		}
	}()
	if _, err := io.Copy(f, reader); err != nil {
		return preparedFile{}, err
	}
	probeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	data, err := exec.CommandContext(probeCtx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,sample_aspect_ratio:stream_side_data=rotation", "-of", "json", f.Name()).Output()
	if err != nil {
		return preparedFile{}, errVideoMetadata
	}
	var result struct{ Streams []videoStream }
	if json.Unmarshal(data, &result) != nil || len(result.Streams) == 0 {
		return preparedFile{}, errVideoMetadata
	}
	w, h := result.Streams[0].dimensions()
	if w <= 0 || h <= 0 || w > 65535 || h > 65535 {
		return preparedFile{}, errVideoMetadata
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return preparedFile{}, err
	}
	ok = true
	return preparedFile{kind: "video", width: w, height: h, data: tg.FileReader{Name: name, Reader: f}, closer: temp}, nil
}
