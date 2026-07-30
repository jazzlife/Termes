# Checkpoint 4 — Production backup and schema migration

- Release candidate before this checkpoint: `5239cdd9ea70f345b249bbd349fd6998a6cd8195`
- Production host: `ai-turtle`
- Production source path: `/data/docker_data/termes/app`
- Backup path: `/data/docker_data/termes/backups/releases/20260730T045059Z-5239cdd9ea70f345b249bbd349fd6998a6cd8195`
- `SHA256SUMS` digest: `c1afbf6ce79f8f594fb189eba68b5cb93a546d88ca692ed817d6f5c7792ff299`

## Backup evidence

The protected release directory contains:

- PostgreSQL custom-format dumps from before and after migration
- exact pre-deployment source archive, excluding generated dependency/build directories
- protected deployment environment snapshot
- rendered pre-deployment Compose configuration
- MinIO data archive
- desktop-artifact archive
- before/after migration inventories
- checksums and an executable restore-command template

Both PostgreSQL dumps passed `pg_restore --list` and were restored into disposable PostgreSQL 16 containers. Row-count probes matched production before migration. The post-migration restore contained 20 migration records, two account-owner member rows, and zero connector rows.

## Migration evidence

The exact `019_member_lifecycle.sql` and `020_desktop_connectors.sql` files were first executed against the live production schema inside `BEGIN`/`ROLLBACK`. The preflight completed without data or constraint conflicts and left the production migration count at 18.

The migrations were then applied together under a PostgreSQL advisory transaction lock and recorded in `schema_migrations`:

- `019_member_lifecycle`
- `020_desktop_connectors`

Post-migration checks confirmed:

- two approved owner member rows migrated from the two existing accounts
- no member credentials created implicitly
- desktop pairing, connector, and receipt tables empty
- both Windows and macOS connector capability packages present
- all updated device and command constraints validated
- existing API healthy against PostgreSQL and Redis through both the local and public health endpoints

No API, Web, or connector application deployment was performed in this checkpoint.
