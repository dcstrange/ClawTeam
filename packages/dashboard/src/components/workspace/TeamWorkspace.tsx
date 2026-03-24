import { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useBots } from '@/hooks/useBots';
import { useTasks } from '@/hooks/useTasks';
import { useMessages } from '@/hooks/useMessages';
import type { Bot, Task, TaskStatus, Message, MessageType } from '@/lib/types';
import { BotCharacter } from './BotCharacter';
import { BotConnection, type InteractionType } from './BotConnection';
import { WorkspaceTooltip } from './WorkspaceTooltip';

interface TeamWorkspaceProps {
  compact?: boolean;
  filterTaskId?: string;
  onBotSelect?: (botId: string) => void;
  selectedBotId?: string | null;
}

interface BotPosition {
  bot: Bot;
  x: number;
  y: number;
  activeTasks: number;
}

interface ConnectionInfo {
  fromBotId: string;
  toBotId: string;
  interactionType: InteractionType;
  isInternal: boolean;
  connectionId: string;
  /** Present for delegate connections */
  task?: Task;
  /** Present for message connections */
  message?: Message;
  /** Fade birth timestamp for fade-out animation */
  fadeBirth?: number;
}

interface OwnerGroup {
  ownerEmail: string;
  bots: Bot[];
  x: number;
  y: number;
  w: number;
  h: number;
}

interface GroupBox {
  ownerEmail: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

type DragState =
  | { kind: 'group'; groupKey: string; botIds: string[]; startPositions: Record<string, { x: number; y: number }>; startMouseX: number; startMouseY: number }
  | { kind: 'bot'; botId: string; startSvgX: number; startSvgY: number; startMouseX: number; startMouseY: number };

const STORAGE_KEY = 'clawteam_workspace_positions';

function loadSavedBotPositions(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      // Migration from old format
      if (parsed && parsed.bots) return parsed.bots;
      if (parsed && parsed.groups) return {};
    }
  } catch { /* ignore */ }
  return {};
}

function saveBotPositions(positions: Record<string, { x: number; y: number }>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ bots: positions }));
  } catch { /* ignore */ }
}

function hashColor(id: string): string {
  const COLORS = [
    '#007AFF', '#5856D6', '#AF52DE', '#FF2D55', '#FF9500',
    '#FFCC00', '#34C759', '#00C7BE', '#30B0C7', '#5AC8FA',
  ];
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return COLORS[Math.abs(hash) % COLORS.length];
}

const OWNER_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308',
  '#84cc16', '#22c55e', '#10b981', '#14b8a6',
  '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899',
];

function ownerHashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return OWNER_COLORS[Math.abs(hash) % OWNER_COLORS.length];
}

const ACTIVE_STATUSES: Set<TaskStatus> = new Set([
  'pending', 'accepted', 'processing', 'waiting_for_input',
]);

function screenToSvg(svg: SVGSVGElement, screenX: number, screenY: number) {
  const pt = svg.createSVGPoint();
  pt.x = screenX;
  pt.y = screenY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: screenX, y: screenY };
  const svgPt = pt.matrixTransform(ctm.inverse());
  return { x: svgPt.x, y: svgPt.y };
}

const NO_OWNER = '__no_owner__';
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const ZOOM_WHEEL_SENSITIVITY = 0.0015;
const PAN_WHEEL_SENSITIVITY = 0.8;

