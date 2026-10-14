package adapter

import (
	"encoding/json"
	"testing"
)

func TestMetricsSplitAndOverlay(t *testing.T) {
	data := json.RawMessage(`{"text":"hi","likes":9007199254740993,"metadata":{"followers":3,"bio":"b"},"a/b":1}`)
	paths := []string{"/likes", "/metadata/followers", "/missing", "/metadata/absent/deep", "/a~1b"}
	stripped, metrics, err := SplitMetrics(data, paths)
	if err != nil {
		t.Fatal(err)
	}
	if string(stripped) != `{"metadata":{"bio":"b"},"text":"hi"}` {
		t.Fatalf("stripped: %s", stripped)
	}
	if len(metrics) != 3 || string(metrics["/likes"]) != "9007199254740993" || string(metrics["/metadata/followers"]) != "3" || string(metrics["/a~1b"]) != "1" {
		t.Fatalf("metrics: %v", metrics)
	}
	back, err := OverlayMetrics(stripped, metrics)
	if err != nil {
		t.Fatal(err)
	}
	if string(back) != `{"a/b":1,"likes":9007199254740993,"metadata":{"bio":"b","followers":3},"text":"hi"}` {
		t.Fatalf("overlay: %s", back)
	}
	// An overlay creates missing parents but never replaces a non-object.
	back, err = OverlayMetrics(json.RawMessage(`{"metadata":"text"}`), map[string]json.RawMessage{"/metadata/followers": json.RawMessage("1"), "/new/count": json.RawMessage("2")})
	if err != nil || string(back) != `{"metadata":"text","new":{"count":2}}` {
		t.Fatalf("overlay parents: %s %v", back, err)
	}
	if _, err := compileMetricPaths("t", []string{"likes"}); err == nil {
		t.Fatal("relative metric path accepted")
	}
}
