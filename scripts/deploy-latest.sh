#!/usr/bin/env bash
# Install outside the checkout: cp scripts/deploy-latest.sh ~/deploy-midden.sh
set -euo pipefail
umask 077
repo_dir="${MIDDEN_DIR:-$HOME/midden}"
mode="${1:-deploy}"
if [[ "$mode" != deploy && "$mode" != --check ]]; then
	echo "Usage: $0 [--check] (MIDDEN_DIR defaults to ~/midden)" >&2
	exit 2
fi
cd "$repo_dir"
mkdir -p .local
if ! mkdir .local/deploy.lock 2>/dev/null; then
	echo 'Another deployment holds .local/deploy.lock.' >&2
	exit 1
fi
phase='checking release'
trap 'rmdir .local/deploy.lock' EXIT
trap 'echo "Deployment failed while $phase. Inspect the error and database backup before retrying." >&2' ERR
if [[ -n "$(git status --porcelain --untracked-files=normal)" ]]; then
	echo 'The repository has local changes. Commit or move them before deployment.' >&2
	exit 1
fi

docker pull ghcr.io/sxzz/midden-core:latest </dev/null
revision=$(docker image inspect ghcr.io/sxzz/midden-core:latest --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
if [[ ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then
	echo 'Latest core image has no valid source revision.' >&2
	exit 1
fi
export CORE_IMAGE="ghcr.io/sxzz/midden-core:sha-$revision"
export ADAPTER_IMAGE="ghcr.io/sxzz/midden-adapter:sha-$revision"
# The latest tags are published independently. Resolve both immutable tags before stopping anything.
for image in "$CORE_IMAGE" "$ADAPTER_IMAGE"; do
	docker pull "$image" </dev/null
	actual=$(docker image inspect "$image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')
	if [[ "$actual" != "$revision" ]]; then
		echo "Image revision mismatch: $image" >&2
		exit 1
	fi
done
git fetch origin main </dev/null
git cat-file -e "$revision^{commit}"
if ! git merge-base --is-ancestor "$revision" origin/main; then
	echo 'Published revision is not in origin/main.' >&2
	exit 1
fi
if [[ "$mode" == --check ]]; then
	echo "Ready to deploy $revision (both images available). No services changed."
	exit 0
fi

phase='checking deployment configuration'
git checkout --detach "$revision"
# Use the deployment implementation shipped with the selected release.
source ./scripts/deploy-common.sh
deploy_revision "${revision}"
