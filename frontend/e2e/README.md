# Real backend browser acceptance

From the repository root, install the locked Python environment with `uv sync --locked`.
Then run:

```sh
cd frontend
npm ci
npx playwright install --with-deps chromium
npm run typecheck:e2e
npm run test:e2e
```

Requires Linux, Python 3.11+, Node 22, uv, and a running Docker daemon. The same command runs in `.github/workflows/real-e2e.yml`. Tests use `.e2e.ts`, so existing Vitest discovery is unchanged. No global browser CLI or pre-existing app service is required.

The runner refuses occupied ports 20053–20058. It starts uniquely named MongoDB and MinIO containers, a private API/MCP client, an HTTP model upstream, and Vite. Ports 20050–20052 and existing app data are left alone. The temporary database, bucket and generated credentials belong to that invocation. Expired JWTs are signed only with that invocation's generated secret. Scheduled-task fixtures use a far-future date, are immediately paused and are deleted after the case. API configuration comes from an explicit environment whitelist and private working directory, never the repository `.env`.

The suite includes ordinary Agent/Graph chat, twelve repeated early Graph next-round draft checks, nullable tool/reasoning streams, error/cancel recovery, model edits, graph inheritance, project file versions, 201-Agent pagination, management pages, anonymous sharing/ZIP downloads, JWT refresh and cross-tab identity changes. It is a focused contract suite, not every UI race or third-party integration.

Browser requests use real authentication, FastAPI routes, executors, SSE producers, MongoDB persistence, and MinIO. No application API is intercepted. The external model HTTP upstream is deterministic; the tool scenario additionally registers a controlled arithmetic MCP tool through the real MCP client. These tests verify transport and application behavior, not a commercial model's response quality or an external MCP provider's reliability.

Evidence defaults to `.file/e2e/real-*/artifacts/`. Override it with `npm run test:e2e -- --output /path/to/new-directory`. Safe artifacts contain raw test SSE, screenshots, model request metadata without headers, and redacted service logs. Trace and video are disabled because they can include authorization headers. Private generated credentials stay in the sibling `runtime/` directory with mode 0700 and must not be published; CI uploads only `artifacts/`.

A focused diagnostic run is available with `npm run test:e2e -- --grep "model edit"`; it does not replace the default complete acceptance run or its final direct Mongo/wire verification.

The runner records owned container names/IDs and process IDs in `artifacts/services.json`. Normal exit and SIGINT/SIGTERM run cleanup, including the MCP client's separate process group. It never adopts or kills a service merely because it occupies a port. SIGKILL or host failure cannot run cleanup: inspect the recorded ownership and Docker `agent-graph-e2e` label before manually removing exactly that run's resources. The MongoDB and MinIO images declare anonymous data volumes. The runner records their names and removes owned containers with `docker rm --force --volumes`; it verifies that the recorded volumes, labeled containers and owned ports are gone before setting `cleanup_complete`. Cleanup or verification failures fail the run. For manual cleanup after SIGKILL or host failure, use `docker rm --force --volumes <owned-container-id>` after checking ownership. Never prune unrelated volumes. Local evidence can be removed after review.

For an explicit local optimization, `E2E_CHROMIUM_EXECUTABLE` may point at an existing Chromium. CI uses the Playwright-managed matching version.
