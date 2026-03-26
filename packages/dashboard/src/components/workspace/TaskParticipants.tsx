import { useMemo } from 'react';
import type { Task, Bot } from '@/lib/types';
import { TeamWorkspace } from './TeamWorkspace';
import { useI18n } from '@/lib/i18n';

interface TaskParticipantsProps {
  task: Task;
  allTasks: Task[];
  bots: Bot[];
}

export function TaskParticipants({ task, allTasks }: TaskParticipantsProps) {
  const { tr, term } = useI18n();
  // Collect all bot IDs from this task and its sub-tasks
  const participantIds = useMemo(() => {
    const ids = new Set<string>();
    ids.add(task.fromBotId);
    ids.add(task.toBotId);

    const params = (task.parameters && typeof task.parameters === 'object')
      ? task.parameters as Record<string, unknown>
      : {};
    const collaboration = (params.collaboration && typeof params.collaboration === 'object')
      ? params.collaboration as Record<string, unknown>
      : {};
    const rawParticipantIds = Array.isArray(collaboration.participantBotIds)
      ? collaboration.participantBotIds
      : [];
    for (const item of rawParticipantIds) {
      if (typeof item === 'string' && item.trim()) ids.add(item.trim());
    }
    const rawParticipantBots = Array.isArray(collaboration.participantBots)
      ? collaboration.participantBots
      : [];
    for (const item of rawParticipantBots) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const rec = item as Record<string, unknown>;
      if (typeof rec.botId === 'string' && rec.botId.trim()) ids.add(rec.botId.trim());
    }

    for (const t of allTasks) {
      if (t.parentTaskId === task.id) {
        ids.add(t.fromBotId);
        ids.add(t.toBotId);
      }
    }
    return ids;
  }, [task, allTasks]);

  if (participantIds.size < 2) return null;

  return (
    <div className="bg-white rounded-xl p-4 card-gradient">
      <h3 className="text-sm font-semibold text-gray-700 mb-2">{tr(`${term('task')}参与者`, 'Task Participants')}</h3>
      <div style={{ height: 200 }}>
        <TeamWorkspace compact filterTaskId={task.id} />
      </div>
    </div>
  );
}
