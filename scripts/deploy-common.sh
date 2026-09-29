#!/usr/bin/env bash
# Sourced by both deployment entry points while holding .local/deploy.lock.

record_deployment_config() {
	local temporary
	temporary=$(mktemp .env.XXXXXX)
	if [[ -f .env ]]; then
		if ! awk '!/^(CORE_IMAGE|ADAPTER_IMAGE|TELEGRAM_CHANNEL_ID)=/' .env >"$temporary"; then
			rm -f "$temporary"
			return 1
		fi
	fi
	printf 'CORE_IMAGE=%s\nADAPTER_IMAGE=%s\nTELEGRAM_CHANNEL_ID=%s\n' "$CORE_IMAGE" "$ADAPTER_IMAGE" "$TELEGRAM_CHANNEL_ID" >>"$temporary"
	chmod 600 "$temporary"
	mv "$temporary" .env
}

wait_for_http() {
	local address=$1 path=$2 attempt
	address="${address/0.0.0.0/127.0.0.1}"
	address="${address/\[::\]/[::1]}"
	for ((attempt = 0; attempt < 90; attempt++)); do
		if curl -fsS --max-time 3 "http://$address$path" >/dev/null 2>&1; then return 0; fi
		sleep 2
	done
	echo "Health check failed: $path. No automatic database downgrade was attempted." >&2
	return 1
}

deployment_failed() {
	local status=$?
	if [[ "${deployment_stopped:-false}" == true ]]; then
		docker compose --profile telegram stop telegram </dev/null || true
	fi
	echo "Deployment failed while $phase. Inspect the error and database backup before retrying; no schema downgrade was attempted." >&2
	return "$status"
}

deploy_revision() {
	local revision=$1 backup_dir=${2:-} telegram_exists=false telegram_running=false service
	phase='checking deployment configuration'
	docker compose config --quiet
	# Query directly in Postgres: never expose the bot token in output or arguments.
	export TELEGRAM_CHANNEL_ID
	TELEGRAM_CHANNEL_ID=$(docker compose exec -T postgres psql -X -U postgres -d monitor -At -v ON_ERROR_STOP=1 -c "SELECT value FROM config WHERE key='telegram_channel_id'" </dev/null)
	local bot_enabled
	bot_enabled=$(docker compose exec -T postgres psql -X -U postgres -d monitor -At -v ON_ERROR_STOP=1 -c "SELECT EXISTS (SELECT 1 FROM config WHERE key='telegram_bot_token' AND value <> '')" </dev/null)
	local existing_services running_services
	existing_services=$(docker compose --profile telegram ps --all --services)
	running_services=$(docker compose --profile telegram ps --status running --services)
	while IFS= read -r service; do
		if [[ "$service" == telegram ]]; then telegram_exists=true; fi
	done <<<"$existing_services"
	while IFS= read -r service; do
		if [[ "$service" == telegram ]]; then telegram_running=true; fi
	done <<<"$running_services"
	# First deployment after splitting the previously embedded bot must enable it.
	# A deliberately stopped standalone Telegram container stays stopped.
	if [[ "$telegram_exists" == false && "$bot_enabled" == t ]]; then telegram_running=true; fi
	# Retain intent across retries after an interrupted migration or health failure.
	if [[ -f .local/deploy-telegram-state ]]; then
		read -r telegram_running <.local/deploy-telegram-state
		if [[ "$telegram_running" != true && "$telegram_running" != false ]]; then
			echo 'Invalid .local/deploy-telegram-state; expected true or false.' >&2
			return 1
		fi
	fi
	if [[ "$telegram_running" == true && ("$bot_enabled" != t || -z "$TELEGRAM_CHANNEL_ID") ]]; then
		echo 'Enabled Telegram requires a bot token and channel ID in database config.' >&2
		return 1
	fi
	if [[ -z "$backup_dir" ]]; then backup_dir=".local/backups/$(date -u +%Y%m%dT%H%M%SZ)-${revision:0:7}"; fi
	if [[ -e "$backup_dir/database.dump" || -e "$backup_dir/database.dump.partial" ]]; then
		echo 'Backup path already exists; choose a new directory.' >&2
		return 1
	fi
	mkdir -p "$backup_dir"
	printf '%s\n' "$revision" >"$backup_dir/revision"
	if [[ -f .env ]]; then cp .env "$backup_dir/deployment.env"; fi
	docker compose --profile telegram ps --all --format json >"$backup_dir/containers.json"
	phase='stopping services and backing up database'
	# Stop the old embedded bot and the standalone poller before changing the DB.
	printf '%s\n' "$telegram_running" >.local/deploy-telegram-state
	deployment_stopped=true
	docker compose --profile telegram stop telegram core </dev/null
	docker compose exec -T postgres pg_dump -U postgres -d monitor -Fc </dev/null >"$backup_dir/database.dump.partial"
	mv "$backup_dir/database.dump.partial" "$backup_dir/database.dump"
	echo "Database backup: $backup_dir/database.dump"
	phase='migrating database'
	docker compose run --rm --no-deps --pull never migrate </dev/null
	phase='recording deployment configuration'
	# Persist before startup: interrupted deployments remain pinned to this schema's images.
	record_deployment_config
	phase='starting adapter and core (including web)'
	docker compose up -d --no-deps --no-build --pull never adapter core </dev/null
	phase='waiting for core and web health'
	local admin_address web_address
	admin_address=$(docker compose port core 9090 | head -n 1)
	web_address=$(docker compose port core 8080 | head -n 1)
	if [[ -z "$admin_address" || -z "$web_address" ]]; then
		echo 'Core ports 9090 and 8080 must be published for health verification.' >&2
		return 1
	fi
	wait_for_http "$admin_address" /healthz
	wait_for_http "$web_address" /app/
	if [[ "$telegram_running" == true ]]; then
		phase='starting Telegram channel'
		docker compose --profile telegram up -d --no-deps --no-build --pull never telegram </dev/null
		# There is no readiness endpoint; reject early exits and crash/restart loops.
		local container before after
		container=$(docker compose --profile telegram ps --all -q telegram)
		before=$(docker inspect --format '{{.RestartCount}}' "$container")
		sleep 10
		after=$(docker inspect --format '{{.State.Running}} {{.State.Restarting}} {{.RestartCount}}' "$container")
		if [[ "$after" != "true false $before" ]]; then
			echo 'Telegram exited or restarted during startup. Inspect its logs.' >&2
			return 1
		fi
	fi
	printf 'CORE_IMAGE=%s\nADAPTER_IMAGE=%s\n' "$CORE_IMAGE" "$ADAPTER_IMAGE" >.local/deployed-images.env
	rm -f .local/deploy-telegram-state
	deployment_stopped=false
	printf 'Deployment complete: %s\nCore and web health: ok\nTelegram enabled: %s\n' "$revision" "$telegram_running"
}

set -E
trap deployment_failed ERR
