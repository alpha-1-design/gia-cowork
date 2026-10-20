import React from 'react';
import { Maximize2 } from 'lucide-react';
import { useGiaStore, Module } from '../store/useGiaStore';
import { useShallow } from 'zustand/react/shallow';
import { MODULES } from '../config/appModules';
import { GIA_BOTS } from './GiaBots';

interface AppNavigationProps {
  onModuleChange?: (mod: Module) => void;
}

const AppNavigation: React.FC<AppNavigationProps> = () => {
  const { currentModule, userProfile, connectionStatus, providerConnected, fullScreenMode, toggleFullScreenMode, setShowLeftDrawer, activeSkillId } = useGiaStore(useShallow(s => ({
    currentModule: s.currentModule,
    userProfile: s.userProfile,
    connectionStatus: s.connectionStatus,
    providerConnected: s.providerConnected,
    fullScreenMode: s.fullScreenMode,
    toggleFullScreenMode: s.toggleFullScreenMode,
    setShowLeftDrawer: s.setShowLeftDrawer,
    activeSkillId: s.activeSkillId,
  })));

  const statusColor = connectionStatus === 'offline' ? '#71717a' : !providerConnected ? '#e7c27a' : '#d6c6a1';
  const statusWord = connectionStatus === 'offline' ? 'Offline' : !providerConnected ? 'Awaiting a key' : 'Armed';
  const bot = GIA_BOTS.find(b => b.id === activeSkillId) ?? GIA_BOTS[0];
  const cur = MODULES.find(m => m.id === currentModule) ?? MODULES[0];

  return (
    <header
      className="flex items-center justify-between px-4 shrink-0 relative z-[100] h-12 overflow-visible"
      style={{ background: '#070709', borderBottom: '1px solid rgba(214,198,161,0.16)' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          className="flex items-center gap-2 shrink-0"
          onClick={() => setShowLeftDrawer(true)}
          title="Open profile"
        >
          <span
            className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold"
            style={{ background: 'linear-gradient(160deg, #f4efe4, #c4b48a)', color: '#1a1610' }}
          >
            G
          </span>
          <span className="text-[15px] font-medium tracking-[0.18em]" style={{ color: '#f4efe4' }}>GIA</span>
        </button>
        <div className="w-px h-4 shrink-0" style={{ background: 'rgba(214,198,161,0.25)' }} />
        <span className="text-[11px] tracking-wide truncate" style={{ color: '#d6c6a1' }}>
          {bot.name}
          <span style={{ color: 'rgba(214,198,161,0.45)' }}> · {bot.role}</span>
        </span>
        <span className="hidden lg:inline text-[11px] truncate" style={{ color: 'var(--gia-muted-2)' }}>
          {cur.label}
        </span>
      </div>
      <div className="flex items-center gap-2.5 shrink-0">
        <span className="hidden sm:flex items-center gap-1.5 text-[10px] tracking-wide" style={{ color: statusColor }} title={statusWord}>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusColor }} />
          {statusWord}
        </span>
        <button
          onClick={toggleFullScreenMode}
          className="w-7 h-7 rounded-full flex items-center justify-center"
          style={{
            background: 'transparent',
            border: '1px solid rgba(214,198,161,0.2)',
            color: fullScreenMode ? '#f4efe4' : 'var(--gia-muted)',
          }}
          title={fullScreenMode ? 'Exit full screen' : 'Full screen'}
        >
          <Maximize2 size={13} />
        </button>
        <button
          type="button"
          className="w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-medium"
          onClick={() => setShowLeftDrawer(true)}
          style={{ border: '1px solid rgba(214,198,161,0.35)', color: '#f4efe4', background: 'transparent' }}
          title="Profile"
        >
          {userProfile.name ? userProfile.name[0].toUpperCase() : '·'}
        </button>
      </div>
    </header>
  );
};

export default AppNavigation;
