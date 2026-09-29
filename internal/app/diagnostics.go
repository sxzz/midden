package app

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"syscall"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/minio/minio-go/v7"
)

// Deliberately omit error messages: URL errors, SQL details and upstream bodies
// may contain credentials. Structured codes retain the useful failure evidence.
func diagnosticError(err error) []any {
	if err == nil {
		return nil
	}
	fields := []any{"error_type", fmt.Sprintf("%T", err)}
	if errors.Is(err, context.Canceled) {
		fields = append(fields, "canceled", true)
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, os.ErrDeadlineExceeded) {
		fields = append(fields, "deadline_exceeded", true)
	}
	var ne net.Error
	if errors.As(err, &ne) {
		fields = append(fields, "timeout", ne.Timeout())
	}
	var op *net.OpError
	if errors.As(err, &op) {
		fields = append(fields, "network_operation", op.Op, "network", op.Net)
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		fields = append(fields, "dns_failure", true, "dns_not_found", dns.IsNotFound)
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		fields = append(fields, "system_error", errno.Error())
	}
	var pg *pgconn.PgError
	if errors.As(err, &pg) {
		fields = append(fields, "sqlstate", pg.Code)
	}
	var storage minio.ErrorResponse
	if errors.As(err, &storage) {
		fields = append(fields, "storage_code", storage.Code, "storage_http_status", storage.StatusCode)
	}
	return fields
}
