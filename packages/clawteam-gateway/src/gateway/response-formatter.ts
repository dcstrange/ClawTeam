/**
 * Response Formatter
 *
 * Converts API JSON responses into human-readable text/plain
 * for LLM consumption. Mirrors the formatting style from adapter.ts.
 */

export function formatRegisterResponse(data: any): string {
  const botId = data.id || data.botId;
  const lines = [
    'Registered successfully.',
    '',
    `botId: ${botId}`,
  ];
  return lines.join('\n');
}

export function formatBotsResponse(bots: any[]): string {
  if (!bots || bots.length === 0) return 'No bots registered yet.';

  const lines = [`Found ${bots.length} bot(s):\n`];
  bots.forEach((bot, i) => {
    const caps = Array.isArray(bot.capabilities)
      ? bot.capabilities.map((c: any) => (typeof c === 'string' ? c : c.name)).join(', ')
      : '(none)';
    lines.push(`${i + 1}. ${bot.name} (${bot.id})`);
    if (bot.ownerEmail) lines.push(`   Owner: ${bot.ownerEmail}`);
    lines.push(`   Capabilities: ${caps}`);
    lines.push(`   Status: ${bot.status}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function formatBotDetailResponse(bot: any): string {
  const caps = Array.isArray(bot.capabilities)
    ? bot.capabilities.map((c: any) => {
        if (typeof c === 'string') return `  - ${c}`;
        return `  - ${c.name}: ${c.description || '(no description)'}`;
      }).join('\n')
    : '  (none)';

  const lines = [
    `Bot: ${bot.name} (${bot.id})`,
    ...(bot.ownerEmail ? [`Owner: ${bot.ownerEmail}`] : []),
    `Status: ${bot.status}`,
    `Capabilities:\n${caps}`,
  ];
  if (bot.lastSeen) lines.push(`Last seen: ${bot.lastSeen}`);
  return lines.join('\n');
}

export function formatDelegateResponse(task: any): string {
  const taskId = task.id || task.taskId;
  const lines = [
    'Task delegated successfully.',
    '',
    `taskId: ${taskId}`,
    `Status: ${task.status || 'pending'}`,
  ];
  if (task.title) lines.push(`Title: ${task.title}`);
  if (task.prompt) lines.push(`Prompt: ${task.prompt}`);
  return lines.join('\n');
}

export function formatPendingTasksResponse(data: any): string {
  const tasks = Array.isArray(data) ? data : (data?.tasks || []);
  if (tasks.length === 0) return 'No pending tasks.';

  const lines = [`Found ${tasks.length} pending task(s):\n`];
  tasks.forEach((task: any, i: number) => {
    lines.push(`${i + 1}. ${task.id}`);
    if (task.title) lines.push(`   Title: ${task.title}`);
    if (task.prompt) lines.push(`   Prompt: ${task.prompt}`);
    if (task.capability && task.capability !== 'general') lines.push(`   Capability: ${task.capability}`);
    lines.push(`   Type: ${task.type || 'new'}`);
    lines.push(`   Priority: ${task.priority}`);
    lines.push(`   From: ${task.fromBotId}`);
    if (task.parameters && Object.keys(task.parameters).length > 0) {
      lines.push(`   Parameters: ${JSON.stringify(task.parameters)}`);
    }
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function formatAcceptResponse(taskId: string): string {
  return `Task accepted and started.\n\ntaskId: ${taskId}\nStatus: processing`;
}

export function formatCompleteResponse(taskId: string, status: string): string {
  return `Task completed.\n\ntaskId: ${taskId}\nStatus: ${status}`;
}

export function formatCancelResponse(taskId: string): string {
  return `Task cancelled.\n\ntaskId: ${taskId}\nStatus: cancelled`;
}

export function formatTaskStatusResponse(task: any): string {
  const lines = [
    `taskId: ${task.id}`,
  ];
  if (task.title) lines.push(`Title: ${task.title}`);
  if (task.prompt) lines.push(`Prompt: ${task.prompt}`);
  if (task.capability && task.capability !== 'general') lines.push(`Capability: ${task.capability}`);
  lines.push(
    `Status: ${task.status}`,
    `Type: ${task.type || 'new'}`,
  );
  if (task.result !== undefined && task.result !== null) {
    const resultStr = typeof task.result === 'string' ? task.result : JSON.stringify(task.result, null, 2);
    lines.push('', `Result:\n${resultStr}`);
  }
  if (task.error) lines.push(`Error: ${task.error}`);
  return lines.join('\n');
}

export function formatSendMessageResponse(data: any): string {
  const messageId = data.messageId || data.data?.messageId;
  return `Message sent.\n\nmessageId: ${messageId}`;
}

export function formatInboxResponse(data: any): string {
  const messages = data?.messages || [];
  if (messages.length === 0) return 'Inbox empty. No new messages.';

  const remaining = data?.remaining || 0;
  const lines = [`${messages.length} message(s) in inbox (${remaining} more remaining):\n`];
  messages.forEach((msg: any, i: number) => {
    lines.push(`${i + 1}. [${msg.priority}] ${msg.type} from ${msg.fromBotId}`);
    lines.push(`   messageId: ${msg.messageId}`);
    const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    lines.push(`   Content: ${contentStr}`);
    lines.push('');
  });
  return lines.join('\n').trimEnd();
}

export function formatAckResponse(messageId: string): string {
  return `Message acknowledged.\n\nmessageId: ${messageId}`;
}

export function formatErrorResponse(message: string): string {
  return `Error: ${message}`;
}

export function formatSubmitResultResponse(taskId: string): string {
  return `Task result submitted for review.\n\ntaskId: ${taskId}\nStatus: pending_review`;
}

export function formatApproveResponse(taskId: string): string {
  return `Task approved.\n\ntaskId: ${taskId}\nStatus: completed`;
}

export function formatRejectResponse(taskId: string, reason: string): string {
  return `Task rejected. Executor should rework.\n\ntaskId: ${taskId}\nStatus: processing\nReason: ${reason}`;
}
