import React, { useState, useEffect } from 'react';
import { Sparkles, Trash2, Wrench, Brain, Info, Pencil, X } from 'lucide-react';
import { skillAuthor, type AuthoredSkill } from '../../services/SkillAuthor';
import { resolveSkillIcon } from '../../utils/skillIcons';

/**
 * Authored Skills — surfaces the learning loop.
 *
 * A skill GIA wrote must never be indistinguishable from a shipped one, so
 * these are listed separately with their provenance, and the user can edit or
 * delete any of them.
 *
 * Editing matters as much as deleting. GIA learns these from experience and
 * will eventually learn a bad one — a skill that mis-fires on the wrong task,
 * or that encodes an approach the user never wanted repeated. A learning loop
 * the user cannot correct is not a learning loop, it is a slow-motion mistake.
 */
export const AuthoredSkillsSection: React.FC = () => {
  const [skills, setSkills] = useState<AuthoredSkill[]>([]);
  const [editing, setEditing] = useState<AuthoredSkill | null>(null);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editPrompt, setEditPrompt] = useState('');
  const [editTools, setEditTools] = useState('');
  const [editError, setEditError] = useState<string | null>(null);

  const refresh = () => setSkills(skillAuthor.list());

  useEffect(() => {
    refresh();
  }, []);

  const startEdit = (s: AuthoredSkill) => {
    setEditing(s);
    setEditName(s.name);
    setEditDesc(s.description);
    setEditPrompt(s.systemPrompt);
    setEditTools(s.tools.join(', '));
    setEditError(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    const res = skillAuthor.update(editing.id, {
      name: editName.trim(),
      description: editDesc.trim(),
      systemPrompt: editPrompt.trim(),
      tools: editTools.split(',').map(t => t.trim()).filter(Boolean),
    });
    if (!res.ok) { setEditError(res.error ?? 'Could not save.'); return; }
    setEditing(null);
    refresh();
  };

  const handleRemove = (id: string, name: string) => {
    if (!confirm(`Delete the skill "${name}"? GIA will stop applying it in future sessions.`)) return;
    skillAuthor.remove(id);
    refresh();
  };

  return (
    <div className="gia-card p-4" style={{ display: 'flex', flexDirection: 'column', gap: '10px', borderColor: 'rgba(168,85,247,0.2)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain size={14} style={{ color: '#a855f7' }} />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>
            Learned Skills
          </span>
        </div>
        {skills.length > 0 && (
          <span className="text-[9px] px-2 py-0.5 rounded-full" style={{
            background: 'rgba(168,85,247,0.12)', color: '#a855f7', border: '1px solid rgba(168,85,247,0.25)',
          }}>{skills.length}</span>
        )}
      </div>

      {skills.length === 0 ? (
        <div className="py-4 text-center">
          <Sparkles size={18} style={{ color: '#a855f7', opacity: 0.4, margin: '0 auto 8px' }} />
          <p className="text-[11px]" style={{ color: 'var(--gia-muted-2)' }}>
            GIA writes her own skills when she finishes something repeatable.
            They'll show up here.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {skills.map(s => (
            <div key={s.id} className="p-3 rounded-xl" style={{ background: 'rgba(168,85,247,0.04)', border: '1px solid var(--gia-border)' }}>
              <div className="flex items-start gap-2">
                <span className="text-base leading-none shrink-0 mt-0.5" title={s.name}>{resolveSkillIcon(s)}</span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-semibold" style={{ color: 'var(--gia-text)' }}>{s.name}</p>
                  <p className="text-[10px] mt-0.5 leading-relaxed" style={{ color: 'var(--gia-muted)' }}>{s.description}</p>
                  {s.tools.length > 0 && (
                    <div className="flex items-center gap-1 mt-1.5 flex-wrap">
                      <Wrench size={8} style={{ color: 'var(--gia-muted-2)' }} />
                      {s.tools.slice(0, 4).map(t => (
                        <span key={t} className="text-[8px] px-1 py-0.5 rounded" style={{
                          background: 'var(--gia-overlay)', color: 'var(--gia-muted-2)',
                        }}>{t}</span>
                      ))}
                      {s.tools.length > 4 && <span className="text-[8px]" style={{ color: 'var(--gia-muted-2)' }}>+{s.tools.length - 4}</span>}
                    </div>
                  )}
                  <p className="text-[9px] mt-1" style={{ color: 'var(--gia-muted-2)' }}>
                    Applied automatically · used {s.useCount}x
                    {s.origin ? ` · learned from: ${s.origin.slice(0, 60)}` : ''}
                    {s.editedByUser ? ' · edited by you' : ''}
                  </p>
                </div>
                <button
                  onClick={() => startEdit(s)}
                  className="p-1.5 rounded-lg shrink-0"
                  style={{ background: 'rgba(168,85,247,0.1)', color: '#a855f7' }}
                  title="Edit this skill"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => handleRemove(s.id, s.name)}
                  className="p-1.5 rounded-lg shrink-0"
                  style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}
                  title="Delete this skill"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-start gap-2 pt-1">
        <Info size={11} style={{ color: 'var(--gia-muted-2)', flexShrink: 0, marginTop: 1 }} />
        <p className="text-[9px] leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
          These are written by GIA herself, not shipped with the app. She creates them after solving
          something non-trivial you might ask for again, then applies them automatically in future
          sessions. Stored only on this machine — and yours to edit or delete, because she will
          eventually learn one you do not want.
        </p>
      </div>

      {editing && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }}>
          <div className="gia-card p-4 w-full max-w-lg flex flex-col gap-3" style={{ background: 'var(--gia-surface)' }}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold" style={{ color: 'var(--gia-text)' }}>Edit skill</span>
              <button onClick={() => setEditing(null)} className="p-1 rounded-lg hover:bg-white/5" style={{ color: 'var(--gia-muted)' }}>
                <X size={14} />
              </button>
            </div>

            <label className="flex flex-col gap-1">
              <span className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>Name</span>
              <input value={editName} onChange={e => setEditName(e.target.value)} className="gia-input" style={{ fontSize: '12px' }} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>When to use it</span>
              <input value={editDesc} onChange={e => setEditDesc(e.target.value)} className="gia-input" style={{ fontSize: '12px' }} />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>Instructions GIA follows</span>
              <textarea
                value={editPrompt}
                onChange={e => setEditPrompt(e.target.value)}
                rows={5}
                className="gia-input resize-none"
                style={{ fontSize: '12px', lineHeight: 1.5 }}
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>Tools (comma separated — check /tools for valid ids)</span>
              <input value={editTools} onChange={e => setEditTools(e.target.value)} className="gia-input" placeholder="web_search, filesystem_read" style={{ fontSize: '12px' }} />
            </label>

            {editError && (
              <p className="text-[10px]" style={{ color: '#f87171' }}>{editError}</p>
            )}

            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setEditing(null)} className="text-[11px] px-3 py-2 rounded-xl" style={{ color: 'var(--gia-muted)' }}>
                Cancel
              </button>
              <button
                onClick={saveEdit}
                className="text-[11px] font-semibold px-4 py-2 rounded-xl"
                style={{ background: 'rgba(168,85,247,0.18)', color: '#c4b5fd', border: '1px solid rgba(168,85,247,0.3)' }}
              >
                Save changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AuthoredSkillsSection;