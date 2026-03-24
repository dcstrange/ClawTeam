import { useQuery } from '@tanstack/react-query';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import { Message } from '@/lib/types';

async function fetchMessages(taskId?: string): Promise<Message[]> {
  const qs = new URLSearchParams();
  if (taskId) {
    qs.set('taskId', taskId);
    qs.set('limit', '1000');
  }
  const url = `${API_BASE_URL}${API_ENDPOINTS.messages}${qs.toString() ? `?${qs.toString()}` : ''}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error('Failed to fetch messages');
  }
  return response.json();
}

export function useMessages(taskId?: string) {
  return useQuery({
    queryKey: ['messages', taskId || 'all'],
    queryFn: () => fetchMessages(taskId),
    refetchInterval: 5000,
  });
}
