import React from 'react';
import { Puzzle, Smartphone, Code2, Layers, LayoutGrid } from 'lucide-react';
import { SubPageHeader } from './SubPageHeader';
import { PluginSection } from './PluginSection';
import { PluginInstallSection } from './PluginInstallSection';
import { CodeHistorySection } from './CodeHistorySection';
import { DeveloperSettings } from './DeveloperSettings';
import { InstallSection } from './InstallSection';
import { ModulesSection } from './ModulesSection';

export const AppExtensionsPage: React.FC<{ onBack: () => void }> = ({ onBack }) => (
  <div className="flex flex-col h-full overflow-y-auto" style={{ background: 'var(--gia-bg)', padding: '20px 16px', gap: '16px' }}>
    <SubPageHeader title="App & Extensions" onBack={onBack} />

    <div className="px-3 py-3 rounded-xl text-xs leading-relaxed" style={{ background: 'rgba(168,85,247,0.08)', border: '1px solid rgba(168,85,247,0.15)', color: 'var(--gia-muted)' }}>
      <p className="font-semibold mb-2" style={{ color: '#a855f7' }}>About this panel</p>
      <p className="mb-2">Extend GIA beyond the built-in features. Plugins add new capabilities, the Screen Agent gives quick desktop actions, and developer settings unlock advanced controls.</p>
      <ul className="space-y-1.5 pl-3" style={{ listStyle: 'disc' }}>
        <li><strong style={{ color: '#a855f7' }}>Screen Agent</strong> — Capture and control the screen (click, type, scroll) and inspect in-chat metric visual cards.</li>
        <li><strong style={{ color: '#a855f7' }}>Modules</strong> — Hide modules you don't use (Writer, Analyst, Planner, etc.) from the module switcher and command palette.</li>
        <li><strong style={{ color: '#a855f7' }}>Plugins</strong> — Install and manage plugins that extend GIA with new hooks and behaviours. Each plugin can be toggled on/off.</li>
        <li><strong style={{ color: '#a855f7' }}>Plugin Install</strong> — Add new plugins by URL or local file. Plugins are loaded dynamically and validated before activation.</li>
        <li><strong style={{ color: '#a855f7' }}>Code History</strong> — Review all code GIA has executed through the sandbox. Useful for auditing and debugging.</li>
        <li><strong style={{ color: '#a855f7' }}>Install</strong> — Download the latest desktop release (.deb / AppImage) for Linux from GitHub Releases.</li>
        <li><strong style={{ color: '#a855f7' }}>Developer Settings</strong> — Advanced: toggle debug mode, view logs, configure HuggingFace token, clear caches.</li>
      </ul>
    </div>

    <div className="flex items-center gap-2 px-1 mt-2">
      <LayoutGrid size={14} style={{ color: '#a855f7' }} />
      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>Modules</span>
    </div>
    <ModulesSection />

    <div className="flex items-center gap-2 px-1 mt-2">
      <Puzzle size={14} style={{ color: '#a855f7' }} />
      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>Extensions</span>
    </div>
    <PluginSection />
    <PluginInstallSection />
    <CodeHistorySection />

    <div className="flex items-center gap-2 px-1 mt-2">
      <Smartphone size={14} style={{ color: '#3b82f6' }} />
      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>App</span>
    </div>
    <InstallSection />

    <div className="flex items-center gap-2 px-1 mt-2">
      <Code2 size={14} style={{ color: '#22c55e' }} />
      <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>Developer</span>
    </div>
    <DeveloperSettings />
  </div>
);
