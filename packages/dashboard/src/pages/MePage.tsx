import { useState } from 'react';
import { useIdentity } from '@/lib/identity';
import { BotAvatar } from '@/components/BotAvatar';
import { StatusBadge } from '@/components/StatusBadge';
import { formatDate } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export function MePage() {
  const { tr, term } = useI18n();
  const { me, isLoggedIn, login, logout, loading, error } = useIdentity();
  const [keyInput, setKeyInput] = useState('');

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    if (!keyInput.trim()) return;
    await login(keyInput.trim());
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="h-48 bg-gray-200 rounded" />
        </div>
      </div>
    );
  }

  if (!isLoggedIn || !me) {
    return (
      <div className="max-w-xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
        <div className="bg-white rounded-xl p-8 card-gradient">
          <h2 className="text-2xl font-bold text-gray-900 mb-2">{tr('你是谁？', 'Who are you?')}</h2>
          <p className="text-gray-500 text-sm mb-6">
            {tr('粘贴你的 ClawTeam API Key 进行身份识别。该密钥仅存储在你本地浏览器中。', 'Paste your ClawTeam API key for identity verification. The key is stored only in your browser.')}
          </p>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label htmlFor="apiKey" className="block text-sm font-medium text-gray-700 mb-1">
                {tr('API 密钥', 'API Key')}
              </label>
              <input
                id="apiKey"
                type="password"
                value={keyInput}
                onChange={e => setKeyInput(e.target.value)}
                placeholder="clawteam_test-team_my-bot_..."
                className="w-full px-3 py-2 bg-gray-50 rounded-lg text-sm font-mono focus:ring-2 focus:ring-primary-500"
                autoFocus
              />
            </div>
            {error && (
              <p className="text-sm text-red-600">{error}</p>
            )}
            <button
              type="submit"
              disabled={!keyInput.trim() || loading}
              className="w-full px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700 disabled:opacity-50 transition-colors"
            >
              {loading ? tr('验证中...', 'Verifying...') : tr('识别身份', 'Identify')}
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      {/* Identity card */}
      <div className="bg-white rounded-xl p-6 mb-6 card-gradient">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-2xl font-bold text-gray-900">{tr('我的身份', 'My Identity')}</h2>
          <button
            onClick={logout}
            className="px-3 py-1.5 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            {tr('退出登录', 'Sign out')}
          </button>
        </div>

        <div className="flex items-center gap-4">
          <BotAvatar
            name={me.currentBot.name}
            id={me.currentBot.id}
            avatarColor={me.currentBot.avatarColor}
            avatarUrl={me.currentBot.avatarUrl}
            size="lg"
          />
          <div>
            <p className="text-lg font-semibold text-gray-900">{me.ownerEmail}</p>
            <p className="text-sm text-gray-500">
              {tr(`当前认证${term('bot')}：`, `Current authenticated ${term('bot')}:`)}<span className="font-medium">{me.currentBot.name}</span>
            </p>
            <p className="text-xs text-gray-400 font-mono mt-0.5">{me.currentBot.id}</p>
          </div>
        </div>
      </div>

      {/* My bots */}
      <div>
        <h3 className="text-lg font-semibold text-gray-900 mb-3">
          {tr(`我的${term('bot')}（${me.ownedBots.length}）`, `My ${term('bot')}s (${me.ownedBots.length})`)}
        </h3>
        <div className="space-y-3">
          {me.ownedBots.map(bot => (
            <div key={bot.id} className="bg-white rounded-xl p-4 card-hover card-gradient">
              <div className="flex items-center gap-3">
                <BotAvatar
                  name={bot.name}
                  id={bot.id}
                  avatarColor={bot.avatarColor}
                  avatarUrl={bot.avatarUrl}
                  size="md"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">{bot.name}</span>
                    <StatusBadge status={bot.status} />
                  </div>
                  <p className="text-xs text-gray-500 font-mono truncate">{bot.id}</p>
                </div>
                <div className="text-right text-xs text-gray-400 shrink-0">
                  <p>{tr(`${bot.capabilities.length} 个能力`, `${bot.capabilities.length} capabilities`)}</p>
                  {bot.lastSeen && <p>{tr('最后在线', 'Last seen')}: {formatDate(bot.lastSeen)}</p>}
                </div>
              </div>
              {bot.capabilities.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {bot.capabilities.map((cap, i) => (
                    <span key={i} className="text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded">
                      {cap.name}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
