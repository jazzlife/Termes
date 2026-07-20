# Termes

Termes is an internal AI development platform MVP built around Project First workflows, isolated runners, agent orchestration, approvals, and observable runtime events.

## Local Bootstrap

```bash
pnpm install
pnpm lint
pnpm build
pnpm compose:config
TERMES_BASE_URL=http://127.0.0.1:4180 pnpm test:devices
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

Production mobile PWA:

- Public HTTPS: `https://termes.nado.work`
- Tailscale diagnostic endpoint: `http://100.64.0.9:4180`

The public HTTPS route is the installable PWA endpoint. Android Chrome can use
`Install app`, and iOS Safari can use `Share -> Add to Home Screen`. The
Tailscale HTTP endpoint is reserved for internal smoke and diagnostic commands;
it is not the PWA installation URL.

When Termes is running in a mobile browser, the Task screen and Settings expose
the installation entry directly. Chromium uses its native install prompt when
`beforeinstallprompt` is available; iOS and browsers without that event show the
exact menu path. The installed app launches from the stable `/` manifest start
URL; standalone display-mode detection hides browser-only install UI and reports
`Standalone app` in Settings.

Nginx Proxy Manager should proxy public domains to the web service, and the web container proxies `/api` and `/events` to the internal API service.
The versioned Nginx Proxy Manager server block for the production hostname is
`infra/compose/termes.nado.work.nginx.conf`. It forwards only to the
`termes-web` service on the shared `npm_bridge` Docker network.

The web service serves `manifest.webmanifest`, standalone icons, Apple touch
metadata, and a versioned Service Worker. The Service Worker caches only the
static application shell; `/api`, `/events`, and the Service Worker script are
never runtime-cached.

Do not overwrite `/data/docker_data/termes/app/infra/compose/.env` during source sync. It contains server-local credentials and bind settings.

## GitHub OAuth

The server currently uses this callback URL:

```text
http://100.64.0.9:4180/api/github/oauth/callback
```

Register that exact URL in the GitHub OAuth App settings.

The mobile PWA also supports GitHub Device Code login. It uses the same OAuth
client id and does not require a callback URL.

Browser OAuth is enabled by default when `GITHUB_CLIENT_ID` and
`GITHUB_CLIENT_SECRET_ENC` are configured. Set
`GITHUB_BROWSER_OAUTH_ENABLED=false` only when the browser login route must be
temporarily disabled.

## Device Gateway

`device-gateway` runs inside compose and stores command results under
`/data/docker_data/termes/device-gateway`. The full control path is:

```text
Mobile PWA -> apps/api -> services/device-gateway -> device command result -> DB events/verification
```

External devices are optional for MVP verification. `local_mock` and the Windows
WinRM contract smoke must pass without Android, Tizen, Linux, or Windows
hardware:

```bash
TERMES_BASE_URL=http://100.64.0.9:4180 pnpm test:devices
```

Optional Windows smoke:

```bash
DEVICE_SMOKE_WINDOWS_ENDPOINT=user@windows-host \
DEVICE_SMOKE_WINDOWS_TRANSPORT=ssh \
TERMES_BASE_URL=http://100.64.0.9:4180 \
pnpm test:devices
```

The default smoke also verifies that Windows WinRM returns the contracted
`transport_unavailable` result when no WinRM bridge is installed in the gateway
image. `DEVICE_SMOKE_WINDOWS_TRANSPORT=ssh` verifies the Windows OpenSSH path
when a real Windows endpoint is provided.

Set `DEVICE_ALLOWED_HOSTS` or `WINRM_ALLOWED_HOSTS` in the server-local compose
env to restrict executable network device endpoints. Device command params and
stdout/stderr redact password, token, secret, API key, authorization, and
credential fields before they are stored or returned.

## Official Hermes Agent Upstream

Termes runs in managed Hermes mode when `HERMES_API_BASE_URL` is empty. To route requests to the official Nous Research Hermes Agent container, configure the server-local `infra/compose/.env`:

```env
HERMES_AGENT_API_KEY=<strong-random-key>
HERMES_API_BASE_URL=http://hermes-agent:8642
HERMES_API_KEY=<same-as-HERMES_AGENT_API_KEY>
HERMES_MANAGER_SERVICE_TOKEN=<strong-random-internal-token>
HERMES_DASHBOARD_SESSION_TOKEN=<strong-random-internal-token>
```

OpenAI execution is OAuth-only. Start the upstream profile, then use the Termes
OpenAI account screen. Termes drives the official Codex app-server
`chatgptDeviceCode` flow and the independent Hermes `openai-codex` device-code
flow without exposing either token store to the browser.

The resulting runtime must report `model.provider=openai-codex` and
`model.openai_runtime=codex_app_server`. API-key provider environment variables
are not accepted by the Termes deployment.

Then start the upstream profile:

```bash
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml --profile hermes-upstream up -d --build
```

The Hermes Agent API server and dashboard remain on the internal Docker network.
Realtime JSON-RPC enters through Termes single-use tickets at `/api/hermes/ws`.

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
