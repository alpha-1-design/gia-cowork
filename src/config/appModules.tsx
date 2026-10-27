import { MessageCircle, BarChart2, PenLine, ListTodo, Settings, Bot, Target, Hammer, Package } from 'lucide-react';
import type { Module } from '../store/useGiaStore';

// GIA Cowork is a desktop workspace: the Exam prep module (WASSCE/BECE/JAMB)
// was carried over from the Android app but doesn't belong in the desktop
// module rail. It stays out of MODULES so it appears nowhere in the UI.
export const MODULES: { id: Module; label: string; icon: React.ReactNode; color: string }[] = [
  { id: 'chat',     label: 'Chat',     icon: <MessageCircle size={18} />, color: 'var(--gia-text)' },
  { id: 'build',    label: 'Build',    icon: <Hammer size={18} />,        color: 'var(--gia-text)' },
  { id: 'deliverables', label: 'Deliverables', icon: <Package size={18} />, color: 'var(--gia-text)' },
  { id: 'analyst',  label: 'Analyst',  icon: <BarChart2 size={18} />,    color: 'var(--gia-text)' },
  { id: 'writer',   label: 'Writer',   icon: <PenLine size={18} />,      color: 'var(--gia-text)' },
  { id: 'planner',  label: 'Planner',  icon: <ListTodo size={18} />,     color: 'var(--gia-text)' },
  { id: 'agents',   label: 'Agents',   icon: <Bot size={18} />,          color: 'var(--gia-text)' },
  { id: 'settings', label: 'Settings', icon: <Settings size={18} />,     color: 'var(--gia-text)' },
  { id: 'autonomy', label: 'Autonomy', icon: <Target size={18} />,       color: 'var(--gia-text)' },
];