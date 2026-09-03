import React from 'react';
import { Maximize2 } from 'lucide-react';
import { useGiaStore, Module } from '../store/useGiaStore';
import { useShallow } from 'zustand/react/shallow';
import { MODULES } from '../config/appModules';

interface AppNavigationProps {
  onModuleChange?: (mod: Module) => void;
}

// Desktop toolbar. Module switching lives in the sidebar rail (AppSidebar)
// and the profile drawer — this bar just names where you are and holds the
// connection status, fullscreen toggle and profile entry. Slimmer than the
// old phone-style header so the workspace gets the vertical space.
const AppNavigation: React.FC<AppNavigationProps> = () => {
  const { currentModule, userProfile, connectionStatus, providerConnected, fullScreenMode, toggleFullScreenMode, setShowLeftDrawer } = useGiaStore(useShallow(s => ({
    currentModule: s.currentModule,
    userProfile: s.userProfile,
    connectionStatus: s.connectionStatus,
    providerConnected: s.providerConnected,
    fullScreenMode: s.fullScreenMode,
    toggleFullScreenMode: s.toggleFullScreenMode,
    setShowLeftDrawer: s.setShowLeftDrawer,
  })));

  const statusColor = connectionStatus === 'offline' ? '#71717a' : !providerConnected ? '#f59e0b' : '#34d399';
  const statusTitle = connectionStatus === 'offline' ? 'Offline' : !providerConnected ? 'Online — connecting to provider…' : 'Connected';
  const statusGlow = connectionStatus === 'offline' ? 'none' : !providerConnected ? '0 0 6px rgba(245,158,11,0.5)' : '0 0 6px rgba(52,211,153,0.5)';

  const cur = MODULES.find(m => m.id === currentModule) ?? MODULES[0];

  return (
    <header
      className="flex items-center justify-between px-4 shrink-0 relative z-[100] h-12 overflow-visible"
      style={{ background: 'var(--gia-bg)', borderBottom: '1px solid var(--gia-border)' }}
    >
      <div className="flex items-center gap-3 min-w-0">
        <h1
          className="text-lg font-bold tracking-tight leading-none shrink-0 cursor-pointer select-none tap-feedback"
          style={{ color: 'var(--gia-text)' }}
          onClick={() => setShowLeftDrawer(true)}
          title="Open profile & module drawer"
        >
          GIA
        </h1>
        <div className="w-px h-4 shrink-0" style={{ background: 'var(--gia-border)' }} />
        <span className="text-xs font-medium truncate shrink-0" style={{ color: cur.color }}>
          {cur.label}
        </span>
        {currentModule === 'chat' && (
          <span className="hidden lg:inline text-[11px] truncate" style={{ color: 'var(--gia-muted-2)' }}>
            Personal AI co-worker · local-first workspace
          </span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor, boxShadow: statusGlow }} title={statusTitle} />
        <button
          onClick={toggleFullScreenMode}
          className="w-7 h-7 rounded-lg flex items-center justify-center transition-all"
          style={{
            background: fullScreenMode ? 'rgba(168,85,247,0.15)' : 'var(--gia-surface-2)',
            border: `1px solid ${fullScreenMode ? 'rgba(168,85,247,0.3)' : 'var(--gia-border)'}`,
            color: fullScreenMode ? '#a855f7' : 'var(--gia-muted)',
          }}
          title={fullScreenMode ? 'Exit full screen' : 'Enter full screen'}
        >
          <Maximize2 size={14} />
        </button>
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-white text-[11px] font-bold shrink-0 tap-feedback"
          onClick={() => setShowLeftDrawer(true)}
          style={{ background: 'linear-gradient(135deg, #a855f7, #7c3aed)', boxShadow: '0 0 12px rgba(168,85,247,0.4)', cursor: 'pointer' }}
          title="Profile & Settings"
        >
          {userProfile.name ? userProfile.name[0].toUpperCase() : 'G'}
        </div>
      </div>
    </header>
  );
};

export default AppNavigation;