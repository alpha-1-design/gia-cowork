import React, { useCallback, useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Camera, RefreshCw, Check, SwitchCamera, Loader2, ImageIcon } from 'lucide-react';

interface CameraCaptureModalProps {
  open: boolean;
  onClose: () => void;
  onCapture: (dataUrl: string, name: string) => void;
}

/**
 * CameraCaptureModal — actually opens the laptop / desktop webcam via
 * getUserMedia (the old "Camera" button just opened the file picker, so on a
 * PC the webcam never turned on). Shows a live preview, capture-to-snapshot,
 * camera flip where available, and always releases the tracks on close so the
 * mic/camera light goes out immediately.
 */
export const CameraCaptureModal: React.FC<CameraCaptureModalProps> = ({ open, onClose, onCapture }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [streamReady, setStreamReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [facing, setFacing] = useState<'user' | 'environment'>('environment');
  const [canFlip, setCanFlip] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    setStreamReady(false);
  }, []);

  const startCamera = useCallback(async () => {
    setError(null);
    setStarting(true);
    setSnapshot(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      stopStream();
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => { /* autoplay muted */ });
      }
      // Detect whether there is a second camera to flip between.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        setCanFlip(devices.filter(d => d.kind === 'videoinput').length > 1);
      } catch { setCanFlip(false); }
      setStreamReady(true);
    } catch (e) {
      setStreamReady(false);
      setError(
        e instanceof DOMException && (e.name === 'NotAllowedError' || e.name === 'SecurityError')
          ? 'Camera permission denied — allow camera access for GIA to capture a photo.'
          : `Could not open the camera: ${e instanceof Error ? e.message : 'unknown error'}`,
      );
    } finally {
      setStarting(false);
    }
  }, [facing, stopStream]);

  useEffect(() => {
    if (open) {
      startCamera();
      return () => stopStream();
    }
    return undefined;
  }, [open, startCamera, stopStream]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const maxW = 1280;
    const scale = Math.min(1, maxW / video.videoWidth);
    const w = Math.round(video.videoWidth * scale);
    const h = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, w, h);
    setSnapshot(canvas.toDataURL('image/jpeg', 0.85));
  }, []);

  const confirmCapture = useCallback(() => {
    if (!snapshot) return;
    onCapture(snapshot, `webcam-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jpg`);
  }, [snapshot, onCapture]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[200] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18, ease: [0.23, 1, 0.32, 1] }}
        className="w-full max-w-xl rounded-2xl overflow-hidden"
        style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }}
      >
        <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--gia-border)' }}>
          <div className="flex items-center gap-2">
            <Camera size={14} style={{ color: '#c084fc' }} />
            <h2 className="text-sm font-semibold" style={{ color: 'var(--gia-text)' }}>Camera</h2>
          </div>
          <button
            onClick={() => { stopStream(); onClose(); }}
            className="w-8 h-8 rounded-full flex items-center justify-center transition-colors"
            style={{ background: 'var(--gia-surface-2)', color: 'var(--gia-muted)' }}
          >
            <X size={15} />
          </button>
        </div>

        <div className="p-4">
          <div className="relative aspect-video rounded-xl overflow-hidden" style={{ background: '#000', border: '1px solid var(--gia-border)' }}>
            {!snapshot && (
              <video
                ref={videoRef}
                playsInline
                muted
                autoPlay
                className="absolute inset-0 w-full h-full object-cover"
              />
            )}
            {snapshot && <img src={snapshot} alt="Captured" className="absolute inset-0 w-full h-full object-cover" />}
            {(starting || !streamReady) && !snapshot && !error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
                <Loader2 size={22} className="animate-spin" style={{ color: 'var(--gia-muted)' }} />
                <span className="text-[10px]" style={{ color: 'var(--gia-muted)' }}>Opening camera…</span>
              </div>
            )}
            {streamReady && !snapshot && (
              <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-1 rounded-full backdrop-blur-sm"
                style={{ background: 'rgba(6,12,20,0.55)' }}>
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[9px]" style={{ color: 'var(--gia-muted)' }}>live</span>
              </div>
            )}
          </div>

          {error && (
            <div className="mt-3 px-3 py-2 rounded-lg text-[11px] leading-snug" style={{ background: 'rgba(239,68,68,0.12)', color: '#f87171' }}>
              {error}
            </div>
          )}

          <div className="flex items-center justify-center gap-3 mt-4">
            {canFlip && !snapshot && (
              <button
                onClick={() => { stopStream(); setFacing(f => (f === 'environment' ? 'user' : 'environment')); }}
                className="w-10 h-10 rounded-full flex items-center justify-center transition-colors"
                style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
                title="Flip camera"
              >
                <SwitchCamera size={16} />
              </button>
            )}

            {snapshot ? (
              <>
                <button
                  onClick={() => setSnapshot(null)}
                  className="w-12 h-12 rounded-full flex items-center justify-center transition-colors"
                  style={{ background: 'var(--gia-surface-2)', border: '1px solid var(--gia-border)', color: 'var(--gia-muted)' }}
                  title="Retake"
                >
                  <RefreshCw size={17} />
                </button>
                <button
                  onClick={confirmCapture}
                  className="w-12 h-12 rounded-full flex items-center justify-center transition-colors"
                  style={{ background: 'rgba(52,211,153,0.18)', border: '1px solid rgba(52,211,153,0.4)', color: '#34d399' }}
                  title="Use this photo"
                >
                  <Check size={20} />
                </button>
              </>
            ) : (
              <button
                onClick={captureFrame}
                disabled={!streamReady}
                className="w-14 h-14 rounded-full flex items-center justify-center transition-all disabled:opacity-40"
                style={{ background: '#fff', border: '4px solid #0b0f16', color: '#0b0f16', boxShadow: '0 0 0 2px var(--gia-border), 0 0 22px rgba(52,211,153,0.25)' }}
                title="Capture"
              >
                <Camera size={20} />
              </button>
            )}
          </div>
        </div>

        <div className="px-4 py-2.5 flex items-center justify-center gap-1.5" style={{ borderTop: '1px solid var(--gia-border)' }}>
          <ImageIcon size={11} style={{ color: 'var(--gia-muted-2)' }} />
          <span className="text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>
            {snapshot ? 'Tap the check to attach the photo, or retake.' : 'Only used while this dialog is open — the camera turns off when you close it.'}
          </span>
        </div>
      </motion.div>
    </div>
  );
};

export default CameraCaptureModal;