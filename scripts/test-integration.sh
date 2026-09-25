#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
name="monitor-ci-$$"
restore_dir="$(mktemp -d)"
cleanup() {
	rm -rf "$restore_dir"
	docker rm -f "${name}-postgres" "${name}-s3" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker run -d --name "${name}-postgres" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=monitor-test -e POSTGRES_DB=monitor postgres:17.6-alpine >/dev/null
docker run -d --name "${name}-s3" --mount "type=bind,source=$PWD/scripts/testdata/s3.json,target=/etc/s3.json,readonly" -p 127.0.0.1::8333 chrislusf/seaweedfs:3.85 server -s3 -s3.port=8333 -dir=/data -ip=localhost -ip.bind=0.0.0.0 -s3.config=/etc/s3.json >/dev/null
for i in $(seq 1 60); do
	if docker exec "${name}-postgres" pg_isready -U postgres -d monitor >/dev/null 2>&1; then break; fi
	sleep 1
done
pg_port="$(docker port "${name}-postgres" 5432/tcp | cut -d: -f2)"
s3_port="$(docker port "${name}-s3" 8333/tcp | cut -d: -f2)"
export TEST_ADMIN_DATABASE_URL="postgres://postgres:monitor-test@127.0.0.1:${pg_port}/monitor?sslmode=disable"
export TEST_DATABASE_URL="postgres://monitor_app:monitor-app-test@127.0.0.1:${pg_port}/monitor?sslmode=disable"
export TEST_S3_ENDPOINT="http://127.0.0.1:${s3_port}"
for i in $(seq 1 60); do
	if curl -s --max-time 1 "$TEST_S3_ENDPOINT" >/dev/null; then break; fi
	sleep 1
done
ADMIN_DATABASE_URL="$TEST_ADMIN_DATABASE_URL" go run ./cmd/monitorctl migrate
ADMIN_DATABASE_URL="$TEST_ADMIN_DATABASE_URL" APP_DB_PASSWORD=monitor-app-test go run ./cmd/monitorctl app-password
go test -race ./... -count=1 -timeout 240s

export TEST_RESTORE_DIR="$restore_dir"
TEST_RESTORE_PHASE=prepare go test ./internal/app -run TestBackupRestore -count=1 -v
docker exec "${name}-postgres" pg_dump -U postgres -d monitor -Fc >"$restore_dir/database.dump"
docker exec "${name}-postgres" createdb -U postgres monitor_restored
docker exec -i "${name}-postgres" pg_restore -U postgres -d monitor_restored --exit-on-error <"$restore_dir/database.dump"
export TEST_ADMIN_DATABASE_URL="postgres://postgres:monitor-test@127.0.0.1:${pg_port}/monitor_restored?sslmode=disable"
export TEST_DATABASE_URL="postgres://monitor_app:monitor-app-test@127.0.0.1:${pg_port}/monitor_restored?sslmode=disable"
TEST_RESTORE_PHASE=verify go test ./internal/app -run TestBackupRestore -count=1 -v
