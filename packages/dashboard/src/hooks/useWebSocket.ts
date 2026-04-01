import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { WS_URL } from '@/lib/config';
import type { WSMessage } from '@/lib/types';

export function useWebSocket() {
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const queryClientRef = useRef(useQueryClient());

  useEffect(() => {
    let isMounted = true;

    function connect() {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        return;
      }

      try {
        const apiKey = localStorage.getItem('clawteam_api_key');
        const wsUrl = apiKey ? `${WS_URL}/ws?apiKey=${encodeURIComponent(apiKey)}` : `${WS_URL}/ws`;
        const ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          if (!isMounted) return;
          console.log('[WebSocket] Connected');
          setIsConnected(true);
        };

        ws.onmessage = (event) => {
          if (!isMounted) return;
          try {
            const message: WSMessage = JSON.parse(event.data);
            console.log('[WebSocket] Message received:', message);

            // Handle different message types
            switch (message.type) {
              case 'task_assigned':
              case 'task_completed':
              case 'task_updated':
              case 'task_failed':
                // Invalidate tasks query to refetch
                queryClientRef.current.invalidateQueries({ queryKey: ['tasks'] });
                break;

              case 'bot_registered':
              case 'bot_status_changed':
                // Invalidate bots query to refetch
                queryClientRef.current.invalidateQueries({ queryKey: ['bots'] });
                break;

              default:
                console.log('[WebSocket] Unknown message type:', message.type);
            }
          } catch (error) {
            console.error('[WebSocket] Failed to parse message:', error);
          }
        };

        ws.onerror = (error) => {
          console.error('[WebSocket] Error:', error);
        };

        ws.onclose = () => {
          if (!isMounted) return;
          console.log('[WebSocket] Disconnected');
          setIsConnected(false);
          wsRef.current = null;

          // Attempt to reconnect after 5 seconds
          reconnectTimeoutRef.current = setTimeout(() => {
            if (isMounted) {
              console.log('[WebSocket] Attempting to reconnect...');
              connect();
            }
          }, 5000);
        };

        wsRef.current = ws;
      } catch (error) {
        console.error('[WebSocket] Connection error:', error);
      }
    }

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  const disconnect = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    setIsConnected(false);
  };

  const reconnect = () => {
    disconnect();
    // Re-trigger useEffect by updating state won't work, so we manually connect
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      const apiKey = localStorage.getItem('clawteam_api_key');
      const wsUrl = apiKey ? `${WS_URL}/ws?apiKey=${encodeURIComponent(apiKey)}` : `${WS_URL}/ws`;
      const ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        console.log('[WebSocket] Reconnected');
        setIsConnected(true);
      };
      ws.onclose = () => setIsConnected(false);
      wsRef.current = ws;
    }
  };

  return { isConnected, disconnect, reconnect };
}
