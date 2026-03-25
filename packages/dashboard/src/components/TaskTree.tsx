import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { StatusBadge } from '@/components/StatusBadge';
import type { Task } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

interface TaskTreeProps {
  tasks: Task[];
  focusTaskId: string;
}

interface TreeNode {
  task: Task;
  children: TreeNode[];
}

export function TaskTree({ tasks, focusTaskId }: TaskTreeProps) {
  const { tr } = useI18n();
  const navigate = useNavigate();

  const tree = useMemo(() => {
    const taskMap = new Map(tasks.map(t => [t.id, t]));

    // Find root ancestor (with circular reference protection)
    let rootId = focusTaskId;
    const visited = new Set<string>();
    while (true) {
      if (visited.has(rootId)) break;
      visited.add(rootId);
      const task = taskMap.get(rootId);
      if (!task?.parentTaskId || !taskMap.has(task.parentTaskId)) break;
      rootId = task.parentTaskId;
    }

    // Build children map
    const childrenMap = new Map<string, string[]>();
    for (const t of tasks) {
      if (t.parentTaskId && taskMap.has(t.parentTaskId)) {
        const siblings = childrenMap.get(t.parentTaskId) || [];
        siblings.push(t.id);
        childrenMap.set(t.parentTaskId, siblings);
      }
    }

    // BFS build tree (with depth limit)
    const MAX_DEPTH = 20;
    function buildNode(id: string, depth = 0): TreeNode | null {
      if (depth > MAX_DEPTH) return null;
      const task = taskMap.get(id);
      if (!task) return null;
      const childIds = childrenMap.get(id) || [];
      return {
        task,
        children: childIds.map(cid => buildNode(cid, depth + 1)).filter(Boolean) as TreeNode[],
      };
    }

    return buildNode(rootId);
  }, [tasks, focusTaskId]);

  if (!tree) {
    return <p className="text-sm text-gray-400">{tr('暂无可用依赖树', 'No dependency tree available')}</p>;
  }

  function renderNode(node: TreeNode, depth: number) {
    const isFocus = node.task.id === focusTaskId;
    return (
      <div key={node.task.id}>
        <div
          onClick={() => navigate(`/tasks/${node.task.id}`)}
          className={`flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer hover:bg-gray-100 ${
            isFocus ? 'bg-primary-50' : ''
          }`}
          style={{ marginLeft: depth * 20 }}
        >
          {depth > 0 && <span className="text-gray-300">└─</span>}
          <code className="text-xs font-mono text-gray-600">{node.task.id.slice(0, 8)}</code>
          <span className="text-sm text-gray-900">{node.task.capability}</span>
          <StatusBadge status={node.task.status} />
        </div>
        {node.children.map(child => renderNode(child, depth + 1))}
      </div>
    );
  }

  return <div className="space-y-0.5">{renderNode(tree, 0)}</div>;
}
