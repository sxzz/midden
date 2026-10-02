#!/usr/bin/env bash
# Full backup to .local/backups/<YYYYMMDD-HHMMSS>.tgz: database dump, S3 objects,
# .env, s3.json and adapter TLS. Requires rclone on the host.
set -euo pipefail
umask 077

usage() {
	echo "Usage: $0 [--stop-writes] [--keep N] (MIDDEN_DIR defaults to this checkout)" >&2
	exit 2
}

stop_writes=false keep=
while [[ $# -gt 0 ]]; do
	case "$1" in
	--stop-writes) stop_writes=true ;;
	--keep)
		[[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || usage
		keep=$2
		shift
		;;
	*) usage ;;
	esac
	shift
done

cd "${MIDDEN_DIR:-$(dirname "$0")/..}"
command -v rclone >/dev/null || {
	echo 'rclone is required: brew install rclone' >&2
	exit 1
}

# Share the deploy lock: a deployment stops core and migrates while we dump.
mkdir -p .local/backups
if ! mkdir .local/deploy.lock 2>/dev/null; then
	echo 'A deployment or backup holds .local/deploy.lock.' >&2
	exit 1
fi
ts=$(date +%Y%m%d-%H%M%S)
stage=.local/backups/.staging-$ts
restart_services=
cleanup() {
	if [[ -n "$restart_services" ]]; then docker compose --profile telegram up -d --no-deps --no-build --pull never $restart_services </dev/null || true; fi
	rm -rf "$stage" ".local/backups/$ts.tgz.partial"
	rmdir .local/deploy.lock
}
trap cleanup EXIT

envval() {
	local value
	value=$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2-)
	value=${value%\"} value=${value#\"}
	printf '%s' "$value"
}

mkdir -p "$stage/config"
git rev-parse HEAD >"$stage/revision"

if [[ "$stop_writes" == true ]]; then
	restart_services=$(docker compose --profile telegram ps --status running --services | grep -xE 'core|telegram' | tr '\n' ' ' || true)
	if [[ -n "$restart_services" ]]; then docker compose --profile telegram stop $restart_services </dev/null; fi
fi

# Dump first, then copy objects: objects are written before the rows that
# reference them, so new content in the dump is always in the sync. Without
# --stop-writes, an object purged during the sync can still be referenced by
# the dump: GC grace counts from object creation, not from becoming garbage.
echo '== database'
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc </dev/null >"$stage/database.dump"
docker compose exec -T postgres pg_restore -l <"$stage/database.dump" >/dev/null

echo '== objects'
endpoint=$(envval S3_ENDPOINT)
if s3_address=$(docker compose port s3 8333 2>/dev/null) && [[ -n "$s3_address" ]]; then
	endpoint="http://${s3_address/0.0.0.0/127.0.0.1}"
fi
bucket=$(envval S3_BUCKET)
export RCLONE_CONFIG=/dev/null RCLONE_CONFIG_MIDDEN_TYPE=s3 RCLONE_CONFIG_MIDDEN_PROVIDER=SeaweedFS
export RCLONE_CONFIG_MIDDEN_ENDPOINT=$endpoint
RCLONE_CONFIG_MIDDEN_ACCESS_KEY_ID=$(envval S3_ACCESS_KEY)
RCLONE_CONFIG_MIDDEN_SECRET_ACCESS_KEY=$(envval S3_SECRET_KEY)
export RCLONE_CONFIG_MIDDEN_ACCESS_KEY_ID RCLONE_CONFIG_MIDDEN_SECRET_ACCESS_KEY
rclone sync "midden:$bucket" "$stage/s3/$bucket" --transfers 8 --stats 0
# Objects added after the sync started are expected; missing ones are not.
rclone check "midden:$bucket" "$stage/s3/$bucket" --size-only --one-way --log-level ERROR

if [[ -n "$restart_services" ]]; then
	docker compose --profile telegram up -d --no-deps --no-build --pull never $restart_services </dev/null
	restart_services=
fi

echo '== config'
cp .env "$stage/config/"
for file in .local/s3.json .local/deployed-images.env; do
	if [[ -f "$file" ]]; then cp "$file" "$stage/config/"; fi
done
# Read /tls through the adapter service so volume and bind mounts both work.
mkdir "$stage/config/adapter-tls"
docker compose run --rm --no-deps --pull never -T --entrypoint tar adapter -c -C /tls . </dev/null |
	tar -x -C "$stage/config/adapter-tls"

echo '== archive'
tar -czf ".local/backups/$ts.tgz.partial" -C "$stage" .
tar -tzf ".local/backups/$ts.tgz.partial" >/dev/null
mv ".local/backups/$ts.tgz.partial" ".local/backups/$ts.tgz"

if [[ -n "$keep" ]]; then
	ls -1 .local/backups | grep -E '^[0-9]{8}-[0-9]{6}\.tgz$' | sort -r | tail -n +$((keep + 1)) |
		while IFS= read -r old; do
			rm -f ".local/backups/$old"
			echo "Removed old backup: $old"
		done
fi

printf 'Backup complete: %s (%s)\n' ".local/backups/$ts.tgz" "$(du -h ".local/backups/$ts.tgz" | cut -f1)"
