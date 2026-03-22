import { cn } from '@/lib/utils';

interface StatusBadgeProps {
  status: string;
  className?: string;
}

const statusStyles: Record<string, string> = {
  // Bot statuses
  online: 'bg-green-100 text-green-800',
  offline: 'bg-gray-100 text-gray-800',
  busy: 'bg-yellow-100 text-yellow-800',
  focus_mode: 'bg-indigo-100 text-indigo-800',

  // Task statuses
  pending: 'bg-blue-100 text-blue-800',
  accepted: 'bg-cyan-100 text-cyan-800',
  processing: 'bg-purple-100 text-purple-800',
  waiting_for_input: 'bg-amber-100 text-amber-800',
  pending_review: 'bg-indigo-100 text-indigo-800',
  completed: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
  timeout: 'bg-orange-100 text-orange-800',
  cancelled: 'bg-gray-100 text-gray-800',

  // Priority levels
  urgent: 'bg-red-100 text-red-800',
  high: 'bg-orange-100 text-orange-800',
  normal: 'bg-blue-100 text-blue-800',
  low: 'bg-gray-100 text-gray-800',
};

// Status dot colors and animation classes
const dotConfig: Record<string, { color: string; animate?: string }> = {
  online:            { color: 'bg-green-500',  animate: 'animate-status-pulse' },
  processing:        { color: 'bg-purple-500', animate: 'animate-status-pulse' },
  accepted:          { color: 'bg-cyan-500',   animate: 'animate-status-pulse' },
  waiting_for_input: { color: 'bg-amber-500',  animate: 'animate-status-breathing' },
  pending_review:    { color: 'bg-indigo-500', animate: 'animate-status-breathing' },
  busy:              { color: 'bg-yellow-500',  animate: 'animate-status-breathing' },
  pending:           { color: 'bg-blue-400' },
  completed:         { color: 'bg-green-500' },
  failed:            { color: 'bg-red-500' },
  timeout:           { color: 'bg-orange-500' },
  urgent:            { color: 'bg-red-500',    animate: 'animate-status-pulse' },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const key = status.toLowerCase();
  const style = statusStyles[key] || statusStyles.offline;
  const dot = dotConfig[key];

  // Format: capitalize first letter, replace underscores with spaces
  const label = status
    .replace(/_/g, ' ')
    .replace(/^./, (c) => c.toUpperCase());

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-all duration-200',
        style,
        className
      )}
    >
      {dot && (
        <span className={cn('status-dot', dot.color, dot.animate)} />
      )}
      {label}
    </span>
  );
}
