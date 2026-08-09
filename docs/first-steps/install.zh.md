# 安装

## 系统要求

安装前请确保系统满足以下要求:

| 组件 | 要求                              |
|------|---------------------------------|
| 操作系统 | Linux、macOS 或 Windows (需要 WSL2) |
| Docker | 20.10+ 版本,包含 Docker Compose     |
| Python | 3.11+ 版本                        |
| 内存 | 最低 4GB (推荐 8GB)                 |
| 存储空间 | 至少 10GB 可用空间                    |

## 安装步骤

### 1. 克隆仓库

```bash
git clone https://github.com/keta1930/agent-graph.git
cd agent-graph
```

### 2. 配置环境

项目根目录下的单个 `.env` 文件同时配置后端和 Docker 服务（MongoDB 和 MinIO）。

```bash
cp .env.example .env
```

编辑 `.env` 文件配置必要参数:

| 配置项 | 说明 | 示例 |
|--------|------|------|
| APP_NAME | FastAPI 对外显示的应用名称 | Agent-Graph |
| APP_VERSION | FastAPI 对外显示的应用版本 | 3.0.0 |
| PORT | FastAPI 监听端口 | 20050 |
| PUBLIC_API_BASE_URL | 生成外部集成时使用的后端公开地址 | http://127.0.0.1:20050 |
| MCP_CLIENT_HOST | 内部 MCP client 监听地址 | 127.0.0.1 |
| MCP_CLIENT_PORT | 内部 MCP client 端口 | 20052 |
| FRONTEND_HOST | Vite 开发及预览服务监听地址 | 0.0.0.0 |
| FRONTEND_PORT | Vite 开发及预览服务端口 | 20051 |
| BACKEND_PROXY_HOST | Vite 开发代理连接的后端主机 | 127.0.0.1 |
| FRONTEND_ALLOWED_HOSTS | Vite 开发服务器允许的 Host | localhost,127.0.0.1 |
| CORS_ORIGINS | 允许的浏览器 Origin（逗号分隔） | http://localhost:20051 |
| MONGODB_URL | 后端使用的 MongoDB 连接 URL（凭据须与 MONGO_ROOT_* 一致） | mongodb://admin:strongpassword123@localhost:20040/ |
| MONGODB_DB | 后端 MongoDB 数据库名称 | agent-graph |
| MONGO_ROOT_USERNAME | MongoDB 管理员用户名（容器初始化） | admin |
| MONGO_ROOT_PASSWORD | MongoDB 管理员密码（容器初始化） | strongpassword123 |
| MONGO_DATABASE | 首次初始化 MongoDB 时创建的数据库 | agent-graph |
| MONGO_PORT | MongoDB 服务端口 | 20040 |
| MONGO_EXPRESS_PORT | 数据库管理界面端口 | 20041 |
| MONGO_EXPRESS_USERNAME | Mongo Express 管理界面用户名 | admin |
| MONGO_EXPRESS_PASSWORD | Mongo Express 管理界面密码 | strongpassword123 |
| MINIO_ENDPOINT | 后端使用的 MinIO 端点（host:port） | localhost:20042 |
| MINIO_ACCESS_KEY | MinIO 访问密钥（须与 MINIO_ROOT_USER 一致） | minioadmin |
| MINIO_SECRET_KEY | MinIO 密钥（须与 MINIO_ROOT_PASSWORD 一致） | minioadmin123 |
| MINIO_BUCKET_NAME | 应用存储对象使用的 bucket | agent-graph |
| MINIO_ROOT_USER | MinIO 管理员用户名（容器初始化） | minioadmin |
| MINIO_ROOT_PASSWORD | MinIO 管理员密码（容器初始化） | minioadmin123 |
| MINIO_API_PORT | MinIO API 端口 | 20042 |
| MINIO_CONSOLE_PORT | MinIO 控制台端口 | 20043 |
| MINIO_SECURE | MinIO 客户端是否启用 TLS | false |
| JWT_SECRET_KEY | 认证安全密钥（至少 32 字符） | 使用脚本生成 |
| JWT_ALGORITHM | JWT 签名算法 | HS256 |
| JWT_ACCESS_TOKEN_EXPIRE_MINUTES | Access Token 有效期（分钟） | 15 |
| JWT_REFRESH_TOKEN_EXPIRE_DAYS | Refresh Token 有效期（天） | 7 |
| ADMIN_USERNAME | 超级管理员用户名 | admin |
| ADMIN_PASSWORD | 超级管理员密码（至少 12 字符） | securepassword |

