import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const envDir = path.resolve(__dirname, '../..')

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env from monorepo root (.env / .env.local / .env.[mode])
  const env = loadEnv(mode, envDir, '')

  const devApiTarget = env.VITE_DEV_API_TARGET || 'http://localhost:3000'
  const devWsTarget = env.VITE_DEV_WS_TARGET || 'ws://localhost:3000'
  const devRouterApiTarget = env.VITE_DEV_ROUTER_API_TARGET || 'http://localhost:3100'
  const devRouterWsTarget = env.VITE_DEV_ROUTER_WS_TARGET || 'ws://localhost:3100'

  return {
    envDir,
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // Match nginx behavior: /api/tasks → /api/v1/tasks/all
        // But allow /api/tasks/:id/... to pass through to general /api proxy
        '/api/tasks': {
          target: devApiTarget,
          changeOrigin: true,
          rewrite: (path) => {
            // Exact /api/tasks (task list) → /api/v1/tasks/all
            if (path === '/api/tasks' || path === '/api/tasks/') return '/api/v1/tasks/all';
            // /api/tasks/all/:taskId/cancel → /api/v1/tasks/all/:taskId/cancel
            return path.replace(/^\/api/, '/api/v1');
          },
        },
        // Match nginx behavior: /api/messages → /api/v1/messages/all
        '/api/messages': {
          target: devApiTarget,
          changeOrigin: true,
          rewrite: (path) => {
            if (path === '/api/messages' || path === '/api/messages/') return '/api/v1/messages/all';
            return path.replace(/^\/api/, '/api/v1');
          },
        },
        // Match nginx behavior: /api/ → /api/v1/
        '/api': {
          target: devApiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, '/api/v1'),
        },
        '/ws': {
          target: devWsTarget,
          ws: true,
          configure: (proxy) => {
            proxy.on('error', () => {});
            proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
              socket.on('error', () => {});
            });
          },
        },
        // Router API proxy
        '/router-api': {
          target: devRouterApiTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/router-api/, ''),
        },
        '/router-ws': {
          target: devRouterWsTarget,
          ws: true,
          rewrite: (path) => path.replace(/^\/router-ws/, '/ws'),
          configure: (proxy) => {
            proxy.on('error', () => {}); // suppress ws connection errors
          },
        },
      },
    },
  }
})
