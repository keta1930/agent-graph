This file provides guidance to AI coding agents when working with code in this repository.

## Commands

Backend (Python 3.11+, uv):
- `uv sync` — install dependencies
- `uv run --env-file .env fastapi run` — start the production API server using `PORT`
- `uv run --env-file .env fastapi dev` — start the development API server with reload
- `python agent_graph/scripts/generate_jwt_secret.py` — generate JWT secret key
- `uv run pytest` — run tests (unit in `tests/unit/`, integration in `tests/integration/`)

Frontend (Node, npm):
- `cd frontend && npm install && npm run dev` — start Vite using the root `.env`
- `npm run build` — production build outputs to `agent_graph/dist/`
- `npm run lint` — ESLint with TypeScript strict rules

Infrastructure:
- `docker compose --env-file .env -f docker/docker-compose.yml up -d` — start MongoDB, Mongo Express, and MinIO (reads config from root `.env`)

Docs:
- `mkdocs build` — build documentation site

## Architecture

- FastAPI serves both REST API (`/api/`) and the pre-built frontend from `agent_graph/dist/`
- All config lives in a single root `.env` (backend settings + MongoDB/MinIO container params). Copy `.env.example` to `.env` and fill in values before first run; both the API server and `docker compose --env-file .env` read from it.
- The backend, frontend, and internal MCP client ports are configured through the root `.env`.
- Auth uses JWT access + refresh tokens; three roles: super_admin, admin, normal

## Git conventions

GitHub Flow: feature branches off `master`, PR with review before merge.

## Test and format infrastructure

- Backend tests use pytest; run with `uv run pytest`. Unit tests live in `tests/unit/`, integration tests in `tests/integration/`.
- Coverage is available on demand: `uv run pytest --cov=agent_graph`.
- No Python formatter or linter is configured. ESLint is frontend-only.
