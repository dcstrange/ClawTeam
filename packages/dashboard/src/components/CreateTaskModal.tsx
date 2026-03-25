import { useState, FormEvent, ChangeEvent } from 'react';
import { useBots } from '@/hooks/useBots';
import { useIdentity } from '@/lib/identity';
import { routerApi } from '@/lib/router-api';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/config';
import type { TaskPriority } from '@/lib/types';

interface CreateTaskModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function CreateTaskModal({ isOpen, onClose, onSuccess }: CreateTaskModalProps) {
  const { data: bots = [] } = useBots();
  const { me, isLoggedIn, apiKey } = useIdentity();

  const [fromBotId, setFromBotId] = useState('');
  const [toBotId, setToBotId] = useState('');
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
      throw new Error('Login required to upload attachments');
    }
    if (!fromBotId) {
      throw new Error('Missing requester bot for attachment upload');
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
      const msg = payload?.error?.message || `Upload failed (${res.status})`;
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
      // Build intent prompt with toBotId and capability info embedded
      const lines = [
        `Delegate a task to bot ${toBotId}:`,
        `Prompt: ${prompt}`,
      ];
      if (capability) lines.push(`Capability: ${capability}`);
      lines.push(`Priority: ${priority}`);
      if (attachments.length > 0) {
        lines.push(`Attachments: ${attachments.map((f) => f.name).join(', ')}`);
      }
      const intentPrompt = lines.join('\n');

      // Step 1: Create task via API Server (no longer goes through Gateway)
      // Persist target bot metadata in parameters so delegate_intent routing can enrich sub-session context.
      const createResult = await routerApi.createTask(intentPrompt, priority, fromBotId, {
        capability: capability || undefined,
        parameters: {
          delegateIntent: {
            toBotId,
            toBotName: toBot?.name || '',
            toBotOwner: toBot?.ownerEmail || '',
            attachmentNames: attachments.map((f) => f.name),
            source: 'dashboard_create_task_modal',
          },
        },
      });
      if (!createResult.success) {
        setError('Failed to create task');
        return;
      }
      const taskId = createResult.data?.taskId || createResult.taskId;
      if (!taskId) {
        setError('Failed to create task: no taskId returned');
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
            `Task created (${taskId}) but attachment upload failed: ${(uploadErr as Error).message}. ` +
            'Delegate intent was not submitted.',
          );
        }
      }

      // Step 3: Register delegate intent via API Server → inbox → Gateway poll
      const result = await routerApi.delegateIntent(taskId, fromBotId);
      if (result.success) {
        const uploadedHint = attachments.length > 0
          ? ` Uploaded ${attachments.length} attachment(s).`
          : '';
        setSuccessMessage((result.data?.message || result.message || 'Intent submitted. Track progress in the task list.') + uploadedHint);
        setTimeout(() => {
          onSuccess?.();
          onClose();
          resetForm();
        }, 1500);
      } else {
        setError((result.message || 'Failed to submit delegate intent') + ` (taskId: ${taskId})`);
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
            <h2 className="glass-modal-title text-2xl font-bold text-gray-900">Create Task</h2>
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
              <p className="text-gray-500 mb-2">Login required to create tasks.</p>
              <p className="text-sm text-gray-400">Go to Me page and enter your API key to login.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* From Bot */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  From Bot (Requester)
                </label>
                <select
                  value={fromBotId}
                  onChange={(e) => setFromBotId(e.target.value)}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  required
                >
                  <option value="">Select a bot</option>
                  {ownedBots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name} ({bot.id})
                    </option>
                  ))}
                </select>
                {ownedBots.length === 0 && (
                  <p className="text-sm text-red-600 mt-1">No owned bots found</p>
                )}
              </div>

              {/* To Bot */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  To Bot (Executor)
                </label>
                <select
                  value={toBotId}
                  onChange={(e) => {
                    setToBotId(e.target.value);
                    setCapability('');
                  }}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  required
                >
                  <option value="">Select a bot</option>
                  {onlineBots.map((bot) => (
                    <option key={bot.id} value={bot.id}>
                      {bot.name} ({bot.id})
                    </option>
                  ))}
                </select>
              </div>

              {/* Prompt */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Prompt (Task Description)
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  rows={4}
                  placeholder="Describe the task in natural language..."
                  required
                />
              </div>

              {/* Capability (optional) */}
              {toBot && toBot.capabilities.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Capability (Optional)
                  </label>
                  <select
                    value={capability}
                    onChange={(e) => setCapability(e.target.value)}
                    className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                  >
                    <option value="">Auto</option>
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
                <label className="block text-sm font-medium text-gray-700 mb-1">Priority</label>
                <select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as TaskPriority)}
                  className="w-full bg-gray-50 rounded-lg px-3 py-2 focus:ring-2 focus:ring-primary-500 focus:border-transparent transition-shadow"
                >
                  <option value="urgent">Urgent</option>
                  <option value="high">High</option>
                  <option value="normal">Normal</option>
                  <option value="low">Low</option>
                </select>
              </div>

              {/* Attachments */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Attachments (Optional)
                </label>
                <label className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium rounded-lg border border-primary-200 text-primary-700 hover:bg-primary-50 cursor-pointer">
                  <span>Select Files</span>
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
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 mt-1">
                    Files will be uploaded to task workspace before delegate intent is sent.
                  </p>
                )}
              </div>

              <div className="bg-blue-50 rounded p-3">
                <p className="text-sm text-blue-800">
                  Task will be processed by your bot autonomously. Track progress in the task list.
                </p>
              </div>

              {/* Actions */}
              <div className="flex gap-3 pt-4">
                <button
                  type="submit"
                  disabled={isSubmitting || ownedBots.length === 0}
                  className="flex-1 bg-primary-600 text-white px-4 py-2 rounded-lg hover:bg-primary-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
                >
                  {isSubmitting ? 'Submitting...' : 'Submit'}
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
