# Nginx Proxy Manager

Termes exposes the web service on the existing Docker network configured by `TERMES_NPM_NETWORK`, which is `npm_bridge` on the target server.

Recommended proxy host:

- Domain: your chosen Termes domain
- Forward Hostname / IP: `termes-web`
- Forward Port: `80`
- Scheme: `http`
- Websockets Support: enabled
- Block Common Exploits: enabled

Advanced config for SSE:

```nginx
proxy_buffering off;
proxy_cache off;
proxy_read_timeout 1h;
```

Do not expose Hermes Manager, Runner Supervisor, PostgreSQL, Redis, or MinIO publicly.
