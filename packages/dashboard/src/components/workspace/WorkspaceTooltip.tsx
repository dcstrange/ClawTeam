interface WorkspaceTooltipProps {
  x: number;
  y: number;
  content: React.ReactNode;
  visible: boolean;
}

export function WorkspaceTooltip({ x, y, content, visible }: WorkspaceTooltipProps) {
  if (!visible) return null;

  return (
    <div
      className="absolute z-50 pointer-events-none"
      style={{
        left: x + 12,
        top: y - 8,
      }}
    >
      <div className="glass-popover rounded-lg px-3 py-2 text-xs text-gray-700 border border-gray-200 max-w-[220px]">
        {content}
      </div>
    </div>
  );
}
