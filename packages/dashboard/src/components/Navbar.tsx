import { Link, useLocation } from 'react-router-dom';
import { useIdentity } from '@/lib/identity';
import { useTheme } from '@/hooks/useTheme';
import { useTasks } from '@/hooks/useTasks';
import { BotAvatar } from './BotAvatar';
import { cn } from '@/lib/utils';

const navigation = [
  { name: 'Dashboard', href: '/' },
  { name: 'Bots', href: '/bots' },
  { name: 'Tasks', href: '/tasks' },
  { name: 'Files', href: '/files' },
  { name: 'Team', href: '/team' },
  { name: 'Sessions', href: '/sessions' },
  { name: 'Routes', href: '/routes' },
];

interface NavbarProps {
  connectionStatus?: { api: boolean; router: boolean };
}

export function Navbar({ connectionStatus }: NavbarProps) {
  const location = useLocation();
  const { me, isLoggedIn } = useIdentity();
  const { dark, toggle } = useTheme();
  const { data: tasks = [] } = useTasks();

  const inboxCount = tasks.filter((t) => {
    if (t.status !== 'waiting_for_input' || !me?.currentBot?.id) return false;
    const result = t.result as any;
    const requests: Array<{ botId: string }> = result?.waitingRequests || [];
    if (requests.length > 0) {
      return requests.some((r: any) => r.botId === me.currentBot!.id);
    }
    // Legacy fallback
    const requestedBy = result?.waitingRequestedBy;
    if (requestedBy) return requestedBy === me.currentBot.id;
    return t.toBotId === me.currentBot.id || t.fromBotId === me.currentBot.id;
  }).length;

  return (
    <nav className="sticky top-0 z-50 glass">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <div className="flex items-center">
            <div className="flex-shrink-0 flex items-center gap-2">
              <img src="/clawteam-logo.png" alt="ClawTeam" className="h-8 w-8 rounded-lg" />
              <h1 className="text-xl font-bold text-gray-900">ClawTeam</h1>
            </div>
            <div className="ml-10 flex items-baseline space-x-1">
              {navigation.map((item) => {
                const isActive = item.href === '/'
                  ? location.pathname === '/'
                  : location.pathname.startsWith(item.href);
                return (
                  <Link
                    key={item.name}
                    to={item.href}
                    className={cn(
                      'relative px-3 py-2 rounded-md text-sm font-medium transition-colors',
                      isActive
                        ? 'text-primary-600'
                        : 'text-gray-600 hover:text-gray-900'
                    )}
                  >
                    {item.name}
                    {isActive && (
                      <span className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-primary-600" />
                    )}
                  </Link>
                );
              })}
            </div>
          </div>

          {/* Connection status + Inbox + Theme toggle + User identity */}
          <div className="flex items-center gap-2">
            {connectionStatus && (!connectionStatus.api || !connectionStatus.router) && (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-yellow-50 text-xs text-yellow-700">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-yellow-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-yellow-500" />
                </span>
                {!connectionStatus.api && !connectionStatus.router
                  ? 'API & Router'
                  : !connectionStatus.api
                    ? 'API'
                    : 'Router'}
              </span>
            )}
            <Link
              to="/inbox"
              className={cn(
                'relative px-3 py-2 rounded-md text-sm font-medium transition-colors',
                location.pathname === '/inbox'
                  ? 'text-primary-600'
                  : 'text-gray-600 hover:text-gray-900'
              )}
            >
              Inbox
              {location.pathname === '/inbox' && (
                <span className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full bg-primary-600" />
              )}
              {inboxCount > 0 && (
                <span className="absolute -top-1 -right-1 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-amber-500 rounded-full">
                  {inboxCount}
                </span>
              )}
            </Link>
            <button
              onClick={toggle}
              className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 transition-colors"
              title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {dark ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
              )}
            </button>
            <Link
            to="/me"
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors',
              location.pathname === '/me'
                ? 'bg-primary-100'
                : 'hover:bg-gray-100'
            )}
          >
            {isLoggedIn && me ? (
              <>
                <BotAvatar
                  name={me.currentBot.name}
                  id={me.currentBot.id}
                  avatarColor={me.currentBot.avatarColor}
                  avatarUrl={me.currentBot.avatarUrl}
                  size="sm"
                />
                <span className="text-sm font-medium text-gray-700 max-w-[120px] truncate">
                  {me.ownerEmail.split('@')[0]}
                </span>
              </>
            ) : (
              <span className="text-sm text-gray-500">Sign in</span>
            )}
          </Link>
          </div>
        </div>
      </div>
    </nav>
  );
}
