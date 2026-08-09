# Installation

## System Requirements

Before installation, ensure your system meets these requirements:

| Component | Requirement |
|-----------|-------------|
| Operating System | Linux, macOS, or Windows (with WSL2) |
| Docker | Version 20.10+ with Docker Compose |
| Python | Version 3.11+ |
| Memory | Minimum 4GB RAM (8GB recommended) |
| Storage | At least 10GB free disk space |

## Installation Steps

### 1. Clone Repository

```bash
git clone https://github.com/keta1930/agent-graph.git
cd agent-graph
```

### 2. Configure Environment

A single `.env` file in the project root configures both the backend and the Docker services (MongoDB and MinIO).

```bash
cp .env.example .env
```

Edit the `.env` file with your configuration:

| Configuration | Description | Example |
|---------------|-------------|---------|
| APP_NAME | Application name exposed by FastAPI | Agent-Graph |
| APP_VERSION | Application version exposed by FastAPI | 3.0.0 |
| PORT | FastAPI listen port | 20050 |
| PUBLIC_API_BASE_URL | Externally reachable backend URL used by generated integrations | http://127.0.0.1:20050 |
| MCP_CLIENT_HOST | Internal MCP client bind address | 127.0.0.1 |
| MCP_CLIENT_PORT | Internal MCP client port | 20052 |
| FRONTEND_HOST | Vite development/preview bind address | 0.0.0.0 |
| FRONTEND_PORT | Vite development/preview port | 20051 |
| BACKEND_PROXY_HOST | Backend host used by the Vite development proxy | 127.0.0.1 |
| FRONTEND_ALLOWED_HOSTS | Hosts accepted by the Vite development server | localhost,127.0.0.1 |
| CORS_ORIGINS | Allowed browser origins (comma-separated) | http://localhost:20051 |
| MONGODB_URL | MongoDB connection URL used by backend (credentials must match MONGO_ROOT_*) | mongodb://admin:strongpassword123@localhost:20040/ |
| MONGODB_DB | Backend MongoDB database name | agent-graph |
| MONGO_ROOT_USERNAME | MongoDB admin username (container init) | admin |
| MONGO_ROOT_PASSWORD | MongoDB admin password (container init) | strongpassword123 |
| MONGO_DATABASE | Database created on first MongoDB init | agent-graph |
| MONGO_PORT | MongoDB service port | 20040 |
| MONGO_EXPRESS_PORT | Database management UI port | 20041 |
| MONGO_EXPRESS_USERNAME | Mongo Express web UI username | admin |
| MONGO_EXPRESS_PASSWORD | Mongo Express web UI password | strongpassword123 |
| MINIO_ENDPOINT | MinIO endpoint used by backend (host:port) | localhost:20042 |
| MINIO_ACCESS_KEY | MinIO access key (must match MINIO_ROOT_USER) | minioadmin |
| MINIO_SECRET_KEY | MinIO secret key (must match MINIO_ROOT_PASSWORD) | minioadmin123 |
| MINIO_BUCKET_NAME | Bucket used for application-managed objects | agent-graph |
| MINIO_ROOT_USER | MinIO admin username (container init) | minioadmin |
| MINIO_ROOT_PASSWORD | MinIO admin password (container init) | minioadmin123 |
| MINIO_API_PORT | MinIO API port | 20042 |
| MINIO_CONSOLE_PORT | MinIO web console port | 20043 |
| MINIO_SECURE | Enable TLS for the MinIO client | false |
| JWT_SECRET_KEY | Authentication secret (at least 32 characters) | Generate using script |
| JWT_ALGORITHM | JWT signing algorithm | HS256 |
| JWT_ACCESS_TOKEN_EXPIRE_MINUTES | Access Token lifetime in minutes | 15 |
| JWT_REFRESH_TOKEN_EXPIRE_DAYS | Refresh Token lifetime in days | 7 |
| ADMIN_USERNAME | Super admin username | admin |
| ADMIN_PASSWORD | Super admin password (at least 12 characters) | securepassword |

