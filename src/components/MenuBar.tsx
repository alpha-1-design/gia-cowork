import React, { useState, useEffect, useRef } from 'react';
import { useGiaStore } from '../store/useGiaStore';
import { exportBrainToFile, importBrainFromFile } from '../services/BrainExport';

interface MenuBarProps {
  onOpenPalette: () => void;
  onOpenTerminal: () => void;
  onOpenEngineRoom: () => void;
  onOpenTaskBoard: () => void;
  onOpenNotes: () => void;
}

interface MenuItem {
  label: string;
  shortcut?: string;
  action: () => void;
}

interface Menu {
  id: string;
  label: string;
  items: MenuItem[];
}

/**
 * MenuBar — classic desktop menu strip (File / Edit / View / Tools / Help).
 *
 * Gives Cowork the menu-bar affordance desktop users expect, without
 * depending on native window menus: every action here is already exposed
 * through the command palette, but a visible strip makes the app feel like
 * a desktop workspace instead of a phone shell. Hidden in narrow previews
 * (the palette + sidebar still cover everything).
 */
const MenuBar: React.FC<MenuBarProps> = ({ onOpenPalette, onOpenTerminal, onOpenEngineRoom, onOpenTaskBoard, onOpenNotes }) => {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const store = () => useGiaStore.getState();

  const toggleFeature = (key: 'webSearch' | 'extThinking' | 'handsOff', label: string) => {
    const s = store();
    if (key === 'webSearch') { s.setWebSearch(!s.webSearch); s.addNotification(`Web search ${s.webSearch ? 'disabled' : 'enabled'}`); }
    if (key === 'extThinking') { s.setExtThinking(!s.extThinking); s.addNotification(`Extended thinking ${s.extThinking ? 'disabled' : 'enabled'}`); }
    if (key === 'handsOff') { s.setHandsOff(!s.handsOff); s.addNotification(`Hands-off ${s.handsOff ? 'disabled' : 'enabled'}`); }
    setOpenMenu(null);
  };

  const MENUS: Menu[] = [
    {
      id: 'file',
      label: 'File',
      items: [
        { label: 'New Chat', shortcut: 'Ctrl+N', action: () => { store().createSession(); setOpenMenu(null); } },
        { label: 'Clear Current Chat', action: () => { const s = store(); if (s.activeSessionId) { s.clearSession(s.activeSessionId); s.addNotification('Session cleared'); } setOpenMenu(null); } },
        { label: 'Export Brain', action: () => { try { exportBrainToFile(); store().addNotification('Brain exported'); } catch { store().addNotification('Export failed'); } setOpenMenu(null); } },
        { label: 'Import Brain', action: () => { setOpenMenu(null); const input = document.createElement('input'); input.type = 'file'; input.accept = 'application/json,.json'; input.onchange = () => { const file = input.files?.[0]; if (!file) return; importBrainFromFile(file).then(r => store().addNotification(r.message)).catch(() => store().addNotification('Import failed')); }; input.click(); } },
      ],
    },
    {
      id: 'edit',
      label: 'Edit',
      items: [
        { label: 'Toggle Web Search', action: () => toggleFeature('webSearch', 'Web search') },
        { label: 'Toggle Extended Thinking', action: () => toggleFeature('extThinking', 'Extended thinking') },
        { label: 'Toggle Hands-Off Mode', action: () => toggleFeature('handsOff', 'Hands-off') },
      ],
    },
    {
      id: 'view',
      label: 'View',
      items: [
        { label: 'Command Palette', shortcut: 'Ctrl+K', action: () => { setOpenMenu(null); onOpenPalette(); } },
        { label: 'Toggle Fullscreen', action: () => { store().toggleFullScreenMode(); setOpenMenu(null); } },
      ],
    },
    {
      id: 'tools',
      label: 'Tools',
      items: [
        { label: 'Open Terminal', action: () => { setOpenMenu(null); onOpenTerminal(); } },
        { label: 'Engine Room', action: () => { setOpenMenu(null); onOpenEngineRoom(); } },
        { label: 'Task Board', action: () => { setOpenMenu(null); onOpenTaskBoard(); } },
        { label: 'Notes', action: () => { setOpenMenu(null); onOpenNotes(); } },
      ],
    },
    {
      id: 'help',
      label: 'Help',
      items: [
        { label: 'Settings', action: () => { store().setModule('settings'); setOpenMenu(null); } },
        { label: 'About GIA Cowork', action: () => { store().setModule('settings'); setOpenMenu(null); } },
      ],
    },
  ];

  // Close the open menu on outside click or Escape.
  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (e: PointerEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpenMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenMenu(null); };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [openMenu]);

  return (
    <div
      ref={barRef}
      className="hidden md:flex items-center gap-0.5 px-2 shrink-0 relative z-[110]"
      style={{ background: 'var(--gia-surface)', borderBottom: '1px solid var(--gia-border)', height: 30 }}
    >
      {MENUS.map((menu) => (
        <div key={menu.id} className="relative">
          <button
            onClick={() => setOpenMenu(openMenu === menu.id ? null : menu.id)}
            className="px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors"
            style={{
              color: openMenu === menu.id ? 'var(--gia-text)' : 'var(--gia-muted)',
              background: openMenu === menu.id ? 'rgba(255,255,255,0.06)' : 'transparent',
            }}
          >
            {menu.label}
          </button>
          {openMenu === menu.id && (
            <div
              className="absolute left-0 top-full mt-0.5 w-60 rounded-xl overflow-hidden shadow-2xl"
              style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', zIndex: 120 }}
            >
              {menu.items.map((item) => (
                <button
                  key={item.label}
                  onClick={item.action}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-[11px] transition-colors hover:bg-white/5"
                  style={{ color: 'var(--gia-text)' }}
                >
                  <span>{item.label}</span>
                  {item.shortcut && (
                    <kbd className="text-[9px] px-1.5 py-0.5 rounded" style={{ background: 'rgba(255,255,255,0.06)', color: 'var(--gia-muted-2)' }}>
                      {item.shortcut}
                    </kbd>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
      <span className="ml-auto text-[10px] pr-1 select-none" style={{ color: 'var(--gia-muted-2)' }}>
        GIA Cowork
      </span>
    </div>
  );
};

export default MenuBar;