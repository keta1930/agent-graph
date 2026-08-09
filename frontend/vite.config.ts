import { fileURLToPath, URL } from 'node:url'

import react from '@vitejs/plugin-react-swc'
import { defineConfig, loadEnv } from 'vite'

const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function readPort(value: string | undefined, name: string): number {
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer between 1 and 65535`)
  }
  return port
}

function readList(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function createServeConfig(env: Record<string, string>) {
  const frontendPort = readPort(env.FRONTEND_PORT, 'FRONTEND_PORT')
  const backendPort = readPort(env.PORT, 'PORT')
  const frontendHost = env.FRONTEND_HOST || '127.0.0.1'
  const backendProxyHost = env.BACKEND_PROXY_HOST || '127.0.0.1'

  return {
    server: {
      host: frontendHost,
      port: frontendPort,
      strictPort: true,
      allowedHosts: readList(env.FRONTEND_ALLOWED_HOSTS),
      proxy: {
        '/api': {
          target: `http://${backendProxyHost}:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: frontendHost,
      port: frontendPort,
      strictPort: true,
    },
  }
}

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, projectRoot, '')

  return {
    envDir: projectRoot,
    plugins: [react()],
    build: {
      outDir: '../agent_graph/dist',
      emptyOutDir: true,
    },
    ...(command === 'serve' ? createServeConfig(env) : {}),
  }
})
