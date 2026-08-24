import React, { useState, useEffect, useCallback } from 'react';
import { ArrowLeft, Smartphone, Plug, PlugZap, RefreshCw, Lock, Unlock, Users, Link2 } from 'lucide-react';
import { unimindClient } from '../../services/unimindClient';
import { isFollowLockEnabled, setFollowLockEnabled, isRemoteUnlockEnabled, setRemoteUnlockEnabled } from '../../services/tools/systemControl';
import type { UnimindStatus } from '../../services/unimindClient';

interface Props {
  onBack: () => void;
}

export const UnimindPage: React.FC<Props> = ({ onBack }) => {
  const [url, setUrl] = useState(() => unimindClient.getRelayUrl());
  const [status, setStatus] = useState<UnimindStatus>(() => unimindClient.getStatus());
  const [followLock, setFollowLock] = useState(() => isFollowLockEnabled());
  const [remoteUnlock, setRemoteUnlock] = useState(() => isRemoteUnlockEnabled());
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => setStatus(unimindClient.getStatus()), []);

  useEffect(() => {
    const timer = setInterval(refresh, 2000);
    const onStatus = () => refresh();
    unimindClient.onStatusChange = onStatus;
    return () => {
      clearInterval(timer);
      if (unimindClient.onStatusChange === onStatus) unimindClient.onStatusChange = undefined;
    };
  }, [refresh]);

  const connect = async () => {
    setBusy(true);
    try {
      await unimindClient.connect(url);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const disconnect = () => {
    unimindClient.disconnect();
    refresh();
  };

  const toggleFollowLock = (v: boolean) => {
    setFollowLockEnabled(v);
    setFollowLock(v);
  };

  const toggleRemoteUnlock = (v: boolean) => {
    setRemoteUnlockEnabled(v);
    setRemoteUnlock(v);
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '8px 10px', borderRadius: '8px', fontSize: 12,
    background: 'var(--gia-bg-2)', color: 'var(--gia-text)', border: '1px solid var(--gia-border)',
    fontFamily: 'monospace',
  };
  const cardStyle: React.CSSProperties = { background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', borderRadius: '12px', padding: '14px' };
  const btnBase: React.CSSProperties = { padding: '8px 14px', borderRadius: '8px', fontSize: 12, fontWeight: 600, cursor: 'pointer', border: '1px solid var(--gia-border)' };

  return (
    <div className="p-4" style={{ maxWidth: 640, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
      <button onClick={onBack} className="flex items-center gap-1 text-xs" style={{ background: 'none', border: 'none', color: 'var(--gia-muted)', cursor: 'pointer' }}>
        <ArrowLeft size={14} /> Settings
      </button>

      <div className="flex items-center gap-2">
        <Smartphone size={18} style={{ color: '#8b5cf6' }} />
        <span className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Unimind — cross-device pairing</span>
      </div>

      {/* Connection */}
      <div style={cardStyle}>
        <div className="flex items-center gap-1.5 mb-2">
          <Link2 size={12} style={{ color: status.connected ? '#34d399' : 'var(--gia-muted-2)' }} />
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>Relay</span>
          <span className="ml-auto text-[10px]" style={{ color: status.connected ? '#34d399' : '#f87171' }}>
            {status.connected ? '● connected' : '○ disconnected'}
          </span>
        </div>
        <div className="flex gap-2">
          <input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="ws://192.168.1.50:8787/unimind"
            style={inputStyle}
          />
          {status.connected ? (
            <button onClick={disconnect} style={{ ...btnBase, background: 'rgba(239,68,68,0.1)', color: '#f87171' }}>
              <Plug size={12} className="inline mr-1" /> Disconnect
            </button>
          ) : (
            <button onClick={() => void connect()} disabled={busy || !url.trim()} style={{ ...btnBase, background: 'rgba(139,92,246,0.12)', color: '#a78bfa' }}>
              <PlugZap size={12} className="inline mr-1" /> {busy ? 'Connecting…' : 'Connect'}
            </button>
          )}
        </div>
        <p className="text-[10px] mt-2 leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
          Pairing id: <code style={{ color: '#a78bfa' }}>{status.unimindId}</code>
          <br />
          Set the <strong>same relay URL + same pairing id</strong> on the phone (GIA → Settings → Unimind) and they find each other.
        </p>
      </div>

      {/* Peers */}
      <div style={cardStyle}>
        <div className="flex items-center gap-1.5 mb-2">
          <Users size={12} style={{ color: '#8b5cf6' }} />
          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>Devices</span>
          <button onClick={refresh} className="ml-auto" style={{ background: 'none', border: 'none', color: 'var(--gia-muted-2)', cursor: 'pointer' }}>
            <RefreshCw size={12} />
          </button>
        </div>
        {status.peers.length === 0 ? (
          <p className="text-[11px]" style={{ color: 'var(--gia-muted-2)' }}>No devices online yet. Open GIA on your phone with the same pairing id.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {status.peers.map((p) => (
              <div key={p.deviceId} className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--gia-text)' }}>
                <Smartphone size={12} style={{ color: '#8b5cf6' }} />
                <span className="font-medium">{p.name || p.device}</span>
                <code style={{ color: 'var(--gia-muted-2)' }}>{p.deviceId}</code>
                <span className="ml-auto" style={{ color: p.presence === 'online' ? '#34d399' : p.presence === 'away' ? '#fbbf24' : 'var(--gia-muted-2)' }}>
                  {p.presence}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rules */}
      <div style={cardStyle}>
        <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--gia-muted)' }}>Security rules</span>
        <div className="mt-2 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--gia-text)' }}>
              <Lock size={11} style={{ color: '#fbbf24' }} /> Follow-lock
            </p>
            <p className="text-[10px] leading-relaxed mt-0.5" style={{ color: 'var(--gia-muted-2)' }}>
              When your phone says you're active on mobile and this computer sits idle, GIA locks the session.
            </p>
          </div>
          <button onClick={() => toggleFollowLock(!followLock)} style={{ ...btnBase, padding: '5px 12px', background: followLock ? 'rgba(52,211,153,0.12)' : 'rgba(113,113,122,0.12)', color: followLock ? '#34d399' : 'var(--gia-muted-2)' }}>
            {followLock ? 'On' : 'Off'}
          </button>
        </div>
        <div className="mt-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium flex items-center gap-1" style={{ color: 'var(--gia-text)' }}>
              <Unlock size={11} style={{ color: '#f87171' }} /> Remote unlock
            </p>
            <p className="text-[10px] leading-relaxed mt-0.5" style={{ color: 'var(--gia-muted-2)' }}>
              Allow the phone to unlock this computer. Off by default — turning it on means anyone holding your paired phone can unlock this machine.
            </p>
          </div>
          <button onClick={() => toggleRemoteUnlock(!remoteUnlock)} style={{ ...btnBase, padding: '5px 12px', background: remoteUnlock ? 'rgba(52,211,153,0.12)' : 'rgba(113,113,122,0.12)', color: remoteUnlock ? '#34d399' : 'var(--gia-muted-2)' }}>
            {remoteUnlock ? 'On' : 'Off'}
          </button>
        </div>
      </div>

      <p className="text-[10px] leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
        GIA can also delegate actions to the phone (send SMS, take a photo, play media…) with the <code>unimind_run</code> tool, and the phone can run
        desktop tools through the same channel.
      </p>
    </div>
  );
};
