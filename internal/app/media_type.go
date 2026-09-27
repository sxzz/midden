package app

import (
	"encoding/binary"
	"net/http"
)

// DetectContentType recognizes MP4 brands but misses ISO Base Media brands
// used by some media encoders. Inspect the bounded ftyp box as well.
func mediaType(header []byte) string {
	detected := http.DetectContentType(header)
	if detected != "application/octet-stream" || len(header) < 16 || string(header[4:8]) != "ftyp" {
		return detected
	}
	size := int(binary.BigEndian.Uint32(header[:4]))
	if size < 16 || size > len(header) || size%4 != 0 {
		return detected
	}
	switch string(header[8:12]) {
	case "isom", "iso2", "iso3", "iso4", "iso5", "iso6", "iso7", "iso8", "iso9", "avc1", "dash", "M4V ":
		return "video/mp4"
	}
	return detected
}
