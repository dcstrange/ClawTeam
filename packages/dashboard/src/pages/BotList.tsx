import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBots } from '@/hooks/useBots';
import { useIdentity } from '@/lib/identity';
import { BotCard } from '@/components/BotCard';
import { BotAvatar } from '@/components/BotAvatar';
import type { Bot } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

interface OwnerGroup {
  ownerEmail: string;
  bots: Bot[];
  isMe: boolean;
}

export function BotList() {
  const { tr, term } = useI18n();
  const { data: bots = [], isLoading, error, refetch } = useBots();
  const { me } = useIdentity();
  const navigate = useNavigate();
  const [viewMode, setViewMode] = useState<'grouped' | 'flat'>('grouped');

  const groups = useMemo(() => {
    const map = new Map<string, Bot[]>();
    for (const bot of bots) {
      const key = bot.ownerEmail || tr('未知', 'Unknown');
      const list = map.get(key) || [];
      list.push(bot);
      map.set(key, list);
    }

    const result: OwnerGroup[] = [];
    for (const [ownerEmail, ownerBots] of map) {
      result.push({
        ownerEmail,
        bots: ownerBots,
        isMe: !!me && me.ownerEmail === ownerEmail,
      });
    }

    // Sort: my group first, then alphabetically
    result.sort((a, b) => {
      if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
      return a.ownerEmail.localeCompare(b.ownerEmail);
    });

    return result;
  }, [bots, me, tr]);

  if (isLoading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse">
          <div className="h-8 bg-gray-200 rounded w-1/4 mb-4"></div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-64 bg-gray-200 rounded"></div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="bg-red-50 rounded-xl p-4">
          <h3 className="text-red-800 font-medium">{tr(`加载${term('bot')}失败`, `Failed to load ${term('bot')}s`)}</h3>
          <p className="text-red-600 text-sm mt-1">{(error as Error).message}</p>
          <button
            onClick={() => refetch()}
            className="mt-3 px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 text-sm"
          >
            {tr('重试', 'Retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">{tr(`已注册${term('bot')}`, `Registered ${term('bot')}s`)}</h2>
          <p className="text-gray-600 mt-1">
            {tr(`已注册 ${bots.length} 个机器人`, `${bots.length} ${term('bot')}s registered`)}
            {groups.length > 1 && tr(` · ${groups.length} 位所有者`, ` · ${groups.length} owners`)}
          </p>
        </div>
        <div className="flex gap-2">
          <div className="flex bg-gray-100 rounded-lg p-0.5 mr-2">
            <button
              onClick={() => setViewMode('grouped')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'grouped' ? 'bg-white shadow text-gray-900' : 'text-gray-600'}`}
            >
              {tr('按所有者', 'By owner')}
            </button>
            <button
              onClick={() => setViewMode('flat')}
              className={`px-3 py-1.5 rounded-md text-sm font-medium ${viewMode === 'flat' ? 'bg-white shadow text-gray-900' : 'text-gray-600'}`}
            >
              {tr('平铺', 'Flat')}
            </button>
          </div>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 transition-colors"
          >
            {tr('刷新', 'Refresh')}
          </button>
        </div>
      </div>

      {bots.length === 0 ? (
        <div className="empty-state">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
          <p className="text-gray-500 text-lg font-medium">{tr(`还没有注册${term('bot')}`, `No ${term('bot')}s registered yet`)}</p>
          <p className="text-gray-400 text-sm mt-1">{tr(`启动一个${term('bot')}后会显示在这里`, `Start a ${term('bot')} and it will appear here`)}</p>
        </div>
      ) : viewMode === 'flat' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {bots.map((bot) => (
            <BotCard key={bot.id} bot={bot} onClick={() => navigate(`/bots/${bot.id}`)} />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          {groups.map(group => (
            <OwnerSection key={group.ownerEmail} group={group} onBotClick={(id) => navigate(`/bots/${id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function OwnerSection({ group, onBotClick }: { group: OwnerGroup; onBotClick: (botId: string) => void }) {
  const { tr, term } = useI18n();
  const firstBot = group.bots[0];
  const onlineCount = group.bots.filter(b => b.status === 'online').length;

  return (
    <div className={`rounded-xl ${group.isMe ? 'owner-tint' : 'bg-white'}`}>
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-100">
        <BotAvatar
          name={group.ownerEmail}
          id={group.ownerEmail}
          avatarColor={firstBot?.avatarColor}
          size="sm"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gray-900 truncate">{group.ownerEmail}</span>
            {group.isMe && (
              <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full font-medium">{tr('我', 'Me')}</span>
            )}
          </div>
        </div>
        <span className="text-sm text-gray-500">
          {tr(`${group.bots.length} 个机器人`, `${group.bots.length} ${term('bot')}s`)}
          {onlineCount > 0 && <span className="text-green-600 ml-1">{tr(`· ${onlineCount} 在线`, `· ${onlineCount} online`)}</span>}
        </span>
      </div>
      <div className="p-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {group.bots.map(bot => (
          <BotCard key={bot.id} bot={bot} onClick={() => onBotClick(bot.id)} />
        ))}
      </div>
    </div>
  );
}
