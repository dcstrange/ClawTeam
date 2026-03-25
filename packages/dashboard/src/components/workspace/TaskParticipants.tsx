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
