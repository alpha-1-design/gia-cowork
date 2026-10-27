import React from 'react';
import { Plus } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useGiaStore, Module } from '../store/useGiaStore';
import { MODULES } from '../config/appModules';

/**
 * AppSidebar — the desktop module rail.
 *
 * Labels matter here: a strip of nine unlabeled icons is a memory test. Each
 * item gets a small caption, a 2px active marker and a real hover surface, so
 * the rail reads as a workspace dock rather than a phone tab bar.
 */
const AppSidebar: React.FC = () => {
  const { currentModule, setModule, createSession, hiddenModules } = useGiaStore(useShallow((s) => ({
    currentModule: s.currentModule,
    setModule: s.setModule,
    createSession: s.createSession,
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
        aria-current={active ? 'page' : undefined}
        className="relative w-12 h-11 rounded-md flex flex-col items-center justify-center gap-0.5 transition-colors tap-feedback shrink-0"
        style={{
          background: active ? 'var(--gia-surface-3)' : 'transparent',
          color: active ? 'var(--gia-text)' : 'var(--gia-muted-2)',
          border: `1px solid ${active ? 'var(--gia-border-2)' : 'transparent'}`,
        }}
      >
        {active && (
          <span
            className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-5 rounded-sm"
            style={{ background: 'var(--gia-text)' }}
          />
        )}
        <span className="flex items-center justify-center">{mod.icon}</span>
        <span className="text-[8px] font-medium leading-none tracking-wide">{mod.label}</span>
      </button>
    );
  };

  return (
    <aside
      className="hidden md:flex flex-col items-center py-3 gap-1 w-[64px] shrink-0"
      style={{ background: 'var(--gia-surface)', borderRight: '1px solid var(--gia-border)' }}
    >
      <button
        onClick={() => { setModule('chat'); createSession(); }}
        className="w-9 h-9 rounded-md flex items-center justify-center transition-colors tap-feedback"
        style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-text)' }}
        title="New chat"
        aria-label="New chat"
      >
        <Plus size={17} />
      </button>

      <div className="w-8 h-px my-1 shrink-0" style={{ background: 'var(--gia-border)' }} />

      {modules.map((mod) => <Item key={mod.id} mod={mod} />)}

      {settings && (
        <div className="mt-auto pt-2" style={{ borderTop: '1px solid var(--gia-border)' }}>
          <Item mod={settings} />
        </div>
      )}
    </aside>
  );
};

export default AppSidebar;
