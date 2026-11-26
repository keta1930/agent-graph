# Docker Deployment Artifacts

This directory contains two Compose setups:

| File | Purpose |
|---|---|
| `docker-compose.yml` | Local development infrastructure (MongoDB, MinIO, Mongo Express; ports bound to 127.0.0.1), used with the root `.env` |
| `docker-compose.prod.yml` | Production deployment (app + infrastructure), used with `Dockerfile` and `env.prod.example` |

[中文版](README_CN.md)

## Production Image (`Dockerfile`)

Multi-stage build:

1. `frontend`: `npm ci && npm run build`, SPA output written to `agent_graph/dist`
2. `build`: `uv build --wheel`, packing the backend code and the frontend assets
   into a single wheel (the same deployment contract verified by
   `tests/integration/test_deployment_artifacts.py`)
3. `runtime`: `python:3.13-slim` + `uv sync --frozen` (dependencies pinned by
   `uv.lock`) + the wheel; runs as non-root (uid 1000) with a read-only root
   filesystem and a `HEALTHCHECK` probing `/health`

The runtime image keeps `uv`: the app runs `uv init/venv/add` to create isolated
virtual environments for AI-generated MCP tools (see
`agent_graph/app/services/file_manager.py`).

Single-instance constraint: the APScheduler job store and the graph-execution
registry are process-local state — `--workers > 1` and multiple replicas are not
supported (`docs/development/backend.md`).

## Production Deployment

```bash
cp docker/env.prod.example .env   # fill in strong random credentials and your domain
docker compose --env-file .env -f docker/docker-compose.prod.yml up -d --build
curl http://127.0.0.1:${APP_PORT}/health   # should return {"status":"healthy",...}
```

Network boundaries:

- `agent_graph_network`: internal project network; MongoDB and MinIO publish no
  host ports at all
- The app is published on `127.0.0.1:${APP_PORT}`; public serving is provided by
  your own TLS reverse proxy
- Mongo Express (`MONGO_EXPRESS_PORT`) and the MinIO console
  (`MINIO_CONSOLE_PORT`) bind to 127.0.0.1 only, reached through an SSH tunnel

### Reverse-Proxy Requirements

- **TLS**: the app serves plain HTTP only; certificates are terminated at the proxy
- **Real client IP**: the app trusts `X-Forwarded-For` only from the addresses
  listed in `FORWARDED_ALLOW_IPS` — set it to your proxy's upstream address
- **SSE**: `/api/graphs/execute` and `/api/agent/run` are long-lived streaming
  endpoints; disable response buffering at the proxy and raise read/idle timeouts
  (1h or more is recommended)
- **Containerized proxy**: if the proxy is a Docker container, use an override
  file to attach `app` to the proxy's network (Compose overrides can only append,
  never remove entries, so the `127.0.0.1` published port stays — it is reachable
  from localhost only, and can be dropped in your own copy)
