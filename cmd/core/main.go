package main

import (
	"log/slog"
	"os"

	"monitor/internal/runtime"
)

func main() {
	if err := runtime.Run(); err != nil {
		slog.Error("core stopped", "error", err)
		os.Exit(1)
	}
}
