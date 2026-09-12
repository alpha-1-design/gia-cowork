import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Smartphone, MessageCircle, RefreshCw } from 'lucide-react';
import QRCode from 'qrcode';
import { isTauri } from '../../platform';
import { whatsAppBridgeService } from '../../services/WhatsAppBridgeService';
import { whatsAppSession } from '../../services/whatsappSession';

// Two-way WhatsApp (GIA Desktop only): a Baileys sidecar is supervised by the
// Rust backend (src-tauri/src/whatsapp_bridge.rs) and holds a real WhatsApp
// Web session. This card is the visible "connect the bridge" surface the way
// OpenClaw shows its channels: status, the pairing QR, and start/stop.

type BridgeState = 'stopped' | 'starting' | 'pairing' | 'connected' | 'loggedOut';

const whatsappGlyph = (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="#25D366">
    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
  </svg>
);

const statusMeta: Record<BridgeState, { color: string; label: string }> = {
  connected: { color: '#34d399', label: 'Connected' },
  pairing: { color: '#fbbf24', label: 'Pairing — scan the QR code below' },
  starting: { color: '#fbbf24', label: 'Starting…' },
  loggedOut: { color: '#f87171', label: 'Logged out — re-pair to reconnect' },
  stopped: { color: 'var(--gia-muted-2)', label: 'Stopped' },
};

