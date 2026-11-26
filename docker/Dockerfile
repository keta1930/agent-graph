# syntax=docker/dockerfile:1
# Agent-Graph 应用镜像：多阶段构建。
#
#   frontend  — Vite 构建 SPA，产物输出到 agent_graph/dist
#   build     — 连同 dist 一起打成 wheel（与仓库部署契约一致，见
#               tests/integration/test_deployment_artifacts.py）
#   runtime   — slim Python + uv.lock 精确安装的依赖 + wheel；非 root 运行
#
# 运行时保留 uv：应用会为 AI 生成的 MCP 工具在 AGENT_GRAPH_DIR 下执行
# `uv init/venv/add` 创建独立虚拟环境（agent_graph/app/services/file_manager.py）。

# ---------- frontend ----------
FROM node:22-alpine AS frontend
WORKDIR /src/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# vite.config.ts 将构建产物写到 ../agent_graph/dist
RUN npm run build

# ---------- build ----------
# ghcr.io/astral-sh/uv 无 shell，只从中拷贝 uv 二进制，构建阶段用 python 基底
FROM python:3.13-slim-bookworm AS build
COPY --from=ghcr.io/astral-sh/uv:0.9.29 /uv /uvx /usr/local/bin/
WORKDIR /src
COPY pyproject.toml uv.lock README.md LICENSE ./
COPY agent_graph/ ./agent_graph/
COPY --from=frontend /src/agent_graph/dist ./agent_graph/dist
RUN uv build --wheel --out-dir /out

# ---------- runtime ----------
FROM python:3.13-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.9.29 /uv /uvx /usr/local/bin/
ENV UV_NO_PROGRESS=1 \
    PATH="/app/.venv/bin:$PATH" \
    AGENT_GRAPH_DIR=/var/lib/agent-graph \
    HOME=/var/lib/agent-graph
WORKDIR /app
# 先装第三方依赖（命中层缓存，改代码不重装）
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
# 再装应用 wheel（含前端产物）
COPY --from=build /out/*.whl /tmp/
RUN uv pip install --no-deps /tmp/*.whl && rm -f /tmp/*.whl

RUN useradd --uid 1000 --user-group --home-dir /var/lib/agent-graph --shell /usr/sbin/nologin agentgraph \
    && install -d -o agentgraph -g agentgraph /var/lib/agent-graph

USER 1000:1000
EXPOSE 8000
VOLUME /var/lib/agent-graph
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
    CMD ["python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).read()"]
# 单实例约束：APScheduler 与图执行注册表都是进程内状态，禁止多 worker/多副本
CMD ["uvicorn", "agent_graph.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
