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

# Pull the exact revision just checked out; never compile on the server.
export CORE_IMAGE="ghcr.io/sxzz/midden-core:sha-$(git rev-parse HEAD)"
export ADAPTER_IMAGE="ghcr.io/sxzz/midden-adapter:sha-$(git rev-parse HEAD)"
docker compose pull

docker compose stop core
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc >"$backup_dir/database.dump.partial"
mv "$backup_dir/database.dump.partial" "$backup_dir/database.dump"
git rev-parse HEAD >"$backup_dir/revision"
echo "Database backup: $backup_dir/database.dump"
docker compose run --rm --no-deps --pull never migrate
docker compose up -d --no-deps --no-build --pull never adapter core
# Preserve immutable image choices for subsequent restarts and operator commands.
printf 'CORE_IMAGE=%s\nADAPTER_IMAGE=%s\n' "$CORE_IMAGE" "$ADAPTER_IMAGE" >.local/deployed-images.env
python3 - <<'PYTHON'
from pathlib import Path
p=Path('.env')
lines=[line for line in p.read_text().splitlines() if not line.startswith(('CORE_IMAGE=', 'ADAPTER_IMAGE='))]
p.write_text('\n'.join(lines)+'\n'+Path('.local/deployed-images.env').read_text())
p.chmod(0o600)
PYTHON
echo "Deployed revision: $(git rev-parse --short HEAD)"
