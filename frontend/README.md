# Agent-Graph Frontend

React and Vite frontend for Agent-Graph.

Use Node.js 22. Run the commands below from `frontend/`.

## Development

Create and complete the root `.env` before starting the frontend. Vite reads the following values from that file:

- `FRONTEND_HOST`
- `FRONTEND_PORT`
- `FRONTEND_ALLOWED_HOSTS`
- `BACKEND_PROXY_HOST`
- `PORT`

```bash
npm ci
npm run dev
```

API requests under `/api` are proxied to `BACKEND_PROXY_HOST:PORT`.

## Validation and Build

Tests require Python 3.11+ and `uv` in addition to Node.js. Install the root project's locked Python dependencies before running Vitest:

```bash
uv sync --locked --project ..
```

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

`npm run check` runs all four checks. ESLint rejects warnings, and production builds include TypeScript checking. Use `npm run test:watch` while developing tests; Vitest uses jsdom and does not require a root `.env` or a running backend.

The SSE contract tests run `tests/contracts/export_sse_contract.py` through `uv` on every run. They pass output from the real Python SDK and Agent stream producer to the frontend parser and reducer. Model HTTP requests and persistence use isolated test dependencies; missing Python dependencies fail the test. CI installs both toolchains and runs these tests when frontend code, backend code, contract tests, or Python dependencies change.

The production build is written to `agent_graph/dist/` and served by FastAPI. To validate a build without replacing those assets, specify a separate output directory:

```bash
npm run build -- --outDir /absolute/path/to/build-output
```

Development runs the app in React StrictMode. Effects and subscriptions must clean up when components unmount. The application entry loads the Ant Design v5 compatibility patch for React 19, including static message, notification, and confirmation APIs.
