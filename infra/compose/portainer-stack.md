# Portainer Stack

Termes is designed to run from `/data/docker_data/termes/app`, with all source and durable data kept under `/data/docker_data/termes`.

## Paths

- Source: `/data/docker_data/termes/app`
- PostgreSQL: `/data/docker_data/termes/volumes/postgres`
- Redis: `/data/docker_data/termes/volumes/redis`
- MinIO: `/data/docker_data/termes/volumes/minio`
- Workspaces: `/data/docker_data/termes/workspaces`
- Runs: `/data/docker_data/termes/runs`
- Hermes profiles: `/data/docker_data/termes/hermes`
- Backups: `/data/docker_data/termes/backups`
- Logs: `/data/docker_data/termes/logs`

## Deploy

```bash
cd /data/docker_data/termes/app
cp infra/compose/.env.example infra/compose/.env
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build
```

Portainer can use the same compose file. Keep `TERMES_NPM_NETWORK=npm_bridge` on this server so `web` and `api` can join the existing Nginx Proxy Manager network.

For direct Tailscale access on this server, set:

```env
TERMES_WEB_BIND=100.64.0.9
TERMES_WEB_PORT=4180
TERMES_API_BIND=127.0.0.1
TERMES_API_PORT=4181
```

## Official Hermes Agent profile

The stack includes an optional `hermes-upstream` profile for the official Hermes Agent gateway. Use it after adding a Hermes API key and either one model provider key or OpenAI Codex OAuth state to the server-local volumes:

```env
HERMES_AGENT_API_KEY=<strong-random-key>
HERMES_API_BASE_URL=http://hermes-agent:8642
HERMES_API_KEY=<same-as-HERMES_AGENT_API_KEY>
OPENAI_API_KEY=<provider-key>
```

For OpenAI OAuth, the Termes image includes Codex CLI. After the profile starts, run:

```bash
docker exec -it termes-hermes-agent sh -lc 'codex login'
docker exec -it termes-hermes-agent sh -lc 'cd /opt/hermes && /opt/hermes/.venv/bin/hermes auth add openai-codex'
docker exec termes-hermes-agent sh -lc 'cd /opt/hermes && /opt/hermes/.venv/bin/hermes config set model.provider openai-codex && /opt/hermes/.venv/bin/hermes config set model.openai_runtime codex_app_server'
```

Then enable the profile in Portainer or start it from SSH:

```bash
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml --profile hermes-upstream up -d --build
```

Keep the Hermes Agent API server on the internal Docker network. Public traffic should still enter through `termes-web`.

After the profile is healthy, verify the official path from the workstation:

```bash
TERMES_BASE_URL=http://100.64.0.9:4180 pnpm test:hermes:official
```

This command intentionally fails while Termes is only running in managed mode.

If it fails, run the server-side doctor from the app folder:

```bash
cd /data/docker_data/termes/app
sh scripts/hermes-upstream-doctor.sh
```
