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

phase='pulling release images'
trap 'echo "Deployment failed while $phase. Inspect the error and database backup before retrying." >&2' ERR
revision=$(git rev-parse HEAD)
export CORE_IMAGE="ghcr.io/sxzz/midden-core:sha-$revision"
export ADAPTER_IMAGE="ghcr.io/sxzz/midden-adapter:sha-$revision"
for image in "$CORE_IMAGE" "$ADAPTER_IMAGE"; do
	docker pull "$image" </dev/null
	actual=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
	if [[ "$actual" != "$revision" ]]; then
		echo "Image revision mismatch: $image" >&2
		exit 1
	fi
done
source ./scripts/deploy-common.sh
deploy_revision "$revision" "${1:-}"
