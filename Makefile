.PHONY: test integration build generate vet fmt fmt-go fmt-sql fmt-config
build:
	go build -o bin/core ./cmd/core
	npm ci --ignore-scripts
	npm run build
	go build -o bin/monitorctl ./cmd/monitorctl
test:
	npm test
	go test -race ./...
vet:
	go vet ./...
integration:
	./scripts/test-integration.sh
generate:
	npm run generate
	go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.8
	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1
	PATH="$$PATH:$$(go env GOPATH)/bin" protoc --go_out=. --go_opt=paths=source_relative --go-grpc_out=. --go-grpc_opt=paths=source_relative api/adapter/v1/adapter.proto

fmt: fmt-go fmt-sql fmt-config
	npm run format
fmt-go:
	go run golang.org/x/tools/cmd/goimports@v0.36.0 -w -local monitor ./cmd ./internal
	go run mvdan.cc/gofumpt@v0.8.0 -w ./cmd ./internal
fmt-sql:
	pg_format --no-extra-line --inplace internal/store/schema.sql
fmt-config:
	uvx ruff@0.12.12 format scripts/configure-local-storage.py
	go run mvdan.cc/sh/v3/cmd/shfmt@v3.12.0 -w scripts/test-integration.sh
	npx --yes prettier@3.6.2 --write compose.yaml compose.local.yaml docs/openapi.yaml .github/workflows/test.yml scripts/testdata/s3.json