Values intentionally left blank in `.env.example` are required. Generate `JWT_SECRET_KEY` with `python agent_graph/scripts/generate_jwt_secret.py`, and set unique passwords before starting any service.

> **Note:** Keep `PORT` aligned with `PUBLIC_API_BASE_URL`, `FRONTEND_PORT` aligned with `CORS_ORIGINS`, and backend storage endpoints aligned with the corresponding Docker credentials and ports.

### 3. Start Docker Services

```bash
docker compose --env-file .env -f docker/docker-compose.yml up -d
```

With the example ports, verify services are running:

- MongoDB Express: http://localhost:20041
- MinIO Console: http://localhost:20043

### 4. Deploy Backend

Install backend dependencies:

**Using uv (Recommended):**

```bash
uv sync

uv run --env-file .env fastapi run
```

**Using pip:**

```bash
pip install -r requirements.txt

dotenv -f .env run -- fastapi run
```

For background execution, use:

```bash
nohup uv run --env-file .env fastapi run > app.log 2>&1 &
```

### 5. Access the Application

Open the URL configured by `PUBLIC_API_BASE_URL` (the example value is):

**http://localhost:20050**

You will see the login page. Use the credentials from your `.env` file:

- **Username:** Value from `ADMIN_USERNAME`
- **Password:** Value from `ADMIN_PASSWORD`

**Additional endpoints:**

- API Documentation: http://localhost:20050/docs
- Health Check: http://localhost:20050/health
- MongoDB Express: http://localhost:20041
- MinIO Console: http://localhost:20043

## Verification

After installation, verify all services are running correctly:

| Service | URL | Expected Status |
|---------|-----|-----------------|
| Web Application | http://localhost:20050 | Login page displayed |
| API Documentation | http://localhost:20050/docs | Interactive API docs |
| Health Check | http://localhost:20050/health | JSON response containing `"status": "healthy"` |
| MongoDB Express | http://localhost:20041 | Database management UI |
| MinIO Console | http://localhost:20043 | Object storage console |

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Docker services fail to start | Check ports are not already in use, verify Docker is running |
| Backend connection error | Verify MongoDB and MinIO are running, check `.env` configuration |
| Cannot login | Verify admin credentials in `.env` file match login attempt |
| Backend or frontend port already in use | Change `PORT` or `FRONTEND_PORT` in `.env`, then update the related URL/origin values |

## For Developers

If you want to modify the frontend code, you can run the frontend development server separately:

### Frontend Development Setup

**Requirements:**
- Node.js 18.x, 20.x, or 22+
- npm 7+

**Steps:**

```bash
cd frontend
npm install
npm run dev
```

The development server uses `FRONTEND_HOST` and `FRONTEND_PORT` from the root `.env`.

**Building Frontend:**

After making changes to the frontend:

```bash
npm run build
```

This creates optimized production files in `agent_graph/dist/` which will be served by the backend.

**Note:** The repository includes pre-built frontend files, so this step is only needed if you're developing or customizing the frontend.

## Production Deployment

For production environments, consider these additional steps:

1. **Security:**
   - Set every credential that is blank in `.env.example` to a unique value
   - Use a strong JWT secret key (minimum 32 characters)
   - Configure firewall rules to limit access
   - Set up HTTPS with a reverse proxy (nginx/Caddy)

2. **Performance:**
   - Increase MongoDB connection pool size
   - Configure MinIO for distributed storage if needed
   - Use production-optimized settings

3. **Monitoring:**
   - Set up application logging
   - Monitor Docker container resources
   - Configure health check alerts

## Next Steps

After successful installation:

1. [Quickstart Guide](quickstart.md) - Create your first agent
2. [Agent Configuration](../core-components/agent/config.md) - Learn about agent setup
3. [Graph Designer](../core-components/graph/index.md) - Build agent workflows
