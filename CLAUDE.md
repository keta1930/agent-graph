# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Backend (Python 3.11+, uv):
- `uv sync` — install dependencies
- `python agent_graph/main.py` — start API server on :20050
- `python agent_graph/scripts/generate_jwt_secret.py` — generate JWT secret key

Frontend (Node, npm):
- `cd frontend && npm install && npm run dev` — start Vite dev server on :20051 (proxies API to localhost:20050)
- `npm run build` — production build outputs to `agent_graph/dist/`
- `npm run lint` — ESLint with TypeScript strict rules

Infrastructure:
- `docker compose -f docker/agent_graph_services/docker-compose.yml up -d` — start MongoDB, MinIO, Milvus, and admin UIs

Docs:
- `mkdocs build` — build documentation site

## Architecture

- FastAPI serves both REST API (`/api/`) and the pre-built frontend from `agent_graph/dist/`
- Backend config loads from `docker/agent_graph_services/.env` (see `.env.example` for required vars)
- Auth uses JWT access + refresh tokens; three roles: super_admin, admin, normal

## Git conventions

GitHub Flow: feature branches off `master`, PR with review before merge.

## No test or format infrastructure

- No test framework is configured (no pytest, jest, vitest). Do not run test commands.
- No Python formatter or linter is configured. ESLint is frontend-only.
