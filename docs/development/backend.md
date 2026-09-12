# Backend Development

Keep responsibilities explicit: HTTP handlers validate requests and adapt responses, services coordinate business operations, and the code that creates a resource owns its cleanup. Extract a helper when it gives a concrete operation a clear boundary, such as preparing a Graph package or committing a document version.

## Running and Testing

Use the root `.env` for backend and infrastructure configuration. See [Installation](../first-steps/install.md) for setup.

```bash
uv sync
uv run --env-file .env fastapi dev
```

Run checks from the repository root:

```bash
uv run pytest
uv run --with mkdocs-material --with mkdocs-git-revision-date-localized-plugin --with mkdocs-static-i18n mkdocs build --strict
```

Interactive API documentation is available at `/docs`; the running application publishes its schema at `/openapi.json`.

## Process Boundaries

Deploy one API worker in one application instance when using the embedded scheduler. Its APScheduler job store and the Graph execution registry are process-local. Multiple workers or replicas can load the same scheduled tasks and execute them more than once.

The Graph registry grants one writer per conversation for the entire run, including state changes and cleanup. A concurrent run of that conversation is rejected; other conversations may run concurrently. Before a response starts, conflicts use HTTP 409 and shutdown uses HTTP 503. Once an SSE response has started, these rejections use stream error events. This provides no coordination between processes. Horizontal scaling requires shared execution ownership and a separate scheduling design before adding workers.

## Async I/O Boundaries

Motor database operations stay on the event loop. Synchronous MinIO calls, ZIP operations, dataset conversion, file I/O, and bcrypt work need an explicit thread boundary. A normal helper called by an `async def` function does not move to a thread automatically. [FastAPI: utility functions](https://fastapi.tiangolo.com/async/#other-utility-functions).

Offload the complete synchronous operation, including lazy SDK iteration, reading the response body, and releasing its connection. Offloading only `get_object()` or `list_objects()` leaves subsequent network work on the event loop.

A cancelled await does not terminate its worker thread. When that worker owns files or returns a newly written object version, wait for a definite outcome before cleanup. Archive operations use `run_archive_io`; document services use `write_document` to coordinate the stored version and metadata. Do not delete a temporary directory while a worker is still writing into it.

## Resource Lifetimes

Application startup and shutdown are coordinated through FastAPI lifespan. [FastAPI: lifespan events](https://fastapi.tiangolo.com/advanced/events/).

| Resource | Owner and completion boundary |
|----------|-------------------------------|
| Scheduled jobs | `TaskScheduler.shutdown()` stops triggers and waits for job cleanup and scheduler shutdown |
| Graph execution | The execution registry holds foreground/background tasks until they exit |
| MCP connection | A dedicated owner task enters and exits its transport, session, and async context stack |
| MinIO response | The reading operation closes the response and releases the connection in `finally` |
| Temporary ZIP | The producer owns its directory until it hands it to `TemporaryArchiveResponse`; the response cleans up on completion, failure, or cancellation |
| Document version | Metadata must confirm the write; failed writes discard only the newly returned version ID |

Shutdown proceeds through scheduler → Graph execution → MCP → MongoDB. Each stage must finish its resource cleanup before dependent storage is closed. Startup failure also enters the cleanup path.

Document compensation is not a transaction across MongoDB and MinIO. It preserves old and concurrent versions by addressing the exact version created by the operation. If metadata commits while a request is being cancelled, that confirmed version remains. A storage outage can also prevent compensation; log the failed version so it can be investigated.

## Validation and Failure Semantics

Validate names, shapes, limits, ownership, and schedule configuration before side effects. Services must enforce ownership for internal callers as well as HTTP routes. For example, a mixed list of owned and foreign conversations fails export before any conversation body is formatted or uploaded.

Preserve intentional HTTP errors at the request boundary. Once a streaming response has started, report execution failure using the stream protocol rather than a new HTTP status. [FastAPI: handling errors](https://fastapi.tiangolo.com/tutorial/handling-errors/).

A Graph execution failure emits `execution_error` and no `graph_complete`. The route emits the terminal `[DONE]` marker once when it can finish the stream; a disconnected client cannot be promised delivery. Background Graph failures persist `execution_status=failed`, `execution_error`, and `completed=false`; cancellation records an interrupted run. A scheduled single task is `completed` after at least one Graph instance starts, so inspect its conversations for final execution results.

Refresh token rotation uses one conditional database update to consume the old token. Only the winning request may issue a replacement, and login/refresh return tokens only after the new refresh token is persisted. Keep these guarantees in the repository and service boundaries rather than an in-process lock.

## Cancellation and Regression Tests

Close nested model, tool, and execution generators explicitly when their consumer exits. Propagate cancellation after cleanup; do not convert it into successful completion. FastAPI streams an iterator, but application-owned resources still need their own lifetime management. [FastAPI: StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse).

Use controlled events to hold a synchronous operation and prove that the event loop can still advance. Test observable outcomes: released connections, removed temporary directories, preserved object versions, final task status, and absence of success events after failure. Cover normal completion, dependency failure, cancellation, disconnect, and repeated shutdown. Exercise ASGI responses and a real scheduler where mocks would hide their lifecycle behavior.

Focused examples live in `tests/unit/test_document_io_offload.py`, `test_document_consistency.py`, `test_archive_response_lifecycle.py`, `test_task_scheduler.py`, `test_auth_service.py`, and `test_mcp_client_lifecycle.py`. Full integration and real E2E runs complement these tests; process termination or unavailable storage require separate recovery checks.
