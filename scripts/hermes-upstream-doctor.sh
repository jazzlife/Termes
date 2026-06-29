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

PROVIDER_KEY_SET=0
if env_is_set OPENAI_API_KEY || env_is_set OPENROUTER_API_KEY || env_is_set ANTHROPIC_API_KEY; then
  PROVIDER_KEY_SET=1
  ok "provider_key=set"
else
  note "provider_key=empty"
fi

if command -v docker >/dev/null 2>&1 && [ -f "$COMPOSE_FILE" ] && [ -f "$ENV_FILE" ]; then
  services=$($COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile hermes-upstream config --services 2>/dev/null || true)
  if printf '%s\n' "$services" | grep -qx 'hermes-agent'; then
    ok "compose_service=hermes-agent"
  else
    warn "compose_service=hermes-agent_missing"
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

  codex_check=$($COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T hermes-agent sh -lc '
if command -v codex >/dev/null 2>&1; then
  printf "codex_cli=%s\n" "$(codex --version 2>/dev/null | head -n 1)"
else
  printf "codex_cli=missing\n"
fi
if [ -s /opt/data/.codex/auth.json ]; then
  printf "codex_oauth=present\n"
else
  printf "codex_oauth=missing\n"
fi
if [ -s /opt/data/auth.json ] && grep -q "openai-codex" /opt/data/auth.json; then
  printf "hermes_openai_codex_oauth=present\n"
else
  printf "hermes_openai_codex_oauth=missing\n"
fi
if grep -q "openai_runtime: codex_app_server" /opt/data/config.yaml 2>/dev/null; then
  printf "codex_app_server=enabled\n"
else
  printf "codex_app_server=disabled\n"
fi
' 2>/dev/null || true)
  printf '%s\n' "$codex_check"
  if printf '%s\n' "$codex_check" | grep -q '^codex_cli=.*[0-9]'; then
    ok "codex_cli=installed"
  else
    warn "codex_cli=missing"
  fi
  CODEX_OAUTH_READY=0
  if printf '%s\n' "$codex_check" | grep -q '^codex_oauth=present' &&
    printf '%s\n' "$codex_check" | grep -q '^hermes_openai_codex_oauth=present' &&
    printf '%s\n' "$codex_check" | grep -q '^codex_app_server=enabled'; then
    CODEX_OAUTH_READY=1
    ok "codex_oauth_runtime=ready"
  else
    warn "codex_oauth_runtime=not_ready"
  fi

  manager_check=$($COMPOSE --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T hermes-manager node -e '
const base = process.env.HERMES_API_BASE_URL;
if (!base) {
  console.log("manager_upstream=not_configured");
  process.exit(2);
}
fetch(base.replace(/\/+$/, "") + "/health", {
  headers: process.env.HERMES_API_KEY ? { authorization: `Bearer ${process.env.HERMES_API_KEY}` } : {}
}).then(async (response) => {
  console.log(`manager_upstream_http=${response.status}`);
  process.exit(response.ok ? 0 : 3);
}).catch((error) => {
  console.log(`manager_upstream_error=${error.message}`);
  process.exit(4);
});
' 2>/dev/null || true)
  if printf '%s\n' "$manager_check" | grep -q 'manager_upstream_http=2'; then
    ok "$manager_check"
  else
    warn "${manager_check:-manager_upstream_check=failed}"
  fi
else
  warn "docker_compose_check=skipped"
fi

if [ "$PROVIDER_KEY_SET" -eq 0 ] && [ "${CODEX_OAUTH_READY:-0}" -eq 0 ]; then
  warn "provider_auth=missing"
else
  ok "provider_auth=ready"
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
