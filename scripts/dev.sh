#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
target="${1:-core}"
if [[ "$target" == web ]]; then
	shift
	exec node scripts/dev-web.mjs "$@"
fi
export MIDDEN_BUILD_REVISION="$(git rev-parse HEAD)"
if [[ -n "$(git status --porcelain)" ]]; then
	MIDDEN_BUILD_REVISION+="-dirty"
fi
case "$target" in
core | adapter | telegram | all) ;;
*)
	echo "Usage: $0 [core|adapter|telegram|all|web]" >&2
	exit 2
	;;
esac
compose=(docker compose -f compose.yaml -f compose.local.yaml -f compose.dev.yaml)
build=(docker compose -f compose.yaml -f compose.local.yaml -f compose.build.yaml)

if [[ "$target" != adapter ]]; then
	pnpm --filter @midden/web build
	case "$(docker info --format '{{.Architecture}}')" in
	aarch64 | arm64) arch=arm64 ;;
	x86_64 | amd64) arch=amd64 ;;
	*)
		echo "Unsupported Docker architecture" >&2
		exit 1
		;;
	esac
	mkdir -p .local/dev/bin
	# Compile all binaries before replacing any; directory mounts see atomic replacements.
	CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -o .local/dev/bin/core.next ./cmd/core
	CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -o .local/dev/bin/monitorctl.next ./cmd/monitorctl
	CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -o .local/dev/bin/telegram.next ./cmd/telegram
	mv .local/dev/bin/telegram.next .local/dev/bin/telegram
	mv .local/dev/bin/core.next .local/dev/bin/core
	mv .local/dev/bin/monitorctl.next .local/dev/bin/monitorctl
	if ! docker run --rm --entrypoint ffprobe midden-core:dev -version >/dev/null 2>&1; then
		"${build[@]}" build core
	fi
	"${compose[@]}" run --rm --no-deps --pull never migrate
fi
if [[ "$target" == adapter || "$target" == all ]]; then
	"${build[@]}" build adapter
	"${compose[@]}" up -d --no-deps --no-build --pull never --force-recreate adapter
fi
if [[ "$target" == core || "$target" == all ]]; then
	"${compose[@]}" up -d --no-deps --no-build --pull never --force-recreate core
fi
if [[ "$target" == telegram ]]; then
	"${compose[@]}" --profile telegram up -d --no-deps --no-build --pull never --force-recreate telegram
	echo "Telegram channel started."
	exit 0
fi
for ((attempt = 0; attempt < 30; attempt++)); do
	if curl -fsS http://127.0.0.1:9090/healthz >/dev/null 2>&1; then
		echo "Local deployment ready."
		exit 0
	fi
	sleep 1
done
echo "Local health check failed" >&2
exit 1
