# 后端开发

保持职责清晰：HTTP 层验证请求并适配响应，服务层协调业务操作，创建资源的代码负责清理。仅当辅助函数能形成明确的操作边界时再提取，例如准备 Graph 导出包或提交文档版本。

## 运行与测试

后端和基础设施配置统一使用根目录 `.env`，准备步骤见[安装指南](../first-steps/install.zh.md)。

```bash
uv sync
uv run --env-file .env fastapi dev
```

在仓库根目录运行检查：

```bash
uv run pytest
uv run --with mkdocs-material --with mkdocs-git-revision-date-localized-plugin --with mkdocs-static-i18n mkdocs build --strict
```

交互式 API 文档位于 `/docs`，运行中的应用通过 `/openapi.json` 提供接口 schema。

## 进程边界

使用内嵌调度器时，部署一个应用实例，并只运行一个 API worker。APScheduler 任务存储和 Graph 执行注册表都在进程内；多个 worker 或副本可能加载同一批任务，导致重复触发。

Graph 注册表保证同一会话整次运行只有一个写入者，覆盖状态修改和清理。同一会话的并发执行会被拒绝，不同会话可以并发。响应开始前，执行冲突使用 HTTP 409，关闭期间使用 HTTP 503；SSE 响应已开始时，这些拒绝通过流内错误事件表达。这些机制不协调多个进程；增加 worker 前，需要共享执行归属与独立的调度设计。

## 异步 I/O 边界

Motor 数据库操作保留在事件循环；同步 MinIO、ZIP、数据集转换、文件 I/O 和 bcrypt 工作需要显式线程边界。在 `async def` 中调用普通辅助函数，并不会自动把它移到线程。[FastAPI：普通辅助函数](https://fastapi.tiangolo.com/async/#other-utility-functions)。

卸载完整的同步操作，包括 SDK 惰性迭代、读取响应体和释放连接。只卸载 `get_object()` 或 `list_objects()`，会让后续网络操作继续阻塞事件循环。

取消 await 不会终止工作线程。如果线程持有文件或返回新写入的对象版本，清理前应等待结果确定。归档操作使用 `run_archive_io`，文档服务使用 `write_document` 协调存储版本和元数据。不要在线程仍写入时删除临时目录。

## 资源生命周期

应用通过 FastAPI lifespan 协调启动和关闭。[FastAPI：生命周期事件](https://fastapi.tiangolo.com/advanced/events/)。

| 资源 | 所有者与完成边界 |
|------|----------------|
| 调度任务 | `TaskScheduler.shutdown()` 停止触发，等待任务清理与调度器关闭 |
| Graph 执行 | 执行注册表持有前台和后台任务，直到它们退出 |
| MCP 连接 | 专属 owner task 进入和退出传输、会话与异步上下文栈 |
| MinIO 响应 | 读取操作在 `finally` 中关闭响应并释放连接 |
| 临时 ZIP | 生成者持有目录，成功后移交 `TemporaryArchiveResponse`；响应在完成、异常或取消时清理 |
| 文档版本 | 元数据确认写入；失败仅撤销本次返回的版本 ID |

关闭顺序为调度器 → Graph 执行 → MCP → MongoDB。每个阶段应先完成资源清理，再关闭它依赖的存储。启动失败也会进入清理路径。

文档补偿不是跨 MongoDB 和 MinIO 的事务。它只处理本次创建的精确版本，保留旧版本和其他并发写入；请求取消期间若元数据已经提交，则保留该确认版本。存储故障也可能阻止补偿，需要记录失败版本以便排查。

## 验证与失败语义

在产生副作用前验证名称、数据形状、限制、归属和调度配置。服务层也必须保护内部调用，不能只依赖 HTTP 路由。例如，导出列表混有其他用户的会话时，必须在格式化或上传正文前拒绝整次导出。

请求边界保留明确的 HTTP 错误。流式响应开始后，用流协议表达执行失败，不再尝试发送另一个 HTTP 状态。[FastAPI：错误处理](https://fastapi.tiangolo.com/tutorial/handling-errors/)。

Graph 执行失败发送 `execution_error`，不发送 `graph_complete`；路由在能够结束流时发送一次 `[DONE]`，不能保证已断开的客户端收到它。后台 Graph 失败保存 `execution_status=failed`、`execution_error` 和 `completed=false`，取消记录为 interrupted。单次调度任务在至少一个 Graph 实例成功启动后标记为 `completed`，最终结果应查看对应会话。

Refresh token 轮换通过一次条件数据库更新消费旧令牌，只有竞争成功的请求能够签发新令牌。登录和刷新必须等新 refresh token 持久化成功后才返回。将这些保证放在仓储和服务边界，不使用进程内锁代替数据库条件写。

## 取消与回归测试

消费者退出时显式关闭内层模型、工具和执行生成器。清理后传播取消，不将取消转换为成功完成。FastAPI 负责迭代流，应用创建的资源仍需自己的生命周期管理。[FastAPI：StreamingResponse](https://fastapi.tiangolo.com/advanced/custom-response/#streamingresponse)。

用受控事件暂停同步操作，验证事件循环仍能推进。测试可观察结果：连接释放、临时目录删除、对象版本保留、任务终态，以及失败后不出现成功事件。覆盖正常完成、依赖失败、取消、断开连接和重复关闭；当 mock 会掩盖生命周期时，使用真实 ASGI 响应和调度器验证。

针对性示例位于 `tests/unit/test_document_io_offload.py`、`test_document_consistency.py`、`test_archive_response_lifecycle.py`、`test_task_scheduler.py`、`test_auth_service.py` 和 `test_mcp_client_lifecycle.py`。完整集成测试和真实 E2E 与这些测试互补；进程终止或存储不可用需要单独验证恢复行为。
