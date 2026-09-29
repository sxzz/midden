.PHONY: dev test integration build generate vet fmt fmt-go fmt-sql fmt-config
dev:
	./scripts/dev.sh
build:
	go build -o bin/core ./cmd/core
	go build -o bin/telegram ./cmd/telegram
	pnpm install --frozen-lockfile --ignore-scripts
	pnpm run build
	go build -o bin/monitorctl ./cmd/monitorctl
test:
	pnpm test
	go test -race ./...
vet:
	go vet ./...
integration:
	./scripts/test-integration.sh
generate:
	pnpm run generate
	go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.8
	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1
	PATH="$$PATH:$$(go env GOPATH)/bin" protoc --go_out=. --go_opt=paths=source_relative --go-grpc_out=. --go-grpc_opt=paths=source_relative api/adapter/v1/adapter.proto

fmt: fmt-go fmt-sql fmt-config
	pnpm run format
fmt-go:
	go run golang.org/x/tools/cmd/goimports@v0.36.0 -w -local monitor ./cmd ./internal
	go run mvdan.cc/gofumpt@v0.8.0 -w ./cmd ./internal
fmt-sql:
	pg_format --no-extra-line --inplace internal/store/migrations/*.sql
fmt-config:
	uvx ruff@0.12.12 format scripts/configure-local-storage.py
	go run mvdan.cc/sh/v3/cmd/shfmt@v3.12.0 -w scripts/test-integration.sh scripts/deploy.sh scripts/dev.sh
	pnpm exec prettier --write compose.yaml compose.local.yaml compose.server.yaml docs/openapi.yaml .github/workflows/test.yml scripts/testdata/s3.json
