import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
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
        target: 'http://18.179.251.234:3000',
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
        target: 'http://18.179.251.234:3000',
        changeOrigin: true,
        rewrite: (path) => {
          if (path === '/api/messages' || path === '/api/messages/') return '/api/v1/messages/all';
          return path.replace(/^\/api/, '/api/v1');
        },
      },
      // Match nginx behavior: /api/ → /api/v1/
      '/api': {
        target: 'http://18.179.251.234:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '/api/v1'),
      },
      '/ws': {
        target: 'ws://18.179.251.234:3000',
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
        target: 'http://localhost:3100',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/router-api/, ''),
      },
      '/router-ws': {
        target: 'ws://localhost:3100',
        ws: true,
        rewrite: (path) => path.replace(/^\/router-ws/, '/ws'),
        configure: (proxy) => {
          proxy.on('error', () => {}); // suppress ws connection errors
        },
      },
    },
  },
})
