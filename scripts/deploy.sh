#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

backup_dir="${1:-.local/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$backup_dir"
if [[ -e "$backup_dir/database.dump" || -e "$backup_dir/database.dump.partial" ]]; then
	echo "Backup path already exists; choose a new directory." >&2
	exit 1
fi

docker compose build
docker compose stop core
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc >"$backup_dir/database.dump.partial"
mv "$backup_dir/database.dump.partial" "$backup_dir/database.dump"
echo "Database backup: $backup_dir/database.dump"
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps adapter core
