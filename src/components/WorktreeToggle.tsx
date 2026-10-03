import React, { useCallback, useEffect, useState } from 'react';
import { GitBranch, Loader2, ShieldCheck } from 'lucide-react';
import { useGiaStore } from '../store/useGiaStore';
import { useProjectContextStore } from '../store/useProjectContextStore';
import { isGitRepo } from '../services/git/worktree';

/**
 * Per-session git isolation, in the place you already switch sessions from.
 *
 * Claude's April 2026 redesign paired worktrees-per-session with the principle
 * that "isolation must be invisible". Invisible cuts both ways: an isolation
 * feature that lives in a settings page nobody opens is indistinguishable from
 * not having it. So the control sits next to the session it belongs to, and the
 * branch name is visible once isolation is on — an invisible worktree is
 * indistinguishable from a corrupted one.
 *
 * The removal choice is deliberate. `git worktree remove` refuses a worktree
 * with uncommitted changes, which is correct: that is the user's work. So the
 * default attempt can fail, and when it does the error is shown with a separate,
 * explicit "discard changes" action rather than a silent force.
 */
export function WorktreeToggle({ sessionId }: { sessionId: string }) {
  const session = useGiaStore(s => s.sessions.find(x => x.id === sessionId));
  const enableWorktree = useGiaStore(s => s.enableWorktree);
  const disableWorktree = useGiaStore(s => s.disableWorktree);

  // The project directory, which is the repository the worktree is cut from.
  const projectPath = useProjectContextStore(s => s.entry?.path ?? null);

  const [isRepo, setIsRepo] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [offerForce, setOfferForce] = useState(false);

  const worktree = session?.worktree;

  // `null` means "not checked yet". Rendering that as "not a repository" would
  // flash the wrong answer on every mount, and would also hide the control from
  // projects whose path only arrives after the first `/init`.
  useEffect(() => {
    let cancelled = false;
    if (!projectPath) { setIsRepo(null); return; }
    (async () => {
      const ok = await isGitRepo(projectPath);
      if (!cancelled) setIsRepo(ok);
    })();
    return () => { cancelled = true; };
  }, [projectPath]);

  const onEnable = useCallback(async () => {
    if (!projectPath) return;
    setBusy(true);
    try { await enableWorktree(sessionId, projectPath); } finally { setBusy(false); }
  }, [projectPath, enableWorktree, sessionId]);

  const onDisable = useCallback(async (force?: boolean) => {
    setBusy(true);
    try {
      const ok = await disableWorktree(sessionId, { force });
      // Only clear the force offer once the worktree is actually gone. If the
      // forced removal also fails, the offer has to stay available.
      if (ok) setOfferForce(false);
    } finally { setBusy(false); }
  }, [disableWorktree, sessionId]);

  // No project, or not a repository: absence is the honest answer, so show nothing.
  if (!projectPath || isRepo !== true) return null;

  if (worktree?.path) {
    return (
      <div className="px-2 py-1" data-testid="worktree-on">
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={11} style={{ color: '#22c55e' }} />
          <span className="text-[10px] truncate" style={{ color: '#22c55e' }} title={worktree.path}>
            {worktree.branch}
          </span>
          <button
            onClick={() => onDisable(false)}
            disabled={busy}
            data-testid="worktree-remove"
            className="ml-auto text-[10px] px-1.5 py-0.5 rounded disabled:opacity-40"
            style={{ color: 'var(--gia-muted-2)' }}
            title="Remove this session's worktree"
          >
            {busy ? <Loader2 size={10} className="animate-spin" /> : 'Remove'}
          </button>
        </div>
        {worktree.error && (
          <div className="mt-1">
            <p className="text-[9px]" style={{ color: '#f59e0b' }}>{worktree.error}</p>
            {offerForce ? (
              <button
                onClick={() => onDisable(true)}
                disabled={busy}
                data-testid="worktree-force"
                className="mt-1 text-[9px] px-1.5 py-0.5 rounded disabled:opacity-40"
                style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}
              >
                Discard changes and remove
              </button>
            ) : (
              <button
                onClick={() => setOfferForce(true)}
                data-testid="worktree-offer-force"
                className="mt-1 text-[9px] underline"
                style={{ color: 'var(--gia-muted-2)' }}
              >
                This has uncommitted changes. Discard them?
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="px-2 py-1" data-testid="worktree-off">
      <button
        onClick={onEnable}
        disabled={busy}
        data-testid="worktree-enable"
        className="flex items-center gap-1.5 w-full text-[10px] px-1.5 py-1 rounded transition-colors disabled:opacity-40"
        style={{ color: 'var(--gia-muted-2)' }}
        title="Give this conversation its own git checkout, so parallel tasks stop sharing one working tree"
      >
        {busy ? <Loader2 size={10} className="animate-spin" /> : <GitBranch size={10} />}
        Isolate in a worktree
      </button>
      {worktree?.error && (
        <p className="text-[9px] px-1.5 mt-0.5" style={{ color: '#f59e0b' }}>{worktree.error}</p>
      )}
    </div>
  );
}