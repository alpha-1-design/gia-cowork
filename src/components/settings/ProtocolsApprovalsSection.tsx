import React from 'react';
import { Shield, ShieldCheck, ShieldAlert, RefreshCw, Trash2, Power, Unlock, X } from 'lucide-react';
import { useProtocolStore } from '../../store/useProtocolStore';
import { useTrustStore } from '../../store/useTrustStore';
import { RISK_META, RISK_ORDER, type RiskLevel } from '../../services/permissions';
import { Switch } from '../ui/Switch';

/**
 * Approvals settings.
 *
 * This used to be a grid of per-category "auto-approve" switches — allow all
 * web fetches, allow all file writes, allow all code execution. Two problems,
 * one conceptual and one practical.
 *
 * Conceptually, a category is the wrong unit. "Allow all code execution" is
 * simultaneously `npm test` and `git push --force`, and the person flipping
 * that switch cannot tell which one they agreed to. It is also permanent:
 * there was no "just for this task".
 *
 * Practically, that grid is now dead. Approval moved to the trust layer, which
 * rates the actual arguments and grants per path or command prefix. Leaving the
 * switches here would mean leaving labels like "Auto-approved — no prompt" on
 * controls that no longer control anything, which is worse than removing them.
 */
export const ProtocolsApprovalsSection: React.FC = () => {
  const {
    fullAutonomy, setFullAutonomy,
    clearConsoleProtocols, consoleProtocols,
  } = useProtocolStore();

  const armed = useTrustStore(s => s.armed);
  const setArmed = useTrustStore(s => s.setArmed);
  const askThreshold = useTrustStore(s => s.askThreshold);
  const setAskThreshold = useTrustStore(s => s.setAskThreshold);
  const grants = useTrustStore(s => s.grants);
  const sessionGrants = useTrustStore(s => s.sessionGrants);
  const revoke = useTrustStore(s => s.revoke);
  const revokeAll = useTrustStore(s => s.revokeAll);

  const allGrants = [...sessionGrants, ...grants];
  const activeCount = consoleProtocols.filter(p => p.state === 'proposed' || p.state === 'executing').length;
  const totalCount = consoleProtocols.length;

  const buttonStyle = {
    background: 'var(--gia-overlay-2)',
    color: 'var(--gia-muted)',
    border: '1px solid var(--gia-border)',
  } as const;

  return (
    <div className="gia-card p-4">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck size={14} className="text-violet-400" />
        <span className="text-xs font-semibold" style={{ color: 'var(--gia-text)' }}>Protocols & Approvals</span>
      </div>

      {/* The kill switch comes first because it is the only control that has
          to be reachable when something is already going wrong. */}
      <Switch
        checked={armed}
        onChange={setArmed}
        label={armed ? 'GIA can run tools' : 'GIA is stopped'}
        description={
          armed
            ? 'Armed. Anything she has not already been granted will stop and ask.'
            : 'Every tool call is blocked — no prompts, nothing runs. Press Ctrl/Cmd+Shift+X to re-arm.'
        }
        icon={armed ? <Unlock size={13} /> : <Power size={13} />}
        accentColor={armed ? '#22c55e' : '#ef4444'}
      />

      <Switch
        checked={fullAutonomy}
        onChange={setFullAutonomy}
        label="Full Autonomy Mode"
        description="When ON, GIA runs tools without asking. The kill switch still works — this only skips the prompts."
        icon={<Shield size={13} />}
        accentColor="#ef4444"
      />

      {!fullAutonomy && (
        <div className="mt-3 p-2.5 rounded-lg" style={{ background: 'var(--gia-overlay)' }}>
          <p className="text-[9px] font-semibold uppercase tracking-wider mb-2" style={{ color: 'var(--gia-muted-2)' }}>
            Ask me at or above
          </p>
          <div className="flex flex-wrap gap-1.5">
            {RISK_ORDER.filter(l => l !== 'none').map(level => (
              <button
                key={level}
                onClick={() => setAskThreshold(level as RiskLevel)}
                className="text-[10px] font-semibold px-2.5 py-1.5 rounded-lg transition-all"
                style={
                  askThreshold === level
                    ? { background: `${RISK_META[level].color}22`, color: RISK_META[level].color, border: `1px solid ${RISK_META[level].color}55` }
                    : buttonStyle
                }
              >
                {RISK_META[level].label}
              </button>
            ))}
          </div>
          <p className="text-[9px] mt-2 leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
            {RISK_META[askThreshold].blurb} Anything below this runs without a prompt — reads are always{' '}
            {RISK_META.none.label.toLowerCase()}, so this never turns a search into a dialog.
          </p>
        </div>
      )}

      <div className="mt-3 p-2.5 rounded-lg" style={{ background: 'var(--gia-overlay)' }}>
        <div className="flex items-center justify-between mb-2">
          <p className="text-[9px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted-2)' }}>
            What she is allowed to do
          </p>
          {allGrants.length > 0 && (
            <button
              onClick={revokeAll}
              className="flex items-center gap-1 text-[9px] px-2 py-1 rounded-lg transition-all"
              style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}
            >
              <Trash2 size={10} /> Revoke all
            </button>
          )}
        </div>

        {allGrants.length === 0 ? (
          <p className="text-[10px] leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
            No standing permissions. She asks before every write and every command — you can then allow it once, for this
            session, or for good.
          </p>
        ) : (
          <div className="space-y-1.5">
            {allGrants.map(g => (
              <div
                key={`${g.session ? 's' : 'p'}-${g.scope}`}
                className="flex items-center gap-2 p-2 rounded-lg"
                style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--gia-border)' }}
              >
                <ShieldAlert size={11} style={{ color: RISK_META[g.risk].color }} className="shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-medium truncate" style={{ color: 'var(--gia-text)' }}>
                    {g.label}
                  </p>
                  <p className="text-[9px]" style={{ color: 'var(--gia-muted-2)' }}>
                    {RISK_META[g.risk].label} risk · used {g.uses}×{g.session ? ' · this session only' : ''}
                  </p>
                </div>
                <button
                  onClick={() => revoke(g.scope)}
                  title="Revoke"
                  aria-label={`Revoke ${g.label}`}
                  className="shrink-0 p-1 rounded-md transition-all"
                  style={{ background: 'transparent', color: 'var(--gia-muted-2)' }}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {totalCount > 0 && (
        <div className="mt-3 p-2.5 rounded-lg flex items-center justify-between" style={{ background: 'var(--gia-overlay)' }}>
          <div className="flex items-center gap-2">
            <RefreshCw size={11} style={{ color: 'var(--gia-muted-2)' }} />
            <span className="text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>
              {totalCount} protocol{totalCount !== 1 ? 's' : ''} recorded
              {activeCount > 0 && ` (${activeCount} active)`}
            </span>
          </div>
          <button
            onClick={clearConsoleProtocols}
            className="flex items-center gap-1 text-[9px] px-2 py-1 rounded-lg transition-all"
            style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}
          >
            <Trash2 size={10} /> Clear
          </button>
        </div>
      )}

      <div className="mt-3 p-2.5 rounded-lg" style={{ background: 'rgba(168,85,247,0.06)', border: '1px solid rgba(168,85,247,0.12)' }}>
        <p className="text-[9px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
          When GIA stops, you see what the action will actually do — a real diff for a file write, the exact command
          otherwise — and why it was rated that way. Permission is scoped to what was asked: a directory, or a command
          prefix. Granting “writes under <span className="font-mono">src</span>” never covers a write anywhere else. Type{' '}
          <span className="font-mono">/trust</span> in chat for the same list and an audit trail.
        </p>
      </div>
    </div>
  );
};