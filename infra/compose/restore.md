# Restore

Restore onto a host with Docker and Docker Compose installed.

1. Stop the stack.

```bash
cd /data/docker_data/termes/app
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml down
```

2. Restore the backed up `/data/docker_data/termes` directories.
3. Start the stack.

```bash
docker compose --env-file infra/compose/.env -f infra/compose/docker-compose.yml up -d --build
```

4. Verify:

```bash
curl -fsS http://127.0.0.1:4181/healthz
curl -fsS http://127.0.0.1:4180/
```
