package app

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strings"
	"syscall"
	"testing"
)

func TestDiagnosticErrorRedactsURLsAndKeepsNetworkCause(t *testing.T) {
	err := &url.Error{Op: "Get", URL: "https://example.test/private?token=secret-value", Err: &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}}
	fields := fmt.Sprint(diagnosticError(fmt.Errorf("media request failed: %w", err)))
	if strings.Contains(fields, "secret-value") || strings.Contains(fields, "example.test") || strings.Contains(fields, "private") {
		t.Fatal(fields)
	}
	if !strings.Contains(fields, "connection refused") || !strings.Contains(fields, "dial") {
		t.Fatal(fields)
	}
	fields = fmt.Sprint(diagnosticError(&url.Error{Op: "Get", URL: "https://example.test", Err: context.DeadlineExceeded}))
	if !strings.Contains(fields, "deadline_exceeded true") || !strings.Contains(fields, "timeout true") {
		t.Fatal(fields)
	}
}
