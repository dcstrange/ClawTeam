import { Link } from 'react-router-dom';
import { Message } from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { TaskFlow } from './BotAvatar';
import { formatDate } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface MessageCardProps {
  message: Message;
}

const typeBadgeColors: Record<string, string> = {
  direct_message: 'bg-blue-100 text-blue-800',
  task_notification: 'bg-purple-100 text-purple-800',
  broadcast: 'bg-green-100 text-green-800',
  system: 'bg-gray-100 text-gray-800',
};

function renderContent(content: any): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.text) return parsed.text;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return content;
    }
  }
  if (typeof content === 'object' && content.text) return content.text;
  return JSON.stringify(content, null, 2);
}

export function MessageCard({ message }: MessageCardProps) {
  const { tr, locale } = useI18n();
  const contentText = renderContent(message.content);
  const typeLabels: Record<string, string> = locale === 'zh'
    ? {
      direct_message: '私信',
      task_notification: '任务通知',
      broadcast: '广播',
      system: '系统',
    }
    : {
      direct_message: 'Direct Message',
      task_notification: 'Task Notice',
      broadcast: 'Broadcast',
      system: 'System',
    };

  return (
    <div className="bg-white rounded-xl p-6 hover:shadow-md transition-shadow">
      {/* Header: type, priority, status */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            <span
              className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${typeBadgeColors[message.type] || 'bg-gray-100 text-gray-800'}`}
            >
              {typeLabels[message.type] || message.type}
            </span>
            <StatusBadge status={message.priority} />
            <StatusBadge status={message.status} />
          </div>
          <p className="text-sm text-gray-500">
            ID: <code className="font-mono bg-gray-100 px-1 rounded">{message.messageId}</code>
          </p>
        </div>
      </div>

      {/* From → To bot flow */}
      <div className="space-y-3 mb-4">
        <div className="flex items-center gap-3">
          <TaskFlow
            fromName={message.fromBotName || message.fromBotId}
            fromId={message.fromBotId}
            fromAvatarColor={message.fromAvatarColor}
            fromAvatarUrl={message.fromAvatarUrl}
            toName={message.toBotName || message.toBotId}
            toId={message.toBotId}
            toAvatarColor={message.toAvatarColor}
            toAvatarUrl={message.toAvatarUrl}
            size="md"
          />
          <div className="flex-1 min-w-0">
            <div className="text-sm text-gray-900 truncate">
              {message.fromBotName || message.fromBotId.slice(0, 8)} → {message.toBotName || message.toBotId.slice(0, 8)}
            </div>
            <div className="text-xs text-gray-400">
              {message.contentType}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      {contentText && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-700 mb-2">{tr('内容', 'Content')}</h4>
          <pre className="bg-gray-50 rounded p-2 text-xs overflow-x-auto max-h-32 whitespace-pre-wrap">
            {contentText}
          </pre>
        </div>
      )}

      {/* Linked task */}
      {message.taskId && (
        <div className="mb-3 px-3 py-2 bg-purple-50 rounded text-sm">
          <span className="text-purple-700">{tr('任务', 'Task')}: </span>
          <Link to={`/tasks/${message.taskId}`} className="font-mono text-purple-900 text-xs hover:underline">
            {message.taskId}
          </Link>
        </div>
      )}

      {/* Timestamps */}
      <div className="text-xs text-gray-500 space-y-1">
        <p>{tr('创建时间', 'Created')}: {formatDate(message.createdAt)}</p>
        {message.readAt && <p>{tr('已读时间', 'Read at')}: {formatDate(message.readAt)}</p>}
      </div>
    </div>
  );
}