`.env.example` 中留空的值均为必填项。运行 `python agent_graph/scripts/generate_jwt_secret.py` 生成 `JWT_SECRET_KEY`，并在启动任何服务前设置唯一密码。

> **注意：** `PORT` 应与 `PUBLIC_API_BASE_URL` 一致，`FRONTEND_PORT` 应与 `CORS_ORIGINS` 一致；后端存储端点也必须与对应的 Docker 凭据和端口一致。

### 3. 启动 Docker 服务

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

使用示例端口时，可通过以下地址验证服务：

- MongoDB Express: http://localhost:20041
- MinIO 控制台: http://localhost:20043

### 4. 部署后端

安装后端依赖:

**使用 uv (推荐):**

```bash
uv sync

uv run --env-file .env fastapi run
```

**使用 pip:**

```bash
pip install -r requirements.txt

dotenv -f .env run -- fastapi run
```

如需后台运行，使用:

```bash
nohup uv run --env-file .env fastapi run > app.log 2>&1 &
```

### 5. 访问应用

打开 `PUBLIC_API_BASE_URL` 配置的地址（示例值为）：

**http://localhost:20050**

您将看到登录页面。使用 `.env` 文件中配置的凭据登录:

- **用户名:** `ADMIN_USERNAME` 的值
- **密码:** `ADMIN_PASSWORD` 的值

**其他访问端点:**

- API 文档: http://localhost:20050/docs
- 健康检查: http://localhost:20050/health
- MongoDB Express: http://localhost:20041
- MinIO 控制台: http://localhost:20043

## 验证安装

安装完成后验证所有服务运行状态:

| 服务 | 地址 | 预期状态 |
|------|------|----------|
| Web 应用 | http://localhost:20050 | 显示登录页面 |
| API 文档 | http://localhost:20050/docs | 显示交互式 API 文档 |
| 健康检查 | http://localhost:20050/health | JSON 响应包含 `"status": "healthy"` |
| MongoDB Express | http://localhost:20041 | 数据库管理界面 |
| MinIO 控制台 | http://localhost:20043 | 对象存储控制台 |

## 故障排查

| 问题 | 解决方案 |
|------|----------|
| Docker 服务启动失败 | 检查端口是否被占用,验证 Docker 是否运行 |
| 后端连接错误 | 验证 MongoDB 和 MinIO 是否运行,检查 `.env` 配置 |
| 无法登录 | 验证 `.env` 文件中的管理员凭据与登录信息匹配 |
| 后端或前端端口被占用 | 修改 `.env` 中的 `PORT` 或 `FRONTEND_PORT`，并同步相关 URL/Origin 配置 |

## 开发者指南

如果您想修改前端代码，可以单独运行前端开发服务器:

### 前端开发环境

**系统要求:**
- Node.js 18.x、20.x 或 22+
- npm 7+

**步骤:**

```bash
cd frontend
npm install
npm run dev
```

开发服务器使用根目录 `.env` 中的 `FRONTEND_HOST` 和 `FRONTEND_PORT`。

**构建前端:**

修改前端代码后:

```bash
npm run build
```

这会在 `agent_graph/dist/` 中创建优化后的生产文件，后端将自动提供这些文件。

**注意:** 仓库中已包含预构建的前端文件，只有在开发或自定义前端时才需要此步骤。

## 生产环境部署

在生产环境中，请考虑以下额外步骤:

1. **安全性:**
   - 将 `.env.example` 中留空的凭据全部设置为唯一值
   - 使用强 JWT 密钥 (最少 32 个字符)
   - 配置防火墙规则限制访问
   - 使用反向代理 (nginx/Caddy) 配置 HTTPS

2. **性能:**
   - 增加 MongoDB 连接池大小
   - 根据需要配置 MinIO 分布式存储
   - 使用生产优化设置

3. **监控:**
   - 设置应用日志记录
   - 监控 Docker 容器资源
   - 配置健康检查告警

## 下一步

安装成功后:

1. [快速入门](quickstart.md) - 创建第一个 Agent
2. [Agent 配置](../core-components/agent/config.md) - 学习 Agent 设置
3. [Graph 设计器](../core-components/graph/index.md) - 构建 Agent 工作流