export const WhatsAppBridgeSection: React.FC = () => {
  const tauri = isTauri();
  const [state, setState] = useState<BridgeState>('stopped');
  const [jid, setJid] = useState<string | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoRespond, setAutoRespond] = useState(whatsAppSession.isAutoRespond());
  const lastQrRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!tauri) return;
    try {
      const status = await whatsAppBridgeService.status();
      if (!status) {
        setState('stopped');
        setQrDataUrl(null);
        return;
      }
      setJid(status.jid);
      if (status.connected) {
        setState('connected');
        setQrDataUrl(null);
        return;
      }
      if (status.pairing && status.qr) {
        setState('pairing');
        if (status.qr !== lastQrRef.current) {
          lastQrRef.current = status.qr;
          QRCode.toDataURL(status.qr, { margin: 1, width: 176 })
            .then(setQrDataUrl)
            .catch(() => setQrDataUrl(null));
        }
        return;
      }
      setState('stopped');
      setQrDataUrl(null);
    } catch {
      // Bridge command rejected -> sidecar isn't running.
      setState('stopped');
      setQrDataUrl(null);
    }
  }, [tauri]);

  useEffect(() => {
    if (!tauri) return;
    let unlisten: (() => void) | undefined;
    import('@tauri-apps/api/event')
      .then(async ({ listen }) => {
        unlisten = await listen('whatsapp://status', (e) => {
          const st = (e.payload as {
            status?: { connected?: boolean; jid?: string | null; pairing?: boolean; loggedOut?: boolean };
          })?.status;
          if (!st) return;
          if (st.connected) {
            setState('connected');
            setJid(st.jid ?? null);
            setQrDataUrl(null);
          } else if (st.loggedOut) {
            setState('loggedOut');
            setQrDataUrl(null);
          } else {
            void refresh();
          }
        });
      })
      .catch(() => {});
    void refresh();
    const iv = setInterval(() => void refresh(), 3000);
    return () => {
      clearInterval(iv);
      unlisten?.();
    };
  }, [tauri, refresh]);

  const handleStart = async () => {
    if (!tauri) return;
    setBusy(true);
    setError(null);
    try {
      const res = await whatsAppBridgeService.start();
      if (!res) return;
      setState(res.alreadyRunning ? 'pairing' : 'starting');
      if (res.alreadyRunning) void refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState('stopped');
    } finally {
      setBusy(false);
    }
  };

  const handleStop = async () => {
    if (!tauri) return;
    setBusy(true);
    setError(null);
    try {
      await whatsAppBridgeService.stop();
      setState('stopped');
      setQrDataUrl(null);
      setJid(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!tauri) {
    return (
      <div className="p-4 rounded-xl" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}>
        <div className="flex items-center gap-2">
          {whatsappGlyph}
          <span className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>WhatsApp (Two-Way Bridge)</span>
        </div>
        <p className="text-[10px] mt-2 leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
          The two-way WhatsApp bridge is a GIA Desktop feature — it links a real WhatsApp account as a linked device and lets GIA answer your messages. In the desktop app you'll find this card under Connections with a scan-to-pair QR code.
        </p>
      </div>
    );
  }

  const meta = statusMeta[state];
  const showing = state as BridgeState;

  return (
    <div className="p-4 rounded-xl" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}>
      <div className="flex items-center gap-2 mb-1">
        {whatsappGlyph}
        <span className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>WhatsApp (Two-Way Bridge)</span>
      </div>
      <p className="text-[10px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
        Link a real WhatsApp account as a <em>linked device</em> — GIA then reads your messages and replies on your behalf (OpenClaw-style two-way chat). Auto-respond is on by default and can be toggled below.
      </p>

      <div className="mt-3 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full shrink-0" style={{ background: meta.color }} />
        <span className="text-[10px] font-medium" style={{ color: meta.color }}>{meta.label}</span>
        {jid && <span className="text-[9px] font-mono" style={{ color: 'var(--gia-muted-2)' }}>{jid}</span>}
      </div>

      {showing === 'pairing' && qrDataUrl && (
        <div className="mt-3 flex flex-col items-center gap-2">
          <img
            src={qrDataUrl}
            alt="WhatsApp pairing QR"
            width={176}
            height={176}
            className="rounded-lg"
            style={{ background: '#ffffff', padding: 8, imageRendering: 'pixelated' }}
          />
          <div className="text-[9px] leading-relaxed w-full" style={{ color: 'var(--gia-muted)' }}>
            <p className="mb-1">On the account you want GIA to use:</p>
            <ol className="pl-4 space-y-0.5" style={{ listStyle: 'decimal' }}>
              <li>Open <strong>WhatsApp</strong> → <strong>Settings</strong> → <strong>Linked devices</strong>.</li>
              <li>Tap <strong>Link a device</strong>.</li>
              <li>Scan this code with your phone.</li>
            </ol>
            <p className="mt-1.5 text-[8px]" style={{ color: 'var(--gia-muted-2)' }}>
              This QR refreshes as needed — it usually stays valid for about a minute. If it expires, keep GIA running and a fresh one appears automatically.
            </p>
          </div>
        </div>
      )}

      {showing === 'connected' && (
        <label className="mt-3 flex items-center gap-2 cursor-pointer select-none" style={{ color: 'var(--gia-muted)' }}>
          <input
            type="checkbox"
            checked={autoRespond}
            onChange={(e) => {
              whatsAppSession.setAutoRespond(e.target.checked);
              setAutoRespond(e.target.checked);
            }}
            className="accent-emerald-400"
          />
          <MessageCircle size={11} className="shrink-0" />
          <span className="text-[10px]">Auto-respond — GIA answers every incoming message (off = notifications only)</span>
        </label>
      )}

      {showing === 'loggedOut' && (
        <p className="mt-3 text-[9px] leading-relaxed" style={{ color: 'var(--gia-muted)' }}>
          The WhatsApp session was logged out on the device side. Tap <strong>Stop</strong>, then <strong>Start</strong> again to show a fresh pairing QR.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        {(showing === 'stopped' || showing === 'loggedOut') ? (
          <button
            onClick={handleStart}
            disabled={busy}
            className="flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg transition-all tap-feedback disabled:opacity-50"
            style={{ background: 'rgba(37,211,102,0.15)', color: '#34d399' }}
          >
            <Smartphone size={11} />
            {busy ? 'Starting…' : 'Start bridge'}
          </button>
        ) : (
          <button
            onClick={handleStop}
            disabled={busy}
            className="flex items-center gap-1.5 text-[10px] px-3 py-1.5 rounded-lg transition-all tap-feedback disabled:opacity-50"
            style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}
          >
            <RefreshCw size={11} />
            Stop
          </button>
        )}
        {(showing === 'starting' || showing === 'pairing') && (
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-1.5 text-[10px] px-2.5 py-1.5 rounded-lg"
            style={{ background: 'rgba(255,255,255,0.04)', color: 'var(--gia-muted)' }}
          >
            <RefreshCw size={10} /> Refresh
          </button>
        )}
      </div>

      {error && (
        <p className="mt-2 text-[9px] leading-relaxed" style={{ color: '#f87171' }}>
          {error}
        </p>
      )}

      <p className="mt-3 text-[8px] leading-relaxed" style={{ color: 'var(--gia-muted-2)' }}>
        Uses the unofficial WhatsApp Web client (Baileys). Prefer a secondary number — automating a primary account can be restricted by WhatsApp. Sending with escalation (text late → real call) is available to the agent via the <span className="font-mono">whatsapp_notify</span> tool.
      </p>
    </div>
  );
};