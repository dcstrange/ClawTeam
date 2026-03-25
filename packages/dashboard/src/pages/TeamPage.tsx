import { useState, useEffect } from 'react';
import { TeamWorkspace } from '@/components/workspace/TeamWorkspace';
import { BotSidebar } from '@/components/workspace/BotSidebar';
import { useBots } from '@/hooks/useBots';
import { useI18n } from '@/lib/i18n';

export function TeamPage() {
  const { tr, term } = useI18n();
  const { data: bots = [] } = useBots();
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);

  // Default to first bot once loaded
  useEffect(() => {
    if (!selectedBotId && bots.length > 0) {
      setSelectedBotId(bots[0].id);
    }
  }, [bots, selectedBotId]);

  return (
    <div className="max-w-[1900px] mx-auto px-3 sm:px-4 lg:px-6 py-6">
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-gray-900">{tr('团队工作区', 'Team Workspace')}</h2>
        <p className="text-gray-600 mt-1">
          {tr(`${term('bot')}协作与活跃${term('task')}连接概览`, `Overview of ${term('bot')} collaboration and active ${term('task')} links`)}
        </p>
      </div>

      <div className="flex gap-0" style={{ minHeight: 'calc(100vh - 150px)' }}>
        <div className="flex-1 min-w-0 bg-white rounded-xl p-3 lg:p-4 card-gradient">
          <TeamWorkspace onBotSelect={setSelectedBotId} selectedBotId={selectedBotId} />
        </div>
        {selectedBotId && (
          <BotSidebar botId={selectedBotId} onClose={() => setSelectedBotId(null)} />
        )}
      </div>
    </div>
  );
}
