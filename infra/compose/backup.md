# Backup

All durable Termes data is under `/data/docker_data/termes`.

Minimum backup set:

- `/data/docker_data/termes/volumes/postgres`
- `/data/docker_data/termes/volumes/redis`
- `/data/docker_data/termes/volumes/minio`
- `/data/docker_data/termes/workspaces`
- `/data/docker_data/termes/runs`
- `/data/docker_data/termes/hermes`
- `/data/docker_data/termes/app/infra/compose/.env`

The `backup` container currently reserves `/data/docker_data/termes/backups` for scheduled backup implementation.
