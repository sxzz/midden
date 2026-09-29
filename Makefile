.PHONY: dev test integration build generate vet fmt fmt-check install-hooks
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

fmt:
	python3 scripts/format.py --write
fmt-check:
	python3 scripts/format.py --check
install-hooks:
	node scripts/install-hooks.mjs
