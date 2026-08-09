# Agent-Graph Frontend

React and Vite frontend for Agent-Graph.

## Development

Create and complete the root `.env` before starting the frontend. Vite reads the following values from that file:

- `FRONTEND_HOST`
- `FRONTEND_PORT`
- `FRONTEND_ALLOWED_HOSTS`
- `BACKEND_PROXY_HOST`
- `PORT`

```bash
npm install
npm run dev
```

API requests under `/api` are proxied to `BACKEND_PROXY_HOST:PORT`.

## Validation and Build

```bash
npm run lint
npm run build
```

The production build is written to `agent_graph/dist/` and served by FastAPI.
