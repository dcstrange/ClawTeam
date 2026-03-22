// API configuration
// Always use relative URLs to leverage nginx proxy in production
// or Vite proxy in development
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || import.meta.env.VITE_API_URL || '';

// WebSocket URL - use relative path in dev, absolute in production
const isDev = import.meta.env.DEV;
export const WS_URL = import.meta.env.VITE_WS_URL || (isDev
  ? `ws://${window.location.host}`
  : `ws://${window.location.host}`);

// API endpoints
// In production: nginx proxies /api/ → /api/v1/ and /api/tasks → /api/v1/tasks/all
// In development: Vite proxies /api → localhost:3000/api
export const API_ENDPOINTS = {
  bots: '/api/bots',
  botsMe: '/api/bots/me',
  tasks: '/api/tasks',
  messages: '/api/messages',
  capabilities: '/api/capabilities',
  cancelTask: (taskId: string) => `/api/tasks/all/${taskId}/cancel`,
  createTask: '/api/tasks/create',
} as const;

// Router API endpoints
export const ROUTER_BASE = import.meta.env.VITE_ROUTER_BASE || '/router-api';
export const ROUTER_WS_URL = import.meta.env.VITE_ROUTER_WS_URL || (isDev
  ? `ws://${window.location.host}`
  : `ws://${window.location.host}`);
