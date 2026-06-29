# Termes

Termes is an internal AI development platform MVP built around Project First workflows, isolated runners, agent orchestration, approvals, and observable runtime events.

## Local Bootstrap

```bash
pnpm install
pnpm lint
pnpm build
pnpm compose:config
```

## Server Deploy

The compose stack is defined at `infra/compose/docker-compose.yml`.
Source and durable data are kept under `/data/docker_data/termes`.

```bash
cd /data/docker_data/termes/app
cp infra/compose/.env.example infra/compose/.env
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build
```

Default local endpoints on the server:

- Web: `http://127.0.0.1:4180`
- API: `http://127.0.0.1:4181/healthz`

Nginx Proxy Manager should proxy public domains to the web service, and the web container proxies `/api` and `/events` to the internal API service.

Do not overwrite `/data/docker_data/termes/app/infra/compose/.env` during source sync. It contains server-local credentials and bind settings.

## Official Hermes Agent Upstream

Termes runs in managed Hermes mode when `HERMES_API_BASE_URL` is empty. To route requests to the official Nous Research Hermes Agent container, configure the server-local `infra/compose/.env`:

```env
HERMES_AGENT_API_KEY=<strong-random-key>
HERMES_API_BASE_URL=http://hermes-agent:8642
HERMES_API_KEY=<same-as-HERMES_AGENT_API_KEY>
# Either configure a provider key:
OPENAI_API_KEY=<provider-key>
# or OPENROUTER_API_KEY / ANTHROPIC_API_KEY
```

For the OpenAI OAuth path, Termes uses the bundled Hermes Agent image with
`codex` installed and persistent state under `/data/docker_data/termes/hermes-agent`.
Complete both auth stores inside the `termes-hermes-agent` container, then set
Hermes to the Codex app-server runtime:

```bash
docker exec -it termes-hermes-agent sh -lc 'codex login'
docker exec -it termes-hermes-agent sh -lc 'cd /opt/hermes && /opt/hermes/.venv/bin/hermes auth add openai-codex'
docker exec termes-hermes-agent sh -lc 'cd /opt/hermes && /opt/hermes/.venv/bin/hermes config set model.provider openai-codex && /opt/hermes/.venv/bin/hermes config set model.openai_runtime codex_app_server'
```

Then start the upstream profile:

```bash
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml --profile hermes-upstream up -d --build
```

The Hermes Agent API server listens inside Docker at `http://hermes-agent:8642`; keep it internal and let Termes proxy `/api/hermes/*`.

Verify the official upstream path from the workstation:

```bash
TERMES_BASE_URL=http://100.64.0.9:4180 pnpm test:hermes:official
```

`pnpm test:hermes` verifies the managed compatibility surface. `pnpm test:hermes:official` is the completion gate for the official Hermes Agent path because it fails unless `/api/hermes/upstream/diagnostics` reports `ready=true`.

To diagnose a server that is not ready, run either command:

```bash
pnpm doctor:hermes:upstream

# On the server, no Node.js host install is required:
cd /data/docker_data/termes/app
sh scripts/hermes-upstream-doctor.sh
```
