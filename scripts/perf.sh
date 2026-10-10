#!/usr/bin/env bash
# Measure and compare the read APIs on a throwaway database.
#
#   scripts/perf.sh up                    start an empty, migrated database
#   scripts/perf.sh seed [tenants] [n]    capture n posts for each of the tenants
#   scripts/perf.sh load FILE             replace it with a pg_dump -Fc of a real one
#   scripts/perf.sh bench                 time every read API, slowest first
#   scripts/perf.sh dump FILE             record what every tenant is shown
#   scripts/perf.sh explain CALL          plans behind the slowest sample of CALL
#   scripts/perf.sh psql [args]           open the database
#   scripts/perf.sh down                  remove it
#
# To check a change: dump with the old build, dump with the new one, and
# `cmp` the two files. PERF_TENANT limits a run to one tenant.
set -euo pipefail
cd "$(dirname "$0")/.."
name="${PERF_CONTAINER:-midden-perf}"
password=midden-perf

urls() {
	local port
	port="$(docker port "$name" 5432/tcp 2>/dev/null | head -n1 | cut -d: -f2)"
	if [ -z "$port" ]; then
		echo "No perf database; run scripts/perf.sh up" >&2
		exit 1
	fi
	export PERF_ADMIN_DATABASE_URL="postgres://postgres:${password}@127.0.0.1:${port}/monitor?sslmode=disable"
	export PERF_DATABASE_URL="postgres://monitor_app:${password}@127.0.0.1:${port}/monitor?sslmode=disable"
}

migrate() {
	urls
	ADMIN_DATABASE_URL="$PERF_ADMIN_DATABASE_URL" go run ./cmd/monitorctl migrate
	ADMIN_DATABASE_URL="$PERF_ADMIN_DATABASE_URL" APP_DB_PASSWORD="$password" go run ./cmd/monitorctl app-password
}

run() {
	urls
	go test -tags perf ./internal/app -run "^$1\$" -count=1 -timeout 0 -v | grep -Ev '^(=== RUN|--- PASS|PASS$|ok )'
}

case "${1:-}" in
up)
	docker rm -fv "$name" >/dev/null 2>&1 || true
	docker run -d --name "$name" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=monitor postgres:17.6-alpine >/dev/null
	for _ in $(seq 1 60); do
		if docker exec "$name" psql -U postgres -d monitor -c 'SELECT 1' >/dev/null 2>&1; then break; fi
		sleep 1
	done
	migrate
	;;
seed)
	PERF_SEED_TENANTS="${2:-4}" PERF_SEED_COLLECTIONS="${3:-2000}" run TestPerfSeed
	;;
load)
	urls
	docker exec "$name" psql -U postgres -d postgres -qc 'DROP DATABASE monitor WITH (FORCE)' -c 'CREATE DATABASE monitor'
	docker exec "$name" psql -U postgres -d monitor -qc "DO \$\$ BEGIN CREATE ROLE monitor_app LOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END \$\$"
	docker exec -i "$name" pg_restore -U postgres -d monitor --no-owner <"$2"
	migrate
	docker exec "$name" psql -U postgres -d monitor -qc 'ANALYZE'
	;;
bench)
	run TestPerfBench
	;;
dump)
	PERF_OUT="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")" run TestPerfDump
	;;
explain)
	PERF_CALL="$2" run TestPerfExplain
	;;
psql)
	shift
	flags=-i
	if [ -t 0 ]; then flags=-it; fi
	docker exec "$flags" "$name" psql -U postgres -d monitor "$@"
	;;
down)
	docker rm -fv "$name" >/dev/null
	;;
*)
	sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
	exit 2
	;;
esac