function normalizeWheelDelta(delta: number, deltaMode: number): number {
  // deltaMode: 0=pixel, 1=line, 2=page
  if (deltaMode === 1) return delta * 16;
  if (deltaMode === 2) return delta * 800;
  return delta;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function TeamWorkspace({ compact = false, filterTaskId, onBotSelect, selectedBotId }: TeamWorkspaceProps) {
  const { data: allBots = [] } = useBots();
  const { data: allTasks = [] } = useTasks();
  const { data: allMessages = [] } = useMessages();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const [tooltip, setTooltip] = useState<{
    x: number; y: number; content: React.ReactNode;
  } | null>(null);

  const dragEnabled = !compact;
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [botOverrides, setBotOverrides] = useState<Record<string, { x: number; y: number }>>(() => loadSavedBotPositions());
  const [layoutGeneration, setLayoutGeneration] = useState(0);

  // --- Zoom & Pan state (non-compact only) ---
  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panDrag, setPanDrag] = useState<{ startX: number; startY: number; startPanX: number; startPanY: number } | null>(null);

  // --- Container size observer (for responsive canvas) ---
  const [containerSize, setContainerSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (compact || !containerRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
      }
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, [compact]);

  // --- Arrow fade-out tracking ---
  // Track when tasks finish (completed/failed/cancelled) so arrows fade over 3 seconds
  const FADE_DURATION = 3000;
  const [fadingTasks, setFadingTasks] = useState<Record<string, number>>({});
  const [, setFadeTick] = useState(0);
  const prevTaskStatusRef = useRef<Map<string, TaskStatus>>(new Map());

  useEffect(() => {
    const now = Date.now();
    const prevStatuses = prevTaskStatusRef.current;
    const newFading: Record<string, number> = {};
    let changed = false;

    for (const task of allTasks) {
      const prev = prevStatuses.get(task.id);
      const isFinished = task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled';
      const wasActive = prev && (prev === 'pending' || prev === 'accepted' || prev === 'processing' || prev === 'waiting_for_input');

      if (isFinished && wasActive && task.fromBotId !== task.toBotId) {
        if (!fadingTasks[task.id]) {
          newFading[task.id] = now;
          changed = true;
        }
      }
    }

    // Update prev statuses
    const nextMap = new Map<string, TaskStatus>();
    for (const task of allTasks) {
      nextMap.set(task.id, task.status);
    }
    prevTaskStatusRef.current = nextMap;

    if (changed) {
      setFadingTasks(prev => ({ ...prev, ...newFading }));
    }
  }, [allTasks, fadingTasks]);

  // Tick timer for fade-out progress (200ms)
  useEffect(() => {
    const activeFading = Object.values(fadingTasks);
    if (activeFading.length === 0) return;
    const timer = setInterval(() => setFadeTick(t => t + 1), 200);
    return () => clearInterval(timer);
  }, [fadingTasks]);

  // Clean up expired fading tasks
  useEffect(() => {
    const now = Date.now();
    const expired = Object.entries(fadingTasks).filter(([, birth]) => now - birth > FADE_DURATION);
    if (expired.length > 0) {
      setFadingTasks(prev => {
        const next = { ...prev };
        for (const [id] of expired) delete next[id];
        return next;
      });
    }
  }, [fadingTasks]);

  const activeTasks = useMemo(() => {
    if (filterTaskId) {
      return allTasks.filter(
        (t) => t.id === filterTaskId || t.parentTaskId === filterTaskId,
      );
    }
    return allTasks.filter((t) => ACTIVE_STATUSES.has(t.status));
  }, [allTasks, filterTaskId]);

  const bots = useMemo(() => {
    if (filterTaskId) {
      const botIds = new Set<string>();
      for (const t of activeTasks) {
        botIds.add(t.fromBotId);
        botIds.add(t.toBotId);
      }
      return allBots.filter((b) => botIds.has(b.id));
    }
    return allBots;
  }, [allBots, activeTasks, filterTaskId]);

  // Build botId → ownerEmail lookup for internal/external classification
  const botOwnerMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const bot of allBots) {
      map.set(bot.id, bot.ownerEmail || NO_OWNER);
    }
    return map;
  }, [allBots]);

  // Map MessageType → InteractionType
  const MESSAGE_FADE_DURATION = 5000; // 5 seconds for message connection fade-out
  const MSG_WINDOW = 5 * 60 * 1000; // 5 minutes window for message connections

  const connections = useMemo(() => {
    const conns: ConnectionInfo[] = [];
    const seen = new Set<string>();
    // Track delegate directions to avoid duplicate task_notification lines
    const delegateDirections = new Set<string>();

    // --- 1. Active task connections (delegate) ---
    for (const task of activeTasks) {
      if (task.fromBotId === task.toBotId) continue;
      const key = `delegate-${task.fromBotId}-${task.toBotId}-${task.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      delegateDirections.add(`${task.fromBotId}-${task.toBotId}`);
      const fromOwner = botOwnerMap.get(task.fromBotId) || NO_OWNER;
      const toOwner = botOwnerMap.get(task.toBotId) || NO_OWNER;
      conns.push({
        fromBotId: task.fromBotId, toBotId: task.toBotId,
        interactionType: 'delegate',
        connectionId: `delegate-${task.id}`,
        task,
        isInternal: fromOwner === toOwner,
      });
    }

    // --- 2. Fading task connections (recently completed/failed/cancelled) ---
    for (const task of allTasks) {
      if (!fadingTasks[task.id]) continue;
      if (task.fromBotId === task.toBotId) continue;
      const key = `delegate-${task.fromBotId}-${task.toBotId}-${task.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      delegateDirections.add(`${task.fromBotId}-${task.toBotId}`);
      const fromOwner = botOwnerMap.get(task.fromBotId) || NO_OWNER;
      const toOwner = botOwnerMap.get(task.toBotId) || NO_OWNER;
      conns.push({
        fromBotId: task.fromBotId, toBotId: task.toBotId,
        interactionType: 'delegate',
        connectionId: `delegate-${task.id}`,
        task,
        isInternal: fromOwner === toOwner,
        fadeBirth: fadingTasks[task.id],
      });
    }

    // --- 3. Message connections ---
    const now = Date.now();
    // Filter recent messages and group by (from, to, type), keep newest
    const msgGroups = new Map<string, Message>();
    for (const msg of allMessages) {
      if (msg.fromBotId === msg.toBotId) continue;
      const msgTime = new Date(msg.createdAt).getTime();
      if (now - msgTime > MSG_WINDOW) continue;

      const groupKey = `${msg.fromBotId}-${msg.toBotId}-${msg.type}`;
      const existing = msgGroups.get(groupKey);
      if (!existing || new Date(msg.createdAt).getTime() > new Date(existing.createdAt).getTime()) {
        msgGroups.set(groupKey, msg);
      }
    }

    // Map MessageType to InteractionType
    const mapMsgType = (type: MessageType): InteractionType => {
      switch (type) {
        case 'direct_message': return 'direct_message';
        case 'task_notification': return 'task_notification';
        case 'delegate_intent': return 'task_notification';
        case 'broadcast': return 'broadcast';
        case 'human_input_request':
        case 'human_input_response': return 'human_input';
        case 'system': return 'system';
        case 'task_continuation': return 'task_continuation';
        default: return 'system';
      }
    };

    for (const [, msg] of msgGroups) {
      const iType = mapMsgType(msg.type);

      // Skip task_notification if there's already a delegate line in same direction
      if (iType === 'task_notification' && delegateDirections.has(`${msg.fromBotId}-${msg.toBotId}`)) {
        continue;
      }

      const connKey = `msg-${msg.fromBotId}-${msg.toBotId}-${iType}`;
      if (seen.has(connKey)) continue;
      seen.add(connKey);

      const fromOwner = botOwnerMap.get(msg.fromBotId) || NO_OWNER;
      const toOwner = botOwnerMap.get(msg.toBotId) || NO_OWNER;
      const msgAge = now - new Date(msg.createdAt).getTime();
      // Start fading after MESSAGE_FADE_DURATION
      const fadeBirth = msgAge > MESSAGE_FADE_DURATION
        ? new Date(msg.createdAt).getTime() + MESSAGE_FADE_DURATION
        : undefined;

      conns.push({
        fromBotId: msg.fromBotId, toBotId: msg.toBotId,
        interactionType: iType,
        connectionId: `msg-${msg.messageId}`,
        message: msg,
        isInternal: fromOwner === toOwner,
        fadeBirth,
      });
    }

    return conns;
  }, [activeTasks, allTasks, allMessages, fadingTasks, botOwnerMap]);

  const botActivity = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of activeTasks) {
      map.set(t.fromBotId, (map.get(t.fromBotId) || 0) + 1);
      map.set(t.toBotId, (map.get(t.toBotId) || 0) + 1);
    }
    return map;
  }, [activeTasks]);

  // --- Adaptive canvas sizing ---
  const manyBots = !compact && bots.length > 50;
  const canvasWidth = compact ? 600 : (containerSize?.w ?? (manyBots ? 2200 : 1100));
  const canvasHeight = compact ? 260 : (containerSize?.h ?? (manyBots ? 1500 : 680));
  const botSize = compact ? 0.7 : (manyBots ? 0.75 : 0.75);
  const BOT_W = 60 * botSize;
  const BOT_H = 84 * botSize;

  const ownerGroups = useMemo(() => {
    const displayBots = compact ? bots.slice(0, 8) : bots;
    const map = new Map<string, Bot[]>();
    for (const bot of displayBots) {
      const key = bot.ownerEmail || NO_OWNER;
      const arr = map.get(key);
      if (arr) arr.push(bot);
      else map.set(key, [bot]);
    }
    const entries = [...map.entries()].sort((a, b) => {
      const aActive = a[1].some((bot) => (botActivity.get(bot.id) || 0) > 0);
      const bActive = b[1].some((bot) => (botActivity.get(bot.id) || 0) > 0);
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      return b[1].length - a[1].length;
    });
    return entries;
  }, [bots, botActivity, compact]);

  const GROUP_PAD_X = 16 * botSize;
  const GROUP_PAD_TOP = 40 * botSize;
  const GROUP_PAD_BOTTOM = 10 * botSize;
  const BOT_GAP = 8 * botSize;

  // Auto-layout: compute group origins for flow layout
  const autoGroupLayout = useMemo(() => {
    const groups: OwnerGroup[] = [];
    for (const [ownerEmail, groupBots] of ownerGroups) {
      const cols = Math.min(groupBots.length, compact ? 3 : (manyBots ? 5 : 4));
      const rows = Math.ceil(groupBots.length / cols);
      const w = GROUP_PAD_X * 2 + cols * BOT_W + (cols - 1) * BOT_GAP;
      const h = GROUP_PAD_TOP + rows * BOT_H + (rows - 1) * BOT_GAP + GROUP_PAD_BOTTOM;
      groups.push({ ownerEmail, bots: groupBots, x: 0, y: 0, w, h });
    }

    if (groups.length === 1) {
      const g = groups[0];
      g.x = (canvasWidth - g.w) / 2;
      g.y = (canvasHeight - g.h) / 2;
    } else if (groups.length > 1) {
      const GAP = 24 * botSize;
      const totalW = groups.reduce((s, g) => s + g.w, 0) + (groups.length - 1) * GAP;

      if (totalW <= canvasWidth - 20) {
        let startX = (canvasWidth - totalW) / 2;
        const maxH = Math.max(...groups.map((g) => g.h));
        for (const g of groups) {
          g.x = startX;
          g.y = (canvasHeight - maxH) / 2;
          startX += g.w + GAP;
        }
      } else {
        const rows: OwnerGroup[][] = [];
        let currentRow: OwnerGroup[] = [];
        let currentRowW = 0;
        const maxRowW = canvasWidth - 40;

        for (const g of groups) {
          if (currentRow.length > 0 && currentRowW + GAP + g.w > maxRowW) {
            rows.push(currentRow);
            currentRow = [g];
            currentRowW = g.w;
          } else {
            if (currentRow.length > 0) currentRowW += GAP;
            currentRow.push(g);
            currentRowW += g.w;
          }
        }
        if (currentRow.length > 0) rows.push(currentRow);

        const ROW_GAP = 20 * botSize;
        const totalH = rows.reduce((s, row) => s + Math.max(...row.map((g) => g.h)), 0) + (rows.length - 1) * ROW_GAP;
        let yOff = (canvasHeight - totalH) / 2;

        for (const row of rows) {
          const rowW = row.reduce((s, g) => s + g.w, 0) + (row.length - 1) * GAP;
          const rowH = Math.max(...row.map((g) => g.h));
          let xOff = (canvasWidth - rowW) / 2;
          for (const g of row) {
            g.x = xOff;
            g.y = yOff;
            xOff += g.w + GAP;
          }
          yOff += rowH + ROW_GAP;
        }
      }
    }

    return groups;
  }, [ownerGroups, canvasWidth, canvasHeight, botSize, compact, manyBots, BOT_W, BOT_H, GROUP_PAD_X, GROUP_PAD_TOP, GROUP_PAD_BOTTOM, BOT_GAP]);

  // Bot positions: auto-layout + overrides
  const positions = useMemo(() => {
    void layoutGeneration;
    const result: BotPosition[] = [];
    for (const group of autoGroupLayout) {
      const cols = Math.min(group.bots.length, compact ? 3 : (manyBots ? 5 : 4));
      for (let i = 0; i < group.bots.length; i++) {
        const col = i % cols;
        const row = Math.floor(i / cols);
        let bx = group.x + GROUP_PAD_X + col * (BOT_W + BOT_GAP);
        let by = group.y + GROUP_PAD_TOP + row * (BOT_H + BOT_GAP);
        if (!compact) {
          const ov = botOverrides[group.bots[i].id];
          if (ov) { bx = ov.x; by = ov.y; }
        }
        result.push({
          bot: group.bots[i],
          x: bx, y: by,
          activeTasks: botActivity.get(group.bots[i].id) || 0,
        });
      }
    }
    return result;
  }, [autoGroupLayout, botActivity, botOverrides, compact, manyBots, BOT_W, BOT_H, GROUP_PAD_X, GROUP_PAD_TOP, BOT_GAP, layoutGeneration]);

  // Derive group boxes from actual bot positions (dynamic sizing)
  const groupBoxes = useMemo(() => {
    const botsByOwner = new Map<string, BotPosition[]>();
    for (const group of autoGroupLayout) {
      botsByOwner.set(group.ownerEmail, []);
    }
    for (const pos of positions) {
      const owner = pos.bot.ownerEmail || NO_OWNER;
      botsByOwner.get(owner)?.push(pos);
    }

    const PAD = 12 * botSize;
    const NAME_EXTRA = 12 * botSize; // space below bot for name label
    const boxes: GroupBox[] = [];
    for (const group of autoGroupLayout) {
      const groupBots = botsByOwner.get(group.ownerEmail) || [];
      if (groupBots.length === 0) continue;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const bp of groupBots) {
        minX = Math.min(minX, bp.x);
        minY = Math.min(minY, bp.y);
        maxX = Math.max(maxX, bp.x + BOT_W);
        maxY = Math.max(maxY, bp.y + BOT_H + NAME_EXTRA);
      }

      boxes.push({
        ownerEmail: group.ownerEmail,
        x: minX - PAD,
        y: minY - GROUP_PAD_TOP,
        w: maxX - minX + PAD * 2,
        h: maxY - minY + GROUP_PAD_TOP + PAD,
      });
    }
    return boxes;
  }, [autoGroupLayout, positions, BOT_W, BOT_H, botSize, GROUP_PAD_TOP]);

  // Build a lookup: ownerEmail -> list of botIds (for group drag)
  const ownerBotIds = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const group of autoGroupLayout) {
      map.set(group.ownerEmail, group.bots.map((b) => b.id));
    }
    return map;
  }, [autoGroupLayout]);

  const posMap = useMemo(() => {
    const map = new Map<string, { x: number; y: number }>();
    for (const p of positions) {
      map.set(p.bot.id, { x: p.x + BOT_W / 2, y: p.y + BOT_H * 0.45 });
    }
    return map;
  }, [positions, BOT_W, BOT_H]);

  // --- Drag handlers ---
  const handleGroupMouseDown = useCallback(
    (e: React.MouseEvent, groupKey: string) => {
      if (!dragEnabled) return;
      // Capture current positions of all bots in this group
      const ids = ownerBotIds.get(groupKey) || [];
      const startPositions: Record<string, { x: number; y: number }> = {};
      for (const pos of positions) {
        if (ids.includes(pos.bot.id)) {
          startPositions[pos.bot.id] = { x: pos.x, y: pos.y };
        }
      }
      setDragState({
        kind: 'group', groupKey, botIds: ids, startPositions,
        startMouseX: e.clientX, startMouseY: e.clientY,
      });
    },
    [dragEnabled, ownerBotIds, positions],
  );

  const handleBotMouseDown = useCallback(
    (e: React.MouseEvent, botId: string, currentX: number, currentY: number) => {
      if (!dragEnabled) return;
      e.stopPropagation();
      setDragState({
        kind: 'bot', botId,
        startSvgX: currentX, startSvgY: currentY,
        startMouseX: e.clientX, startMouseY: e.clientY,
      });
    },
    [dragEnabled],
  );

  const handleSvgMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!dragState || !svgRef.current) return;
      const svg = svgRef.current;
      const startSvg = screenToSvg(svg, dragState.startMouseX, dragState.startMouseY);
      const currentSvg = screenToSvg(svg, e.clientX, e.clientY);
      const dx = currentSvg.x - startSvg.x;
      const dy = currentSvg.y - startSvg.y;

      if (dragState.kind === 'bot') {
        setBotOverrides((prev) => ({
          ...prev,
          [dragState.botId]: { x: dragState.startSvgX + dx, y: dragState.startSvgY + dy },
        }));
      } else {
        // Move all bots in the group by the same delta
        setBotOverrides((prev) => {
          const next = { ...prev };
          for (const botId of dragState.botIds) {
            const start = dragState.startPositions[botId];
            if (start) {
              next[botId] = { x: start.x + dx, y: start.y + dy };
            }
          }
          return next;
        });
      }
      setTooltip(null);
    },
    [dragState],
  );

  const handleSvgMouseUp = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.startMouseX;
      const dy = e.clientY - dragState.startMouseY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < 3 && dragState.kind === 'bot') {
        if (onBotSelect) {
          onBotSelect(dragState.botId);
        } else {
          navigate(`/bots/${dragState.botId}`);
        }
      } else if (dist >= 3) {
        saveBotPositions(botOverrides);
      }
      setDragState(null);
    },
    [dragState, navigate, onBotSelect, botOverrides],
  );

  const handleSvgMouseLeave = useCallback(() => {
    if (!dragState) return;
    saveBotPositions(botOverrides);
    setDragState(null);
  }, [dragState, botOverrides]);

  useEffect(() => {
    if (dragState) {
      document.body.classList.add('workspace-dragging');
    } else {
      document.body.classList.remove('workspace-dragging');
    }
    return () => document.body.classList.remove('workspace-dragging');
  }, [dragState]);

  const handleResetLayout = useCallback(() => {
    setBotOverrides({});
    localStorage.removeItem(STORAGE_KEY);
    setLayoutGeneration((g) => g + 1);
  }, []);

  const handleBotHover = useCallback(
    (e: React.MouseEvent, bot: Bot, taskCount: number) => {
      if (dragState) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        content: (
          <div>
            <p className="font-semibold text-gray-900">{bot.name}</p>
            <p className="text-gray-500">Status: {bot.status}</p>
            <p className="text-gray-500">{bot.capabilities.length} capabilities</p>
            <p className="text-gray-500">{taskCount} active tasks</p>
          </div>
        ),
      });
    },
    [dragState],
  );

  const handleConnectionHover = useCallback(
    (e: React.MouseEvent, conn: ConnectionInfo) => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      if (conn.task) {
        setTooltip({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          content: (
            <div>
              <p className="font-semibold text-gray-900">{conn.task.capability || 'Task'}</p>
              <p className="text-gray-500">Priority: {conn.task.priority}</p>
              <p className="text-gray-500">Status: {conn.task.status}</p>
              <p className="text-gray-500">
                {conn.task.fromBotName || conn.task.fromBotId} &rarr; {conn.task.toBotName || conn.task.toBotId}
              </p>
            </div>
          ),
        });
      } else if (conn.message) {
        const typeLabel = conn.interactionType.replace(/_/g, ' ');
        setTooltip({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          content: (
            <div>
              <p className="font-semibold text-gray-900" style={{ textTransform: 'capitalize' }}>{typeLabel}</p>
              <p className="text-gray-500">
                {conn.message.fromBotName || conn.message.fromBotId} &rarr; {conn.message.toBotName || conn.message.toBotId}
              </p>
            </div>
          ),
        });
      }
    },
    [],
  );

  const hideTooltip = useCallback(() => setTooltip(null), []);

  // --- Keyboard: Space key for pan mode ---
  useEffect(() => {
    if (compact) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
        e.preventDefault();
        setSpaceHeld(true);
      }
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [compact]);

  // --- Wheel handler: Ctrl/Meta+wheel = zoom, plain wheel = pan ---
  useEffect(() => {
    if (compact || !svgRef.current) return;
    const svg = svgRef.current;
    const handleWheel = (e: WheelEvent) => {
      const deltaX = normalizeWheelDelta(e.deltaX, e.deltaMode);
      const deltaY = normalizeWheelDelta(e.deltaY, e.deltaMode);

      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const svgPt = screenToSvg(svg, e.clientX, e.clientY);

        // Continuous exponential zoom: smoother and less jumpy than fixed ±0.1 steps.
        const zoomFactor = Math.exp(-deltaY * ZOOM_WHEEL_SENSITIVITY);
        setZoom((prev) => {
          const newZoom = clamp(prev * zoomFactor, MIN_ZOOM, MAX_ZOOM);
          if (newZoom === prev) return prev;
          const scale = newZoom / prev;
          setPanX((px) => svgPt.x - (svgPt.x - px) / scale);
          setPanY((py) => svgPt.y - (svgPt.y - py) / scale);
          return newZoom;
        });
      } else {
        e.preventDefault();
        const factor = (1 / zoom) * PAN_WHEEL_SENSITIVITY;
        setPanX((px) => px + deltaX * factor);
        setPanY((py) => py + deltaY * factor);
      }
    };
    svg.addEventListener('wheel', handleWheel, { passive: false });
    return () => svg.removeEventListener('wheel', handleWheel);
  }, [compact, zoom]);

  // --- Pan drag handlers (Space + mouse drag) ---
  const handlePanDragStart = useCallback(
    (e: React.MouseEvent) => {
      if (compact || !spaceHeld) return;
      e.preventDefault();
      setPanDrag({ startX: e.clientX, startY: e.clientY, startPanX: panX, startPanY: panY });
    },
    [compact, spaceHeld, panX, panY],
  );

  const handlePanDragMove = useCallback(
    (e: React.MouseEvent) => {
      if (!panDrag || !svgRef.current) return;
      const svg = svgRef.current;
      const startSvg = screenToSvg(svg, panDrag.startX, panDrag.startY);
      const curSvg = screenToSvg(svg, e.clientX, e.clientY);
      setPanX(panDrag.startPanX - (curSvg.x - startSvg.x));
      setPanY(panDrag.startPanY - (curSvg.y - startSvg.y));
    },
    [panDrag],
  );

  const handlePanDragEnd = useCallback(() => {
    setPanDrag(null);
  }, []);

  // --- Zoom controls ---
  const handleZoomIn = useCallback(() => {
    setZoom((z) => Math.min(MAX_ZOOM, z * 1.18));
  }, []);
  const handleZoomOut = useCallback(() => {
    setZoom((z) => Math.max(MIN_ZOOM, z / 1.18));
  }, []);
  const handleZoomReset = useCallback(() => {
    setZoom(1);
    setPanX(0);
    setPanY(0);
  }, []);

  const extraCount = compact && bots.length > 8 ? bots.length - 8 : 0;
  const hasSavedPositions = Object.keys(botOverrides).length > 0;

  if (bots.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-gray-400 text-sm italic"
        style={{ height: compact ? 200 : 400 }}
      >
        No bots to display
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={compact ? 'relative' : 'relative h-[calc(100vh-160px)] min-h-[640px]'}
    >
      {compact && (
        <div className="absolute top-2 right-2 z-10">
          <Link
            to="/team"
            className="text-xs text-primary-600 hover:text-primary-700 font-medium group inline-flex items-center gap-1"
          >
            View full{' '}
            <span className="transition-transform group-hover:translate-x-0.5">
              &rarr;
            </span>
          </Link>
        </div>
      )}

      {!compact && hasSavedPositions && (
        <div className="absolute top-2 right-2 z-10">
          <button
            onClick={handleResetLayout}
            className="text-xs text-gray-500 hover:text-gray-700 font-medium px-2 py-1 rounded-md hover:bg-gray-100 transition-colors"
          >
            Reset layout
          </button>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={compact ? `0 0 ${canvasWidth} ${canvasHeight}` : `${panX} ${panY} ${canvasWidth / zoom} ${canvasHeight / zoom}`}
        className={compact ? 'w-full' : 'w-full h-full'}
        style={{
          height: compact ? 260 : '100%',
          maxHeight: compact ? 260 : undefined,
          userSelect: (dragState || panDrag) ? 'none' : undefined,
          cursor: spaceHeld ? (panDrag ? 'grabbing' : 'grab') : undefined,
        }}
        onMouseDown={!compact && spaceHeld ? handlePanDragStart : undefined}
        onMouseMove={dragEnabled ? (panDrag ? handlePanDragMove : handleSvgMouseMove) : undefined}
        onMouseUp={dragEnabled ? (panDrag ? handlePanDragEnd : handleSvgMouseUp) : undefined}
        onMouseLeave={dragEnabled ? (panDrag ? handlePanDragEnd : handleSvgMouseLeave) : undefined}
      >
        {/* Layer 1 (backmost): Group boxes — dynamically sized from bot positions */}
        {groupBoxes.map((box) => {
          const isNoOwner = box.ownerEmail === NO_OWNER;
          const displayName = isNoOwner ? 'Unassigned' : box.ownerEmail.split('@')[0];
          const avatarColor = isNoOwner ? 'var(--color-text-muted, #86868b)' : ownerHashColor(box.ownerEmail);
          const initial = isNoOwner ? '?' : (displayName[0] || '?').toUpperCase();
          const avatarR = 13 * botSize;

          return (
            <g
              key={`group-${box.ownerEmail}`}
              onMouseDown={
                dragEnabled
                  ? (e) => handleGroupMouseDown(e, box.ownerEmail)
                  : undefined
              }
              style={{ cursor: dragEnabled ? 'grab' : undefined }}
            >
              <rect
                x={box.x}
                y={box.y}
                width={box.w}
                height={box.h}
                rx={12 * botSize}
                fill="var(--color-card-alt, #f5f5f7)"
                stroke="var(--color-border-light, #ebebed)"
                strokeWidth={1}
                opacity={0.8}
              />
              <circle
                cx={box.x + 12 * botSize + avatarR}
                cy={box.y + GROUP_PAD_TOP / 2}
                r={avatarR}
                fill={avatarColor}
              />
              <text
                x={box.x + 12 * botSize + avatarR}
                y={box.y + GROUP_PAD_TOP / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fill="white"
                fontSize={12 * botSize}
                fontWeight={600}
                fontFamily="sans-serif"
              >
                {initial}
              </text>
              <text
                x={box.x + 12 * botSize + avatarR * 2 + 6 * botSize}
                y={box.y + GROUP_PAD_TOP / 2}
                dominantBaseline="central"
                fill="currentColor"
                className="text-gray-600"
                fontSize={14 * botSize}
                fontFamily="sans-serif"
                fontWeight={500}
              >
                {displayName.length > 14 ? displayName.slice(0, 13) + '..' : displayName}
              </text>
            </g>
          );
        })}

        {/* Layer 2: Connections */}
        {connections.map((conn) => {
          const from = posMap.get(conn.fromBotId);
          const to = posMap.get(conn.toBotId);
          if (!from || !to) return null;

          // Compute fade opacity
          let fadeOpacity: number | undefined;
          if (conn.interactionType === 'delegate' && conn.task) {
            // Task fade: use fadingTasks tracking
            const taskFadeBirth = fadingTasks[conn.task.id];
            if (taskFadeBirth) {
              const elapsed = Date.now() - taskFadeBirth;
              fadeOpacity = Math.max(0, 1 - elapsed / FADE_DURATION);
              if (fadeOpacity <= 0) return null;
            }
          } else if (conn.fadeBirth) {
            // Message fade: fade based on age
            const elapsed = Date.now() - conn.fadeBirth;
            const msgFadeDuration = MSG_WINDOW - MESSAGE_FADE_DURATION;
            fadeOpacity = Math.max(0, 1 - elapsed / msgFadeDuration);
            if (fadeOpacity <= 0) return null;
          }

          const label = conn.task?.capability;
          const clickHandler = conn.task
            ? () => navigate(`/tasks/${conn.task!.id}`)
            : undefined;

          return (
            <BotConnection
              key={conn.connectionId}
              fromX={from.x}
              fromY={from.y}
              toX={to.x}
              toY={to.y}
              interactionType={conn.interactionType}
              connectionId={conn.connectionId}
              status={conn.task?.status}
              label={label}
              isInternal={conn.isInternal}
              fadeOpacity={fadeOpacity}
              onMouseEnter={(e) => handleConnectionHover(e, conn)}
              onMouseLeave={hideTooltip}
              onClick={clickHandler}
            />
          );
        })}

        {/* Layer 3 (topmost): Bots */}
        {positions.map((pos) => {
          const taskCount = pos.activeTasks;
          return (
            <g key={pos.bot.id} transform={`translate(${pos.x}, ${pos.y})`}>
              <BotCharacter
                name={pos.bot.name}
                color={pos.bot.avatarColor || hashColor(pos.bot.id)}
                status={pos.bot.status}
                isActive={taskCount > 0}
                activeTasks={taskCount}
                size={botSize}
                selected={selectedBotId === pos.bot.id}
                onClick={dragEnabled ? undefined : () => navigate(`/bots/${pos.bot.id}`)}
                onMouseDown={
                  dragEnabled
                    ? (e) => handleBotMouseDown(e, pos.bot.id, pos.x, pos.y)
                    : undefined
                }
                onMouseEnter={(e) => handleBotHover(e, pos.bot, taskCount)}
                onMouseLeave={hideTooltip}
              />
            </g>
          );
        })}

        {extraCount > 0 && (
          <text
            x={canvasWidth - 60}
            y={canvasHeight - 16}
            fill="currentColor"
            className="text-gray-500"
            fontSize={12}
            fontFamily="sans-serif"
          >
            +{extraCount} more
          </text>
        )}
      </svg>

      {/* Zoom controls (non-compact only) */}
      {!compact && (
        <div className="absolute bottom-3 right-3 z-10 flex items-center gap-1 bg-white/90 backdrop-blur-sm border border-gray-200 rounded-lg shadow-sm px-1 py-0.5">
          <button
            onClick={handleZoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 flex items-center justify-center text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
            title="Zoom out"
          >
            −
          </button>
          <span className="text-xs text-gray-500 w-10 text-center tabular-nums select-none">
            {Math.round(zoom * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 flex items-center justify-center text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
            title="Zoom in"
          >
            +
          </button>
          <div className="w-px h-4 bg-gray-200 mx-0.5" />
          <button
            onClick={handleZoomReset}
            disabled={zoom === 1 && panX === 0 && panY === 0}
            className="w-7 h-7 flex items-center justify-center text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            title="Reset view"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 8a6 6 0 0 1 10.2-4.3L14 2v4h-4l1.7-1.7A4.5 4.5 0 1 0 12.5 8" />
            </svg>
          </button>
        </div>
      )}

      {tooltip && (
        <WorkspaceTooltip
          x={tooltip.x}
          y={tooltip.y}
          content={tooltip.content}
          visible
        />
      )}
    </div>
  );
}
