import { useState, useRef, useCallback } from 'react';
import { useGiaStore, type MessageNode } from '../store/useGiaStore';

export function useChatMessages() {
  const [undoMsg, setUndoMsg] = useState<{ id: string; sessionId: string; backup: MessageNode[] } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showBranchView, setShowBranchView] = useState(false);

  const handleDeleteWithUndo = useCallback((msgId: string) => {
    const state = useGiaStore.getState();
    if (!state.activeSessionId) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    const msgs = state.getActiveSession()?.messages ?? [];
    const backup = [...msgs];
    // Remove the whole subtree. A message's answer belongs to it; deleting the
    // question while leaving the answer behind is how a thread ends up with an
    // orphaned assistant turn.
    state.deleteMessage(state.activeSessionId, msgId);
    setUndoMsg({ id: msgId, sessionId: state.activeSessionId, backup });
    undoTimeoutRef.current = setTimeout(() => {
      setUndoMsg(null);
    }, 5000);
  }, []);

  const handleUndoDelete = useCallback(() => {
    if (!undoMsg || !undoTimeoutRef.current) return;
    clearTimeout(undoTimeoutRef.current);
    useGiaStore.setState({
      sessions: useGiaStore.getState().sessions.map(s =>
        s.id === undoMsg.sessionId
          ? { ...s, messages: undoMsg.backup as MessageNode[], updatedAt: Date.now() }
          : s
      ),
    });
    setUndoMsg(null);
    useGiaStore.getState().addNotification('Message restored');
  }, [undoMsg]);

  const handleFork = useCallback((msgId: string) => {
    const state = useGiaStore.getState();
    if (state.activeSessionId) state.forkSession(state.activeSessionId, msgId);
  }, []);

  const handleCreateBranch = useCallback((msgId: string) => {
    const state = useGiaStore.getState();
    if (state.activeSessionId) {
      state.addBranch(state.activeSessionId, msgId);
      state.addNotification('Branch created from message');
    }
  }, []);

  const handleEditResend = useCallback((msgId: string, setInput: (v: string) => void) => {
    const state = useGiaStore.getState();
    const session = state.getActiveSession();
    if (!session || !state.activeSessionId) return false;
    // The message tree is nested; looking only at the roots found nothing once
    // a turn had a parent. Read the active branch instead.
    const currMsgs = state.getBranchMessages(session.id, session.currentBranchId);
    const msgIndex = currMsgs.findIndex(m => m.id === msgId);
    if (msgIndex < 0) return false;
    if (currMsgs[msgIndex].role === 'user') {
      setInput(currMsgs[msgIndex].content);
    } else if (msgIndex > 0) {
      setInput(currMsgs[msgIndex - 1].content);
    } else {
      return false;
    }
    state.addNotification('Edit and resend');
    return true;
  }, []);

  const copyMessage = async (id: string, content: string) => {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      useGiaStore.getState().addNotification('Clipboard access denied. Use HTTPS or a supported browser.');
    }
    setCopiedId(id);
    copyTimeoutRef.current = setTimeout(() => setCopiedId(null), 2000);
  };

  const exportChat = () => {
    const state = useGiaStore.getState();
    const activeSession = state.getActiveSession();
    if (!activeSession) return;
    const text = activeSession.messages.map(m => `[${m.message.role.toUpperCase()}]\n${m.message.content}`).join('\n\n---\n\n');
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${activeSession.title}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  };

  return {
    undoMsg, setUndoMsg, copiedId, setCopiedId,
    undoTimeoutRef, copyTimeoutRef,
    handleDeleteWithUndo, handleUndoDelete,
    handleFork, handleEditResend, handleCreateBranch,
    copyMessage, exportChat,
    showBranchView, setShowBranchView,
  };
}
