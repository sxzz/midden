#!/usr/bin/env bash
# Install outside the checkout: cp scripts/deploy-latest.sh ~/deploy-midden.sh
set -euo pipefail
umask 077
repo_dir="${MIDDEN_DIR:-$HOME/monitor}"
mode="${1:-deploy}"
if [[ "$mode" != deploy && "$mode" != --check ]]; then
  echo "Usage: $0 [--check] (MIDDEN_DIR defaults to ~/monitor)" >&2
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
docker compose config --quiet
backup_dir=".local/backups/$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:7}"
mkdir -p .local/backups
mkdir "$backup_dir"
printf '%s\n' "$revision" >"$backup_dir/revision"
phase='backing up database'
docker compose stop core </dev/null
docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc </dev/null >"$backup_dir/database.dump.partial"
mv "$backup_dir/database.dump.partial" "$backup_dir/database.dump"
echo "Database backup: $repo_dir/$backup_dir/database.dump"

phase='migrating database'
docker compose run --rm --no-deps --pull never migrate </dev/null
phase='starting adapter and core'
docker compose up -d --no-deps --no-build --pull never adapter core </dev/null
phase='waiting for service health'
address=$(docker compose port core 9090 | head -n 1)
if [[ -z "$address" ]]; then
  echo 'Core admin port 9090 must be published for health verification.' >&2
  exit 1
fi
address="${address/0.0.0.0/127.0.0.1}"
ready=0
for ((attempt=0; attempt<90; attempt++)); do
  if curl -fsS --max-time 3 "http://$address/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  docker compose logs --tail 40 core adapter
  echo 'Health check failed; no automatic database downgrade was attempted.' >&2
  exit 1
fi
phase='recording deployed images'
printf 'CORE_IMAGE=%s\nADAPTER_IMAGE=%s\n' "$CORE_IMAGE" "$ADAPTER_IMAGE" >.local/deployed-images.env
python3 - <<'PY'
from pathlib import Path
p=Path('.env')
lines=[line for line in p.read_text().splitlines() if not line.startswith(('CORE_IMAGE=', 'ADAPTER_IMAGE='))]
tmp=p.with_suffix('.env.new')
tmp.write_text('\n'.join(lines)+'\n'+Path('.local/deployed-images.env').read_text())
tmp.chmod(0o600)
tmp.replace(p)
PY
printf 'Deployment complete: %s\nHealth: ok\n' "$revision"
