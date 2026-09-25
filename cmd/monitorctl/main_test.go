package main

import (
	"context"
	"io"
	"os"
	"strings"
	"testing"

	"monitor/internal/store"
)

func TestSecretConfigCLI(t *testing.T) {
	dsn := os.Getenv("TEST_ADMIN_DATABASE_URL")
	if dsn == "" {
		t.Skip("Docker database required")
	}
	t.Setenv("ADMIN_DATABASE_URL", dsn)
	ctx := context.Background()
	db, e := store.Open(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	var previous string
	if e = db.Pool.QueryRow(ctx, `SELECT value FROM config WHERE key='telegram_bot_token'`).Scan(&previous); e != nil {
		t.Fatal(e)
	}
	defer db.Pool.Exec(ctx, `UPDATE config SET value=$1 WHERE key='telegram_bot_token'`, previous)
	originalArgs, originalIn, originalOut := os.Args, os.Stdin, os.Stdout
	defer func() { os.Args, os.Stdin, os.Stdout = originalArgs, originalIn, originalOut }()
	input, writer, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer input.Close()
	const secret = "12345:private_test_credential"
	_, e = io.WriteString(writer, secret+"\n")
	if e != nil {
		t.Fatal(e)
	}
	writer.Close()
	outputReader, outputWriter, e := os.Pipe()
	if e != nil {
		t.Fatal(e)
	}
	defer outputReader.Close()
	os.Stdin = input
	os.Stdout = outputWriter
	os.Args = []string{"monitorctl", "config-set", "telegram_bot_token", "--stdin"}
	if e = run(); e != nil {
		t.Fatal(e)
	}
	os.Args = []string{"monitorctl", "config-list"}
	if e = run(); e != nil {
		t.Fatal(e)
	}
	outputWriter.Close()
	output, e := io.ReadAll(outputReader)
	if e != nil {
		t.Fatal(e)
	}
	if strings.Contains(string(output), secret) || !strings.Contains(string(output), "telegram_bot_token=[redacted]") {
		t.Fatal("secret listing is not redacted")
	}
	var actual string
	if e = db.Pool.QueryRow(ctx, `SELECT value FROM config WHERE key='telegram_bot_token'`).Scan(&actual); e != nil {
		t.Fatal(e)
	}
	if actual != secret {
		t.Fatal("stdin credential not saved")
	}
}
