package adapter

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Metric paths point at values an entity type observes (counts) rather than
// content: they change on every look without the entity having changed.

func validMetricPath(p string) bool {
	return strings.HasPrefix(p, "/") && len(p) <= 200 && !strings.Contains(p, "//")
}

func pointer(p string) []string {
	parts := strings.Split(p[1:], "/")
	for i, part := range parts {
		parts[i] = strings.ReplaceAll(strings.ReplaceAll(part, "~1", "/"), "~0", "~")
	}
	return parts
}

func decode(raw json.RawMessage) (any, error) {
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		return nil, err
	}
	return v, nil
}

// SplitMetrics removes the values at paths from data and returns them by path.
func SplitMetrics(data json.RawMessage, paths []string) (json.RawMessage, map[string]json.RawMessage, error) {
	if len(paths) == 0 {
		return data, nil, nil
	}
	v, err := decode(data)
	if err != nil {
		return nil, nil, err
	}
	metrics := map[string]json.RawMessage{}
	for _, p := range paths {
		parts := pointer(p)
		parent, ok := v.(map[string]any)
		for _, part := range parts[:len(parts)-1] {
			if parent, ok = parent[part].(map[string]any); !ok {
				break
			}
		}
		if !ok {
			continue
		}
		last := parts[len(parts)-1]
		if value, found := parent[last]; found {
			raw, err := json.Marshal(value)
			if err != nil {
				return nil, nil, err
			}
			metrics[p] = raw
			delete(parent, last)
		}
	}
	out, err := json.Marshal(v)
	if len(metrics) == 0 {
		metrics = nil
	}
	return out, metrics, err
}

// OverlayMetrics puts observed values back at their paths.
func OverlayMetrics(data json.RawMessage, metrics map[string]json.RawMessage) (json.RawMessage, error) {
	if len(metrics) == 0 {
		return data, nil
	}
	v, err := decode(data)
	if err != nil {
		return nil, err
	}
	root, ok := v.(map[string]any)
	if !ok {
		return data, nil
	}
	for p, raw := range metrics {
		if !validMetricPath(p) {
			continue
		}
		value, err := decode(raw)
		if err != nil {
			return nil, err
		}
		parts := pointer(p)
		parent := root
		for _, part := range parts[:len(parts)-1] {
			next, ok := parent[part].(map[string]any)
			if !ok {
				if _, taken := parent[part]; taken {
					parent = nil
					break
				}
				next = map[string]any{}
				parent[part] = next
			}
			parent = next
		}
		if parent != nil {
			parent[parts[len(parts)-1]] = value
		}
	}
	return json.Marshal(root)
}

func compileMetricPaths(name string, paths []string) ([]string, error) {
	if len(paths) > 32 {
		return nil, fmt.Errorf("too many metric paths for %s", name)
	}
	for _, p := range paths {
		if !validMetricPath(p) {
			return nil, fmt.Errorf("invalid metric path for %s", name)
		}
	}
	return paths, nil
}
