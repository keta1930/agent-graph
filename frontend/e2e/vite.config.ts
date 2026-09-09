import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  envDir: false,
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 20058,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:20055', changeOrigin: true } },
  },
});
