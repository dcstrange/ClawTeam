import { useState, FormEvent, ChangeEvent } from 'react';
import { useBots } from '@/hooks/useBots';
import { useIdentity } from '@/lib/identity';
import { routerApi } from '@/lib/router-api';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import type { TaskPriority } from '@/lib/types';
import { useI18n } from '@/lib/i18n';

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function CreateTaskModal({ isOpen, onClose, onSuccess }: CreateTaskModalProps) {
  const { tr, term } = useI18n();
  const { data: bots = [] } = useBots();
  const { me, isLoggedIn, apiKey } = useIdentity();

  const [fromBotId, setFromBotId] = useState('');
  const [toBotId, setToBotId] = useState('');
  const [participantBotIds, setParticipantBotIds] = useState<string[]>([]);
  const [prompt, setPrompt] = useState('');
  const [capability, setCapability] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [attachments, setAttachments] = useState<File[]>([]);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const ownedBots = me?.ownedBots ?? [];
  const onlineBots = bots.filter((b) => b.status === 'online');
  const toBot = bots.find((b) => b.id === toBotId);
  const collaborationBots = onlineBots.filter((b) => b.id !== fromBotId);

  const readFileAsBase64 = async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const idx = result.indexOf(',');
        if (idx < 0) {
          reject(new Error(`Failed to parse uploaded file: ${file.name}`));
          return;
        }
        resolve(result.slice(idx + 1));
      };
      reader.onerror = () => reject(new Error(`Failed to read uploaded file: ${file.name}`));
      reader.readAsDataURL(file);
    });
  };

  const uploadTaskAttachment = async (taskId: string, file: File) => {
    if (!apiKey) {
      throw new Error(tr('上传附件前请先登录', 'Please sign in before uploading attachments'));
    }
    if (!fromBotId) {
      throw new Error(tr('缺少发起方机器人，无法上传附件', 'Missing requester bot, cannot upload attachments'));
    }

    const contentBase64 = await readFileAsBase64(file);
    const res = await fetch(`${API_BASE_URL}${API_ENDPOINTS.files}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-Bot-Id': fromBotId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        contentBase64,
        scope: 'task',
        scopeRef: taskId,
      }),
    });

    let payload: {
      success?: boolean;
      error?: { message?: string };
    } | null = null;
    try {
      payload = await res.json();
    } catch {
      // ignore parse errors for better fallback message
    }

    if (!res.ok || !payload?.success) {
      const msg = payload?.error?.message || tr(`上传失败 (${res.status})`, `Upload failed (${res.status})`);
      throw new Error(`${file.name}: ${msg}`);
    }
  };

  const handleAttachmentChange = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    if (picked.length === 0) return;
    setAttachments((prev) => {
      const map = new Map<string, File>();
      for (const f of prev) map.set(`${f.name}:${f.size}:${f.lastModified}`, f);
      for (const f of picked) map.set(`${f.name}:${f.size}:${f.lastModified}`, f);
      return Array.from(map.values());
    });
    e.target.value = '';
  };

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');
    setIsSubmitting(true);

    try {
      const collaborationParticipantIds = Array.from(
        new Set(
          [toBotId, ...participantBotIds]
            .filter((id): id is string => typeof id === 'string' && id.trim().length > 0 && id !== fromBotId),
        ),
      );
      const collaborationParticipantBots = collaborationParticipantIds.map((id) => {
        const bot = bots.find((b) => b.id === id);
        return {
          botId: id,
          botName: bot?.name || '',
          botOwner: bot?.ownerEmail || '',
        };
      });

      // Build intent prompt with toBotId and capability info embedded
      const lines = [
        `Delegate a task to bot ${toBotId}:`,
        `Prompt: ${prompt}`,
      ];
      if (capability) lines.push(`Capability: ${capability}`);
      lines.push(`Priority: ${priority}`);
      if (collaborationParticipantIds.length > 1) {
        lines.push(`Participants: ${collaborationParticipantBots.map((b) => b.botName ? `${b.botName}(${b.botId})` : b.botId).join(', ')}`);
      }
      if (attachments.length > 0) {
        lines.push(`Attachments: ${attachments.map((f) => f.name).join(', ')}`);
      }
      const intentPrompt = lines.join('\n');

      // Step 1: Create task via API Server (no longer goes through Gateway)
      // Persist target bot metadata in parameters so delegate_intent routing can enrich sub-session context.
      const createResult = await routerApi.createTask(intentPrompt, priority, fromBotId, {
        capability: capability || undefined,
        parameters: {
          collaboration: {
            mode: 'delegator_multi_participants',
            strictParticipantScope: true,
            participantBotIds: collaborationParticipantIds,
            participantBots: collaborationParticipantBots,
          },
          delegateIntent: {
            toBotId,
            toBotName: toBot?.name || '',
            toBotOwner: toBot?.ownerEmail || '',
            participantBotIds: collaborationParticipantIds,
            participantBots: collaborationParticipantBots,
            attachmentNames: attachments.map((f) => f.name),
            source: 'dashboard_create_task_modal',
          },
        },
      });
      if (!createResult.success) {
        setError(tr(`创建${term('task')}失败`, `Failed to create ${term('task')}`));
        return;
      }
      const taskId = createResult.data?.taskId || createResult.taskId;
      if (!taskId) {
        setError(tr(`创建${term('task')}失败：未返回 taskId`, `Failed to create ${term('task')}: missing taskId`));
        return;
      }

      // Step 2: Upload attachments into task file scope (if any)
      if (attachments.length > 0) {
        try {
          for (const file of attachments) {
            await uploadTaskAttachment(taskId, file);
          }
        } catch (uploadErr) {
          throw new Error(
            tr(`任务已创建（${taskId}），但附件上传失败：${(uploadErr as Error).message}。未提交委托意图。`, `${term('task')} created (${taskId}), but attachment upload failed: ${(uploadErr as Error).message}. Delegate intent was not submitted.`),
          );
        }
      }

      // Step 3: Register delegate intent via API Server → inbox → Gateway poll
      const result = await routerApi.delegateIntent(taskId, fromBotId);
      if (result.success) {
        const uploadedHint = attachments.length > 0
          ? tr(` 已上传 ${attachments.length} 个附件。`, ` ${attachments.length} attachment(s) uploaded.`)
          : '';
        setSuccessMessage((result.data?.message || result.message || tr('委托意图已提交，可在任务列表跟踪进度。', 'Delegate intent submitted. Track progress in the task list.')) + uploadedHint);
        setTimeout(() => {
          onSuccess?.();
          onClose();
          resetForm();
        }, 1500);
      } else {
        setError((result.message || tr('提交委托意图失败', 'Failed to submit delegate intent')) + ` (taskId: ${taskId})`);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetForm = () => {
    setFromBotId('');
    setToBotId('');
    setParticipantBotIds([]);
    setPrompt('');
    setCapability('');
    setPriority('normal');
    setAttachments([]);
    setError('');
    setSuccessMessage('');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div className="glass-strong rounded-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto animate-scale-in">
        <div className="p-6">
          <div className="glass-modal-header -mx-6 -mt-6 mb-6 px-6 py-4 rounded-t-xl flex items-center justify-between">
            <h2 className="glass-modal-title text-2xl font-bold text-gray-900">{tr(`创建${term('task')}`, `Create ${term('task')}`)}</h2>
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600"
              type="button"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          {error && (
            <div className="mb-4 bg-red-50 rounded p-3">
              <p className="text-sm text-red-800">{error}</p>
            </div>
          )}

          {successMessage && (
            <div className="mb-4 bg-green-50 rounded p-3">
              <p className="text-sm text-green-800">{successMessage}</p>
            </div>
          )}

          {!isLoggedIn ? (
            <div className="text-center py-8">
              <p className="text-gray-500 mb-2">{tr(`创建${term('task')}前请先登录。`, `Please sign in before creating a ${term('task')}.`)}</p>
              <p className="text-sm text-gray-400">{tr('请前往「我的身份」页面输入 API Key 登录。', 'Go to "My Identity" to sign in with your API key.')}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* From Bot */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {tr(`发起${term('bot')}（Requester）`, `Requester ${term('bot')}`)}
                </label>
                <select
                  value={fromBotId}
                  onChange={(e) => {
                    const nextFromBotId = e.target.value;
                    setFromBotId(nextFromBotId);
                    setParticipantBotIds((prev) => {
                      const next = prev.filter((id) => id !== nextFromBotId);
                      return next;
                    });
                    if (toBotId && toBotId === nextFromBotId) {
                      setToBotId('');
                      setCapability('');
                    }
                  }}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  required
                >
                  <option value="">{tr(`选择${term('bot')}`, `Select ${term('bot')}`)}</option>
                  {ownedBots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name} ({bot.id})
                    </option>
                  ))}
                </select>
                {ownedBots.length === 0 && (
                  <p className="text-sm text-red-600 mt-1">{tr(`未找到你名下的${term('bot')}`, `No ${term('bot')} found under your account`)}</p>
                )}
              </div>

              {/* To Bot */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {tr(`初始执行${term('bot')}（Initial Executor）`, `Initial Executor ${term('bot')}`)}
                </label>
                <select
                  value={toBotId}
                  onChange={(e) => {
                    const nextToBotId = e.target.value;
                    setToBotId(nextToBotId);
                    setCapability('');
                    setParticipantBotIds((prev) => {
                      const next = new Set(prev.filter((id) => id !== fromBotId));
                      if (nextToBotId) next.add(nextToBotId);
                      return Array.from(next);
                    });
                  }}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  required
                >
                  <option value="">{tr(`选择${term('bot')}`, `Select ${term('bot')}`)}</option>
                  {onlineBots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name} ({bot.id})
                    </option>
                  ))}
                </select>
              </div>

              {/* Collaboration Participants */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {tr(`协作参与者（可多选）`, `Collaboration participants (multi-select)`)}
                </label>
                <p className="text-xs text-gray-500 mb-2">
                  {tr(
                    `将作为该${term('task')}的候选协作者。委托与转委托应优先在此名单内进行；初始执行者会自动包含在名单中。`,
                    `These bots are preferred collaborators for this ${term('task')}. Delegation and sub-delegation should stay within this roster; initial executor is included automatically.`,
                  )}
                </p>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-200 bg-gray-50 p-2 space-y-1">
                  {collaborationBots.length === 0 ? (
                    <p className="text-xs text-gray-500 px-1 py-1">
                      {tr(`没有可用的在线${term('bot')}`, `No available online ${term('bot')}s`)}
                    </p>
                  ) : (
                    collaborationBots.map((bot) => {
                      const isInitialExecutor = bot.id === toBotId;
                      const checked = participantBotIds.includes(bot.id) || isInitialExecutor;
                      return (
                        <label
                          key={bot.id}
                          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 hover:bg-white cursor-pointer"
                        >
                          <span className="min-w-0">
                            <span className="text-sm text-gray-900">{bot.name}</span>
                            <span className="text-[11px] text-gray-500 font-mono ml-2 break-all">{bot.id}</span>
                          </span>
                          <span className="inline-flex items-center gap-2 shrink-0">
                            {isInitialExecutor && (
                              <span className="inline-flex items-center rounded border border-primary-200 bg-primary-50 px-1.5 py-0.5 text-[10px] font-semibold text-primary-700">
                                {tr('初始执行者', 'Initial')}
                              </span>
                            )}
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={isInitialExecutor}
                              onChange={(e) => {
                                const nextChecked = e.target.checked;
                                setParticipantBotIds((prev) => {
                                  const next = new Set(prev.filter((id) => id !== fromBotId));
                                  if (nextChecked) next.add(bot.id);
                                  else next.delete(bot.id);
                                  if (toBotId) next.add(toBotId);
                                  return Array.from(next);
                                });
                              }}
                            />
                          </span>
                        </label>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Prompt */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {tr(`提示词（${term('task')}描述）`, `Prompt (${term('task')} description)`)}
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  rows={4}
                  placeholder={tr(`用自然语言描述${term('task')}...`, `Describe the ${term('task')} in natural language...`)}
                  required
                />
              </div>

              {/* Capability (optional) */}
              {toBot && toBot.capabilities.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    {tr('能力（可选）', 'Capability (optional)')}
                  </label>
                  <select
                    value={capability}
                    onChange={(e) => setCapability(e.target.value)}
                    className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  >
                    <option value="">{tr('自动选择', 'Auto select')}</option>
                    {toBot.capabilities.map((cap, idx) => (
                      <option key={idx} value={cap.name}>
                        {cap.name} - {cap.description}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {/* Priority */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">{tr('优先级', 'Priority')}</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                >
                  <option value="urgent">{tr('紧急', 'Urgent')}</option>
                  <option value="high">{tr('高', 'High')}</option>
                  <option value="normal">{tr('普通', 'Normal')}</option>
                  <option value="low">{tr('低', 'Low')}</option>
                </select>
              </div>

              {/* Attachments */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  {tr('附件（可选）', 'Attachments (optional)')}
                </label>
                <label className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-primary-200 text-primary-700 hover:bg-primary-50 cursor-pointer">
                  <span>{tr('选择文件', 'Choose files')}</span>
                  <input
                    type="file"
                    multiple
                    className="hidden"
                    onChange={handleAttachmentChange}
                    disabled={isSubmitting}
                  />
                </label>
                {attachments.length > 0 ? (
                  <div className="mt-2 space-y-1">
                    {attachments.map((file, idx) => (
                      <div key={`${file.name}:${file.size}:${file.lastModified}`} className="flex items-center justify-between text-sm bg-gray-50 rounded px-2 py-1">
                        <span className="truncate pr-3">{file.name}</span>
                        <button
                          type="button"
                          onClick={() => removeAttachment(idx)}
                          className="text-gray-500 hover:text-red-600"
                          disabled={isSubmitting}
                        >
                          {tr('移除', 'Remove')}
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">
                    {tr('提交委托意图前，文件会先上传到任务工作区。', `Before submitting delegate intent, files are uploaded to the ${term('task')} workspace.`)}
                  </p>
                )}
              </div>

              <div className="bg-blue-50 rounded p-3">
                <p className="text-sm text-blue-800">
                  {tr(`任务会由你的${term('bot')}自动处理，可在任务列表跟踪进度。`, `${term('task')}s will be handled automatically by your ${term('bot')}. Track progress in the task list.`)}
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={isSubmitting || ownedBots.length === 0}
                  className="flex-1 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {isSubmitting ? tr('提交中...', 'Submitting...') : tr('提交', 'Submit')}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  {tr('取消', 'Cancel')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
