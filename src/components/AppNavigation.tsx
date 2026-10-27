import React from 'react';
import { Maximize2, MessageSquare, Minimize2, Search } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { useShallow } from 'zustand/react/shallow';
import { MODULES } from '../config/appModules';
import { GIA_BOTS } from './GiaBots';
import GiaIcon from './GiaIcon';
import { UserAvatar } from './avatars/UserAvatar';

interface AppNavigationProps {
  onOpenPalette?: () => void;
}

// Desktop toolbar. Module switching lives in the labelled sidebar rail and
// the profile drawer — this bar names where you are, who is working, and puts
// the command palette one click away. Status, HUD, fullscreen and the profile
// avatar stay on the right so the strip reads left-to-right.
const AppNavigation: React.FC<AppNavigationProps> = ({ onOpenPalette }) => {
  const {
    currentModule, userProfile, connectionStatus, providerConnected,
    fullScreenMode, toggleFullScreenMode, setShowLeftDrawer, showHud, setShowHud,
    activeSkillId,
  } = useGiaStore(useShallow(s => ({
    currentModule: s.currentModule,
    userProfile: s.userProfile,
    connectionStatus: s.connectionStatus,
    providerConnected: s.providerConnected,
    fullScreenMode: s.fullScreenMode,
    toggleFullScreenMode: s.toggleFullScreenMode,
    setShowLeftDrawer: s.setShowLeftDrawer,
    showHud: s.showHud,
    setShowHud: s.setShowHud,
    activeSkillId: s.activeSkillId,
  })));

  const statusColor = connectionStatus === 'offline' ? 'var(--gia-muted-2)' : !providerConnected ? 'var(--gia-muted)' : 'var(--gia-text)';
  const statusWord = connectionStatus === 'offline' ? 'Offline' : !providerConnected ? 'Awaiting a key' : 'Armed';
  const statusTitle = connectionStatus === 'offline' ? 'Offline' : !providerConnected ? 'Online — no provider connected' : 'Connected to a provider';

  const cur = MODULES.find(m => m.id === currentModule) ?? MODULES[0];
  const bot = GIA_BOTS.find(b => b.id === activeSkillId) ?? GIA_BOTS[0];

  return (
    <header
      className="flex items-center gap-3 px-3 shrink-0 relative z-[100] h-[52px] overflow-visible"
      style={{ background: 'var(--gia-bg)', borderBottom: '1px solid var(--gia-border)' }}
    >
      <button
        type="button"
        className="flex items-center gap-2.5 min-w-0 shrink rounded-md px-1 py-1 tap-feedback"
        onClick={() => setShowLeftDrawer(true)}
        title="Open profile and module drawer"
        aria-label="Open profile and module drawer"
      >
        <span
          className="w-7 h-7 rounded-md flex items-center justify-center shrink-0"
          style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border-2)' }}
        >
          <GiaIcon size={15} animate={false} color="var(--gia-text)" />
        </span>
        <span className="gia-display text-[17px] leading-none shrink-0" style={{ color: 'var(--gia-text)' }}>
          GIA
        </span>
        <span className="hidden md:flex items-center gap-1.5 min-w-0 text-[10px] truncate" style={{ color: 'var(--gia-muted)' }}>
          <span className="w-px h-3 shrink-0" style={{ background: 'var(--gia-border-2)' }} />
          <span className="truncate">{bot.name}</span>
          <span className="hidden xl:inline truncate" style={{ color: 'var(--gia-muted-2)' }}>· {bot.role}</span>
        </span>
        <span className="hidden lg:inline text-[9px] font-mono uppercase tracking-[0.14em] truncate max-w-[88px]" style={{ color: 'var(--gia-muted-2)' }}>
          {cur.label}
        </span>
      </button>

      <div className="flex-1 flex justify-center px-2 min-w-0">
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden md:flex items-center gap-2 h-8 w-full max-w-[380px] px-2.5 rounded-md transition-colors hover:bg-[var(--gia-overlay)]"
          style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
          aria-label="Open command palette"
          title="Search or run a command (Ctrl+K)"
        >
          <Search size={13} style={{ color: 'var(--gia-muted)' }} />
          <span className="flex-1 text-left text-[11px] truncate" style={{ color: 'var(--gia-muted)' }}>
            Search or run a command
          </span>
          <kbd className="gia-kbd">Ctrl K</kbd>
        </button>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        <div
          className="hidden sm:flex items-center gap-1.5 h-7 px-2 rounded-md"
          style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)' }}
          title={statusTitle}
          role="status"
          aria-live="polite"
          aria-label={statusTitle}
        >
          <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor }} />
          <span className="text-[10px] font-medium" style={{ color: 'var(--gia-muted)' }}>{statusWord}</span>
        </div>

        <button
          onClick={() => setShowHud(!showHud)}
          className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
          style={{
            background: showHud ? 'var(--gia-surface-3)' : 'transparent',
            border: `1px solid ${showHud ? 'var(--gia-border-2)' : 'transparent'}`,
            color: showHud ? 'var(--gia-text)' : 'var(--gia-muted)',
          }}
          title={showHud ? 'Hide floating HUD' : 'Show floating HUD'}
          aria-label={showHud ? 'Hide floating HUD' : 'Show floating HUD'}
        >
          <MessageSquare size={14} />
        </button>

        <button
          onClick={toggleFullScreenMode}
          className="w-7 h-7 rounded-md flex items-center justify-center transition-colors"
          style={{
            background: fullScreenMode ? 'var(--gia-surface-3)' : 'transparent',
            border: `1px solid ${fullScreenMode ? 'var(--gia-border-2)' : 'transparent'}`,
            color: fullScreenMode ? 'var(--gia-text)' : 'var(--gia-muted)',
          }}
          title={fullScreenMode ? 'Exit full screen (Esc)' : 'Enter full screen'}
          aria-label={fullScreenMode ? 'Exit full screen' : 'Enter full screen'}
        >
          {fullScreenMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        <button
          type="button"
          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 tap-feedback"
          onClick={() => setShowLeftDrawer(true)}
          title="Profile & Settings"
          aria-label="Open profile and settings"
        >
          <UserAvatar avatarId={userProfile.avatarId} name={userProfile.name} size={30} />
        </button>
      </div>
    </header>
  );
};

export default AppNavigation;
