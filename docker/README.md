# Docker 部署产物

本目录包含两套 Compose：

| 文件 | 用途 |
|---|---|
| `docker-compose.yml` | 本地开发基础设施（MongoDB、MinIO、Mongo Express，端口绑定 127.0.0.1），配合根目录 `.env` |
| `docker-compose.prod.yml` | 生产部署（应用 + 基础设施），配合 `Dockerfile` 与 `env.prod.example` |

## 生产镜像（`Dockerfile`）

多阶段构建：

1. `frontend`：`npm ci && npm run build`，SPA 产物输出到 `agent_graph/dist`
2. `build`：`uv build --wheel`，把后端代码与前端产物打进同一个 wheel（与
   `tests/integration/test_deployment_artifacts.py` 验证的部署契约一致）
3. `runtime`：`python:3.13-slim` + `uv sync --frozen`（依赖由 `uv.lock` 精确锁定）
   + wheel 安装；非 root（uid 1000）、只读根文件系统、`HEALTHCHECK` 探测 `/health`

运行时镜像保留 `uv`：应用会为 AI 生成的 MCP 工具执行 `uv init/venv/add`
创建独立虚拟环境（见 `agent_graph/app/services/file_manager.py`）。

注意单实例约束：APScheduler 任务存储与图执行注册表均为进程内状态，
禁止 `--workers > 1` 或多副本（`docs/development/backend.md`）。

## 生产部署

```bash
cp docker/env.prod.example .env   # 填入强随机凭据与你的域名
docker compose --env-file .env -f docker/docker-compose.prod.yml up -d --build
curl http://127.0.0.1:${APP_PORT}/health   # 应返回 {"status":"healthy",...}
```

网络边界：

- `agent_graph_network`：项目内部网络，MongoDB/MinIO 不发布任何宿主机端口
- 应用发布在 `127.0.0.1:${APP_PORT}`，对外服务由你自己的 TLS 反向代理提供
- Mongo Express（`MONGO_EXPRESS_PORT`）与 MinIO 控制台（`MINIO_CONSOLE_PORT`）
  仅绑定 127.0.0.1，通过 SSH 隧道访问

### 接入反向代理的注意事项

- **TLS**：应用本身只跑明文 HTTP，证书由代理终止
- **真实客户端 IP**：应用只信任 `FORWARDED_ALLOW_IPS` 所列地址发来的
  `X-Forwarded-For`；请填代理回源地址，其余一律忽略
- **SSE**：`/api/graphs/execute` 与 `/api/agent/run` 是长连接流式端点，
  代理需关闭响应缓冲并把读/空闲超时放宽（建议 ≥ 1h）
- **容器化代理**：若代理是 Docker 容器，用 override 文件把 `app` 接入代理所在的
  网络即可（compose 的 override 只能追加、不能移除条目，因此 `127.0.0.1` 上的
  发布端口会保留——它仅本机可达，也可在自行维护的副本中删掉）
