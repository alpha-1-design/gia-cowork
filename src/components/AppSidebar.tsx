import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGiaStore, Module } from '../store/useGiaStore';
import { MODULES } from '../config/appModules';

/**
 * AppSidebar — desktop module rail.
 *
 * The Android port hid module switching behind the avatar + a left-swipe
 * drawer, which reads as a phone. On desktop the modules live in a
 * permanent, slim icon rail on the left edge: one click to switch, no
 * gestures required. Settings is pinned to the bottom. Respects the same
 * hidden-modules list as the command palette and the profile drawer.
 *
 * Hidden below `md` — narrow previews still fall back to the drawer.
 */
const AppSidebar: React.FC = () => {
  const { currentModule, setModule, hiddenModules } = useGiaStore(useShallow((s) => ({
    currentModule: s.currentModule,
    setModule: s.setModule,
    hiddenModules: s.hiddenModules,
  })));

  const modules = MODULES.filter((m) => m.id !== 'settings' && !hiddenModules.includes(m.id));
  const settings = MODULES.find((m) => m.id === 'settings');

  const Item: React.FC<{ mod: { id: Module; label: string; icon: React.ReactNode; color: string } }> = ({ mod }) => {
    const active = currentModule === mod.id;
    return (
      <button
        onClick={() => setModule(mod.id)}
        title={mod.label}
        aria-label={mod.label}
        className="relative w-11 h-11 rounded-xl flex items-center justify-center transition-all tap-feedback shrink-0"
        style={{
          background: active ? 'rgba(168,85,247,0.12)' : 'transparent',
          color: active ? mod.color : 'var(--gia-muted-2)',
          border: `1px solid ${active ? 'rgba(168,85,247,0.25)' : 'transparent'}`,
        }}
      >
        {active && (
          <span
            className="absolute -left-[9px] top-1/2 -translate-y-1/2 w-[3px] h-5 rounded-full"
            style={{ background: mod.color, boxShadow: `0 0 8px ${mod.color}` }}
          />
        )}
        {mod.icon}
      </button>
    );
  };

  return (
    <aside
      className="hidden md:flex flex-col items-center py-3 gap-1.5 w-[52px] shrink-0"
      style={{ background: 'var(--gia-surface)', borderRight: '1px solid var(--gia-border)' }}
    >
      {modules.map((mod) => <Item key={mod.id} mod={mod} />)}
      {settings && (
        <div className="mt-auto">
          <Item mod={settings} />
        </div>
      )}
    </aside>
  );
};

export default AppSidebar;