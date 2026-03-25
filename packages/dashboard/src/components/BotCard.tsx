import { Bot } from '@/lib/types';
import { StatusBadge } from './StatusBadge';
import { BotAvatar } from './BotAvatar';
import { formatDate } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

interface BotCardProps {
  bot: Bot;
  onClick?: () => void;
}

export function BotCard({ bot, onClick }: BotCardProps) {
  const { tr } = useI18n();
  const maxInline = 2;
  const visibleCaps = bot.capabilities.slice(0, maxInline);
  const overflowCount = bot.capabilities.length - maxInline;

  return (
    <div
      onClick={onClick}
      className="bg-white rounded-xl p-6 card-hover card-gradient cursor-pointer"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <BotAvatar name={bot.name} id={bot.id} avatarColor={bot.avatarColor} avatarUrl={bot.avatarUrl} size="lg" status={bot.status} />
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{bot.name}</h3>
            <p className="text-sm text-gray-500 mt-0.5">ID: {bot.id}</p>
          </div>
        </div>
        <StatusBadge status={bot.status} />
      </div>

      <div className="mb-4">
        <h4 className="text-sm font-medium text-gray-700 mb-2">{tr('能力', 'Capabilities')}</h4>
        {bot.capabilities.length === 0 ? (
          <p className="text-sm text-gray-400 italic">{tr('未注册能力', 'No capabilities registered')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {visibleCaps.map((cap, idx) => (
              <span
                key={idx}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-gray-50 text-gray-700"
                title={cap.description}
              >
                {cap.name}
              </span>
            ))}
            {overflowCount > 0 && (
              <span className="text-xs text-gray-400">{tr(`+${overflowCount} 更多`, `+${overflowCount} more`)}</span>
            )}
          </div>
        )}
      </div>

      <div className="text-xs text-gray-500 space-y-1">
        <p>{tr('注册时间', 'Registered')}: {formatDate(bot.createdAt)}</p>
        {bot.lastSeen && <p>{tr('最后在线', 'Last seen')}: {formatDate(bot.lastSeen)}</p>}
      </div>
    </div>
  );
}
