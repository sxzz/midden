#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
umask 077

# Prevent overlapping upgrades on this checkout, without requiring flock on macOS.
mkdir -p .local
if ! mkdir .local/deploy.lock 2>/dev/null; then
	echo 'A deployment is already running (.local/deploy.lock).' >&2
	exit 1
fi
trap 'rmdir .local/deploy.lock' EXIT

if [[ "${1:-}" == "--pull" ]]; then
	shift
	if ! git diff --quiet || ! git diff --cached --quiet; then
		echo 'Commit or restore tracked changes before deploying.' >&2
		exit 1
	fi
	git pull --ff-only
	# Run the script from the fetched revision, which may change the build steps.
	rmdir .local/deploy.lock
	trap - EXIT
	exec ./scripts/deploy.sh "$@"
fi

backup_dir="${1:-.local/backups/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$backup_dir"
if [[ -e "$backup_dir/database.dump" || -e "$backup_dir/database.dump.partial" ]]; then
	echo 'Backup path already exists; choose a new directory.' >&2
	exit 1
fi

# A small server can free worker memory while compiling; failures leave it stopped.
if [[ "${DEPLOY_STOP_BEFORE_BUILD:-0}" == "1" ]]; then
	docker compose stop core adapter
fi
COMPOSE_BAKE=false docker compose --parallel 1 build core migrate tls-init
if docker compose config --services | grep -qx storage-init; then
	COMPOSE_BAKE=false docker compose --parallel 1 build storage-init
fi
COMPOSE_BAKE=false docker compose --parallel 1 build adapter

docker compose stop core
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc >"$backup_dir/database.dump.partial"
mv "$backup_dir/database.dump.partial" "$backup_dir/database.dump"
git rev-parse HEAD >"$backup_dir/revision"
echo "Database backup: $backup_dir/database.dump"
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps adapter core
echo "Deployed revision: $(git rev-parse --short HEAD)"
