# Checkpoint 5 — Production API and Web deployment

- Application release source: `3e278c1c9447db259434736cb12091fbc52aef9b`
- Production host: `ai-turtle`
- Production source path: `/data/docker_data/termes/app`
- Public origin: `https://termes.nado.work`

## Release correction

A clean `git archive` build exposed that the workstation-wide `packages/*` ignore rule had excluded the required `packages/eventing` workspace from version control. The package and its explicit repository ignore exceptions were committed before deployment. A fresh lint, test, production build, API image build, and Web image build all passed from the corrected source.

## Deployment

The exact Git archive was checksummed after transfer, rendered successfully with the protected production environment, and synchronized to the stable production source path. Existing API and Web image IDs were retained under timestamped rollback tags before the new images were built.

Only the API and Web services were recreated. Database migrations had already been applied and restore-tested in Checkpoint 4.

## Verification

Post-deployment checks confirmed:

- production source marker matches the application release source
- API container is running, healthy, and has zero restarts
- Web container is running and has zero restarts
- no unhealthy Termes containers
- all 20 migrations remain recorded
- no API or Web error/fatal/exception messages appeared after deployment
- public API health reports PostgreSQL and Redis healthy
- public Web shell, PWA manifest, and hashed JavaScript asset return successfully
- anonymous session returns a null principal
- connector management routes reject unauthenticated requests

The first public Connector WebSocket probe exposed a reverse-proxy defect: the inner Termes Nginx upgraded successfully, while the manually managed Nginx Proxy Manager server block forwarded the client `Connection` header verbatim and returned HTTP 404. The versioned `infra/compose/termes.nado.work.nginx.conf` now has an exact Connector WebSocket location that forces HTTP/1.1 `Connection: upgrade`, disables buffering/cache, and retains one-hour transport timeouts.

After syntax validation and Nginx Proxy Manager reload:

- direct Nginx Proxy Manager probe returns `101 Switching Protocols`
- public `wss://termes.nado.work/api/desktop-connectors/connect` upgrades successfully
- an unauthenticated public Connector socket is closed by the API with the expected code `4401`
- public HTTP health and Web shell remain healthy
