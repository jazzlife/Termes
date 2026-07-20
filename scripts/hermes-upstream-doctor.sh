#!/bin/sh

set -eu

ROOT_DIR=${TERMES_APP_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
COMPOSE_FILE=${TERMES_COMPOSE_FILE:-"$ROOT_DIR/infra/compose/docker-compose.yml"}
ENV_FILE=${TERMES_ENV_FILE:-"$ROOT_DIR/infra/compose/.env"}
BASE_URL=${TERMES_BASE_URL:-"http://100.64.0.9:4180"}
COMPOSE=${TERMES_DOCKER_COMPOSE:-"docker compose"}
STATUS=0

ok() {
  printf 'ok %s\n' "$1"
}

warn() {
  printf 'not_ready %s\n' "$1"
  STATUS=1
}

note() {
  printf 'info %s\n' "$1"
}

env_value() {
  key=$1
  if [ ! -f "$ENV_FILE" ]; then
    return 1
  fi
  grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | sed "s/^${key}=//"
}

env_is_set() {
  key=$1
  value=$(env_value "$key" || true)
  [ -n "$value" ]
}

check_env_key() {
  key=$1
  if env_is_set "$key"; then
    ok "$key=set"
  else
    warn "$key=empty"
  fi
}

printf '# Termes Hermes upstream doctor\n'
printf 'app=%s\n' "$ROOT_DIR"
printf 'compose=%s\n' "$COMPOSE_FILE"
printf 'env=%s\n' "$ENV_FILE"
printf 'base_url=%s\n' "$BASE_URL"

if [ -f "$ENV_FILE" ]; then
  ok "env_file=present"
else
  warn "env_file=missing"
fi

check_env_key HERMES_API_BASE_URL
check_env_key HERMES_API_KEY
check_env_key HERMES_AGENT_API_KEY
check_env_key HERMES_MANAGER_SERVICE_TOKEN
check_env_key HERMES_DASHBOARD_SESSION_TOKEN

if command -v docker >/dev/null 2>&1 && [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ]; then
  services=$($COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile hermes-upstream config --services 2>/dev/null || true)
  if printf '%s\n' "$services" | grep -qx 'hermes-agent'; then
    ok "compose_service=hermes-agent"
  else
    warn "compose_service=hermes-agent_missing"
  fi

  if printf '%s\n' "$services" | grep -qx 'hermes-dashboard'; then
    ok "compose_service=hermes-dashboard"
  else
    warn "compose_service=hermes-dashboard_missing"
  fi

  ps_output=$($COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps hermes-agent 2>/dev/null || true)
  if printf '%s\n' "$ps_output" | grep -q 'termes-hermes-agent'; then
    ok "container=termes-hermes-agent_present"
    if printf '%s\n' "$ps_output" | grep -qi 'healthy'; then
      ok "container=termes-hermes-agent_healthy"
    else
      warn "container=termes-hermes-agent_not_healthy"
    fi
  else
    warn "container=termes-hermes-agent_absent"
  fi

  manager_check=$($COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T hermes-manager node -e '
fetch("http://127.0.0.1:8080/upstream/diagnostics").then(async (response) => {
  const body = await response.text();
  console.log(`manager_diagnostics_http=${response.status}`);
  console.log(`manager_diagnostics=${body}`);
  process.exit(response.ok && body.includes("\"ready\":true") ? 0 : 3);
}).catch((error) => {
  console.log(`manager_diagnostics_error=${error.message}`);
  process.exit(4);
});
' 2>/dev/null || true)
  if printf '%s\n' "$manager_check" | grep -q '"ready":true'; then
    ok "oauth_runtime=ready"
  else
    warn "${manager_check:-manager_upstream_check=failed}"
  fi
else
  warn "docker_compose_check=skipped"
fi

if command -v curl >/dev/null 2>&1; then
  diagnostics=$(curl -fsS "$BASE_URL/api/hermes/upstream/diagnostics" 2>/dev/null || true)
  if [ -n "$diagnostics" ]; then
    printf 'diagnostics=%s\n' "$diagnostics"
    if printf '%s\n' "$diagnostics" | grep -q '"ready":true'; then
      ok "termes_upstream=ready"
    else
      warn "termes_upstream=not_ready"
    fi
  else
    warn "termes_diagnostics=unreachable"
  fi
else
  warn "curl=missing"
fi

exit "$STATUS"
