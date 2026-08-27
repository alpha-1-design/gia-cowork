import React, { useEffect, lazy, Suspense, useState, useRef, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Bell, X, Cpu, Download, AlertCircle, Wifi, WifiOff, ClipboardIcon } from 'lucide-react';
import { useGiaStore, Module } from './store/useGiaStore';
import { setStorageErrorHandler } from './store/idb-storage';
import { useShallow } from 'zustand/react/shallow';
import { useMemoryStore } from './store/useMemoryStore';
import { useAutonomyStore } from './store/useAutonomyStore';
import ChatModule from './modules/ChatModule';
import BuildModule from './modules/BuildModule';
import WriterModule from './modules/WriterModule';
import PlannerModule from './modules/PlannerModule';
import SettingsModule from './modules/SettingsModule';
import ErrorBoundary from './components/ErrorBoundary';
import ApiKeyInputPanel from './components/ApiKeyInputPanel';
import { SourcesPanel } from './components/SourcesPanel';
import AppNavigation from './components/AppNavigation';
import CommandPalette from './components/CommandPalette';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useNotificationStore } from './store/useNotificationStore';
import type { IncomingNotification } from './services/SmartNotificationEngine';
import type { WhatsAppIncomingMessage } from './services/WhatsAppBridgeService';
import { useProviderStore } from './store/useProviderStore';
import { logger } from './utils/logger';
import { useClipboardMonitor } from './hooks/useClipboardMonitor';
import { useAutomationBridge } from './hooks/useAutomationBridge';
import type { UpdateInfo } from './services/UpdateService';
import './styles/globals.css';

const EngineRoom = lazy(() => import('./components/EngineRoom'));
const GiaConsole = lazy(() => import('./components/GiaConsole'));
const TaskBoard = lazy(() => import('./components/TaskBoard').then(m => ({ default: m.TaskBoard })));
const NotesPanel = lazy(() => import('./components/NotesPanel').then(m => ({ default: m.NotesPanel })));
const ProfileDrawer = lazy(() => import('./components/ProfileDrawer'));
const SetupWizard = lazy(() => import('./components/SetupWizard'));

// Surface persistence failures (e.g. storage quota exceeded) to the user
// instead of failing silently and losing data. Throttled so a persistent
// failure can't flood the notification stack.
let lastStorageWarn = 0;
if (typeof window !== 'undefined') {
  setStorageErrorHandler(({ key, error }) => {
    logger.error('[storage] persistence failure:', key, error);
    const now = Date.now();
    if (now - lastStorageWarn > 10000) {
      lastStorageWarn = now;
      useGiaStore.getState().addNotification(
        '⚠️ Storage unavailable — recent changes may not be saved. Free up device space and reload.',
      );
    }
  });
}

const AnalystModule = lazy(() => import('./modules/AnalystModule'));
const ExamModule = lazy(() => import('./modules/ExamModule'));
const AutonomyModule = lazy(() => import('./modules/AutonomyModule'));
const AgentsModule = lazy(() => import('./modules/AgentsModule'));

async function checkProviderHealth(provider: string, apiKey: string, model: string): Promise<boolean> {
  try {
    const { providerRegistry } = await import('./services/ProviderRegistry');
    const baseUrl = providerRegistry.getBaseUrl(provider);
    if (!baseUrl) return false;
    if (provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(10000),
      });
      return res.status === 200 || res.status === 400;
    }
    if (provider === 'gemini') {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}?key=${apiKey}`, { signal: AbortSignal.timeout(10000) });
      return res.ok;
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    return res.ok;
  } catch (e) { logger.warn('[App] Provider health check failed:', e); return false; }
}

const ModuleView: React.FC = () => {
  const currentModule = useGiaStore(s => s.currentModule);
  const Fallback = () => (
    <div className="flex items-center justify-center h-full">
      <div className="flex flex-col items-center gap-2">
        <div className="w-4 h-4 rounded-full border-2" style={{ borderColor: 'var(--gia-border)', borderTopColor: '#a855f7' }} />
        <span className="text-[10px]" style={{ color: 'var(--gia-muted-2)' }}>Loading...</span>
      </div>
    </div>
  );

  const components: Record<Module, React.ReactNode> = {
    chat:      <ErrorBoundary name="Chat"><ChatModule /></ErrorBoundary>,
    build:     <ErrorBoundary name="Build"><BuildModule /></ErrorBoundary>,
    exam:      <Suspense fallback={<Fallback />}><ErrorBoundary name="Exam"><ExamModule /></ErrorBoundary></Suspense>,
    analyst:   <Suspense fallback={<Fallback />}><ErrorBoundary name="Analyst"><AnalystModule /></ErrorBoundary></Suspense>,
    writer:    <ErrorBoundary name="Writer"><WriterModule /></ErrorBoundary>,
    planner:   <ErrorBoundary name="Planner"><PlannerModule /></ErrorBoundary>,
    settings:  <ErrorBoundary name="Settings"><SettingsModule /></ErrorBoundary>,
    autonomy:  <Suspense fallback={<Fallback />}><ErrorBoundary name="Autonomy"><AutonomyModule /></ErrorBoundary></Suspense>,
    agents:    <Suspense fallback={<Fallback />}><ErrorBoundary name="Agents"><AgentsModule /></ErrorBoundary></Suspense>,
  };
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={currentModule}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
        className="h-full w-full"
      >
        {components[currentModule] ?? components.chat}
      </motion.div>
    </AnimatePresence>
  );
};

const App: React.FC = () => {
  const { setModule, showTerminal, setShowTerminal, notifications, clearNotification, showConsole, consoleLogs, setShowConsole, theme, reduceMotion, addNotification, fullScreenMode } = useGiaStore(useShallow(s => ({
      setModule: s.setModule,
      showTerminal: s.showTerminal, setShowTerminal: s.setShowTerminal,
      notifications: s.notifications, clearNotification: s.clearNotification,
      showConsole: s.showConsole, consoleLogs: s.consoleLogs, setShowConsole: s.setShowConsole,
      theme: s.theme,
      reduceMotion: s.reduceMotion,
      addNotification: s.addNotification,
      fullScreenMode: s.fullScreenMode,
    })));
  const [showTaskBoard, setShowTaskBoard] = useState(false);
  const [showNotesPanel, setShowNotesPanel] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  // Desktop command palette — Ctrl/Cmd+K opens it anywhere in the app.
  useKeyboardShortcuts([
    { key: 'k', ctrl: true, handler: () => setPaletteOpen(o => !o), preventDefault: true },
  ]);
  const [showSetup, setShowSetup] = useState(false);
  const [updateNotification, setUpdateNotification] = useState<UpdateInfo | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  // Clipboard monitor — shows toast when interesting content is copied
  const { copiedText, dismissCopied, pasteCopied } = useClipboardMonitor();

  // Automation bridge — connects AutomationEngine custom events to store actions
  useAutomationBridge();

  // Deep links are handled via URL params (above) and clipboard paste detection (below).
  // No platform-specific listener needed on desktop — Tauri deep links arrive as
  // navigation events that are already covered by the URL param check.

  // Clipboard paste detection (desktop: paste gia:// links)
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text');
      if (text && text.startsWith('gia://')) {
        useGiaStore.getState().setPendingAction({
          type: 'deep-link',
          data: { url: text.replace('gia://', ''), raw: text },
        });
        useGiaStore.getState().addNotification('🔗 Pasted GIA link detected');
      }
    };
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, []);

  // URL parameter deep link detection
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const deepLink = params.get('url');
    if (deepLink) {
      const decoded = decodeURIComponent(deepLink);
      const giaMatch = decoded.match(/^web\+gian:\/\/(.+)/);
      if (giaMatch) {
        const target = decodeURIComponent(giaMatch[1]);
        useGiaStore.getState().setPendingAction({
          type: 'deep-link',
          data: { url: target, raw: decoded },
        });
        useGiaStore.getState().addNotification(`🔗 Deep link received: ${target.slice(0, 40)}...`);
        useGiaStore.getState().setModule('chat');
        window.history.replaceState(null, '', '/');
      }
    }
  }, []);

  // Theme switching
  useEffect(() => {
    const applyTheme = (mode: string) => {
      const effective = mode === 'system' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : mode;
      document.documentElement.setAttribute('data-theme', effective);
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effective === 'light' ? '#e8e8ef' : effective === 'obsidian-aurora' ? '#000000' : '#0a0a0f');
    };
    applyTheme(theme);
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const handler = () => { if (theme === 'system') applyTheme('system'); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  // Reduce motion — apply on mount and whenever the setting changes so it
  // takes effect immediately, not just after the setter that flips it runs.
  useEffect(() => {
    document.documentElement.classList.toggle('gia-reduce-motion', reduceMotion);
  }, [reduceMotion]);

  useEffect(() => {
    // Load provider definitions dynamically
    useProviderStore.getState().loadProviders().catch(e => logger.error('[App] Failed to load providers:', e));

    // Register all tool definitions into the ToolRegistry singleton
    import('./services/tools/index').then(m => m.registerAllTools());

    // Lazy-loaded service singletons — resolved in parallel, none block first paint
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let svc: Record<string, any> | null = null;
    const servicesReady = Promise.all([
      import('./services/SchedulerService').then(m => { m.default.start(); }),
      import('./services/MCPManager').then(m => m.default),
      import('./services/autonomy/ProactiveEngine').then(m => { m.proactiveEngine.start(); return m.proactiveEngine; }),
      import('./services/IdleManager').then(m => m.default),
      import('./services/SystemService').then(m => m.default),
      import('./services/GiaBrain').then(m => m.setSystemContext),
      import('./services/WakeLockService').then(m => m.default),
      import('./services/KeepaliveService').then(m => m.default),
      import('./services/MessagingBridge').then(m => m.default),
      import('./services/BackgroundRecovery').then(m => m.backgroundRecovery),
    ]).then(([, MCPManager, proactiveEngine, idleManager, SystemService, setSystemContext, wakeLockService, keepaliveService, messagingBridge, backgroundRecovery]) => {
      svc = { idleManager, SystemService, setSystemContext, wakeLockService, keepaliveService, messagingBridge, backgroundRecovery, proactiveEngine, MCPManager };
      return svc;
    });

    import('./services/GIACoreServices').then(m => m.giaCoreServices.onAppStart());

    // Track user activity for autonomy engine + idle manager
    const trackActivity = () => {
      useAutonomyStore.getState().setLastUserActivity();
      if (svc) svc.idleManager.ping();
      // Feed the activity-learning engines (adaptive scheduler + fusion engine)
      import('./services/AdaptiveScheduler').then(a => a.default.recordActivity('interaction')).catch(() => {});
      import('./services/ContextFusionEngine').then(c => c.contextFusionEngine.recordActivity('interaction')).catch(() => {});
    };
    window.addEventListener('mousedown', trackActivity);
    window.addEventListener('keydown', trackActivity);

    // Desktop intelligence spine — cross-store event bridge → activity learning
    import('./services/EventBridge').then(({ EventBridge }) => {
      const bridge = new EventBridge();
      bridge.on('*', (ev) => {
        import('./services/AdaptiveScheduler').then(a => a.default.recordActivity(ev.type)).catch(() => {});
        import('./services/ContextFusionEngine').then(c => c.contextFusionEngine.recordActivity(ev.type)).catch(() => {});
      });
      bridge.start();
    });

    // Smart notification triage — route new notifications through the engine,
    // surface desktop notifications only for what it decides is 'immediate'.
    import('./services/SmartNotificationEngine').then(({ default: smartNotif }) => {
      let lastIds = new Set(useNotificationStore.getState().notifications.map(n => n.id));
      useNotificationStore.subscribe((state) => {
        const currentIds = new Set(state.notifications.map(n => n.id));
        for (const n of state.notifications) {
          if (lastIds.has(n.id)) continue;
          const decision = smartNotif.process({
            id: n.id,
            title: n.title,
            body: n.body,
            source: n.source,
            timestamp: Date.now(),
            category: (n.category as IncomingNotification['category']) || 'unknown',
            priority: 'medium',
          });
          if (decision.action === 'immediate') {
            import('./services/DesktopNotifications').then(d => d.default.notify(n.title, { body: n.body })).catch(() => {});
          }
        }
        lastIds = currentIds;
      });
    });

    // Presence-aware autonomy — pause background work while the screen is locked.
    import('./services/PresenceService').then(({ presenceService }) => {
      let locked = false;
      const check = async () => {
        try {
          const p = await presenceService.getPresence();
          if (!p || p.lockState === 'UNKNOWN') return;
          if (p.lockState === 'LOCKED' && !locked) {
            locked = true;
            const [{ automationEngine }, { proactiveEngine }] = await Promise.all([
              import('./services/AutomationEngine'),
              import('./services/autonomy/ProactiveEngine'),
            ]);
            automationEngine.stop();
            proactiveEngine.stop();
            useGiaStore.getState().addNotification('🔒 Screen locked — paused background work');
          } else if (p.lockState === 'UNLOCKED' && locked) {
            locked = false;
            const [{ automationEngine }, { proactiveEngine }] = await Promise.all([
              import('./services/AutomationEngine'),
              import('./services/autonomy/ProactiveEngine'),
            ]);
            automationEngine.start();
            proactiveEngine.start();
          }
        } catch { /* presence polling is best-effort */ }
      };
      check();
      setInterval(check, 15000);
    });

    // Two-way WhatsApp — event-driven via Tauri sidecar.
    import('./services/WhatsAppBridgeService').then(async ({ whatsAppBridgeService }) => {
      const { whatsAppSession } = await import('./services/whatsappSession');
      const { default: GiaBrain } = await import('./services/GiaBrain');

      const notifyIncoming = async (m: WhatsAppIncomingMessage) => {
        const phone = m.from.split('@')[0];
        const label = `WhatsApp · ${m.fromName || phone}`;
        try {
          useNotificationStore.getState().addNotification({ app: 'WhatsApp', title: label, body: m.text.slice(0, 120), source: 'whatsapp', category: 'message' });
          const { default: desktopNotifs } = await import('./services/DesktopNotifications');
          desktopNotifs.notify(label, { body: m.text.slice(0, 120) });
        } catch { /* notifications are best-effort */ }
      };

      // Answer a burst with full conversation context.
      whatsAppSession.onAnswer = async (req) => {
        const phone = req.jid.split('@')[0];
        const who = req.name || phone;
        try {
          const prior = req.history
            .slice(0, -1) // drop the just-added burst; it is req.texts
            .map((t) => `${t.role === 'user' ? who : 'GIA'}: ${t.text.slice(0, 500)}`)
            .join('\n');
          const res = await GiaBrain.generate({
            prompt: `Recent conversation:\n${prior || '(none)'}\n\nNew message from ${who}:\n${req.texts.join(' | ')}`,
            systemPrompt: `You are GIA, the personal AI assistant of the person who owns this computer, chatting with them over WhatsApp. The person messaging you is ${who}. Be concise, natural, and genuinely helpful — like a capable friend, not a helpdesk. Plain text only: no markdown, no headers, no emoji spam. If they ask for something you cannot do from chat, say so briefly and offer what you CAN do.`,
            onStream: undefined,
          });
          const reply = whatsAppSession.capReply(res.text.trim());
          await whatsAppBridgeService.notify({ to: req.jid, text: reply });
          logger.log(`[WhatsApp] Replied to ${who}`);
          return reply;
        } catch (e) {
          logger.warn('[WhatsApp] Reply failed:', e);
          try {
            await whatsAppBridgeService.notify({ to: req.jid, text: 'Sorry — I hit a snag. Try again in a moment.' });
          } catch { /* best-effort */ }
          return null;
        }
      };

      whatsAppSession.onIncoming = (m) => { void notifyIncoming(m); };

      // One-time catch-up + contact names when the app starts (only if
      // the bridge is already connected). Live delivery is push.
      const catchUp = async () => {
        try {
          const status = await whatsAppBridgeService.status();
          if (!status || !status.connected) return;
          const [contactsRes, msgsRes] = await Promise.allSettled([
            whatsAppBridgeService.contacts(),
            whatsAppBridgeService.messages(whatsAppSession.getCursor()),
          ]);
          if (contactsRes.status === 'fulfilled' && contactsRes.value) {
            for (const [jid, name] of Object.entries(contactsRes.value.contacts || {})) {
              whatsAppSession.noteName(jid, String(name));
            }
          }
          if (msgsRes.status === 'fulfilled' && msgsRes.value) {
            for (const m of msgsRes.value.messages) {
              if (m.ts > whatsAppSession.getCursor()) whatsAppSession.enqueue(m);
            }
          }
        } catch { /* catch-up is best-effort */ }
      };

      try {
        const { listen } = await import('@tauri-apps/api/event');
        void listen('whatsapp://incoming', (e) => {
          const m = (e.payload as { message?: WhatsAppIncomingMessage })?.message;
          if (m) whatsAppSession.enqueue(m);
        });
        void listen('whatsapp://status', (e) => {
          const status = (e.payload as { status?: { connected?: boolean; jid?: string | null; pairing?: boolean; loggedOut?: boolean } })?.status;
          if (status?.connected) {
            logger.log(`[WhatsApp] Bridge connected (${status.jid || 'paired'}) — catching up`);
            void catchUp();
          } else if (status?.loggedOut) {
            logger.warn('[WhatsApp] Bridge logged out — re-pair via whatsapp_bridge_start');
          }
        });
      } catch (e) {
        logger.warn('[WhatsApp] event listeners unavailable:', e);
      }

      // If the bridge is already running when the app launches, catch up
      // without waiting for a status event.
      void catchUp();
    });

    // Unimind — cross-device spine. Auto-connect if a relay is configured
    // (set via unimind_connect or Settings), surface phone chat as
    // notifications, and let the follow-lock rule run.
    import('./services/unimindClient').then(async ({ unimindClient }) => {
      if (unimindClient.getRelayUrl()) void unimindClient.connect();
      unimindClient.onChat = (peer, text) => {
        try {
          useNotificationStore.getState().addNotification({ app: 'Unimind', title: `📱 ${peer.name || 'Phone'}`, body: text.slice(0, 120), source: 'whatsapp', category: 'message' });
          void import('./services/DesktopNotifications').then(({ default: desktopNotifs }) => desktopNotifs.notify(`📱 ${peer.name || 'Phone'}`, { body: text.slice(0, 120) }));
        } catch { /* best-effort */ }
      };
      unimindClient.onStatusChange = (connected) => {
        logger.log(`[Unimind] ${connected ? 'connected' : 'disconnected'}`);
      };
    });

    // Rich MCP content renderers (images, video, audio, JSON, markdown, code)
    import('./services/mcp/Renderers').then(m => { try { m.registerRichRenderers(); } catch (e) { logger.warn('[App] MCP renderers failed:', e); } });

    // Deep system embedding — monitor battery, network, and feed into GIA context
    servicesReady.then(({ SystemService, setSystemContext }) => {
      SystemService.getInfo().then(() => setSystemContext(SystemService.formattedContext));
      SystemService.startMonitoring().then(() => setSystemContext(SystemService.formattedContext));
    });

    // Connectivity monitoring
    const goOnline = () => {
      useGiaStore.getState().setConnectionStatus('online');
      useGiaStore.getState().addNotification('Back online');
    };
    const goOffline = () => {
      useGiaStore.getState().setConnectionStatus('offline');
      useGiaStore.getState().setProviderConnected(false);
      useGiaStore.getState().addNotification('No internet connection');
    };
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    useGiaStore.getState().setConnectionStatus(navigator.onLine ? 'online' : 'offline');

    // SmartNotification digest — deliver batched (non-urgent) notifications as
    // a summary every 5 minutes and whenever connectivity returns.
    const flushOnOnline = () => useNotificationStore.getState().flushDigests();
    const digestTimer = setInterval(flushOnOnline, 5 * 60 * 1000);
    window.addEventListener('online', flushOnOnline);

    // Offline queue — when connectivity returns, replay any tool calls that
    // were queued while offline (web lookups etc.) and log their results.
    import('./services/OfflineQueue').then(({ attachAutoFlush }) => {
      attachAutoFlush(async (toolId, args) => {
        const { default: GiaTools } = await import('./services/GiaTools');
        const tool = GiaTools.getTool(toolId);
        if (!tool) throw new Error(`Unknown tool: ${toolId}`);
        const res = await tool.execute(args as Record<string, unknown>);
        if (!res?.success) throw new Error((res as { error?: string })?.error || 'Tool replay failed');
        useGiaStore.getState().addConsoleLog({ type: 'tool', content: `[OfflineQueue] Replayed ${toolId} — ${res.content.slice(0, 300)}` });
        return res;
      });
    });

    // Provider health check — ping the active provider to verify connectivity
    const checkProvider = async () => {
      const { providers, activeProvider } = useProviderStore.getState();
      const cfg = providers[activeProvider];
      if (!cfg?.apiKey || !navigator.onLine) {
        useGiaStore.getState().setProviderConnected(false);
        return;
      }
      checkProviderHealth(activeProvider, cfg.apiKey, cfg.model)
        .then(ok => useGiaStore.getState().setProviderConnected(ok))
        .catch(e => { logger.warn('[App] Provider health check network error:', e); useGiaStore.getState().setProviderConnected(false); });
    };
    setTimeout(checkProvider, 3000);

    const t1 = setTimeout(() => useMemoryStore.getState().compactMemories(), 1000);
    const t2 = setTimeout(() => useGiaStore.getState().hibernateSessions(), 2000);

    // Check for app updates on startup (only if not dismissed)
    if (!updateDismissed) {
      setTimeout(async () => {
        try {
          const { updateService } = await import('./services/UpdateService');
          const info = await updateService.checkForUpdate();
          if (info) setUpdateNotification(info);
        } catch { /* ignore */ }
      }, 4000);
    }

    // Long-running mode: wake lock + keepalive + idle model unload + messaging polling + fast autonomy
    const cleanupFns: (() => void)[] = [];
    servicesReady.then(({ wakeLockService, keepaliveService, idleManager, proactiveEngine, messagingBridge }) => {
      const startLongRunning = async () => {
        if (!useGiaStore.getState().longRunningMode) return;
        await wakeLockService.start();
        await keepaliveService.start();
        idleManager.start(useGiaStore.getState().autoModelUnload ? 10 * 60 * 1000 : 30 * 60 * 1000);
        proactiveEngine.restartWithFastInterval();
        if (messagingBridge.isConnected('telegram')) {
          messagingBridge.startPolling();
        }
      };
      const stopLongRunning = async () => {
        await wakeLockService.stop();
        await keepaliveService.stop();
        idleManager.stop();
      };
      const unsubUnload = idleManager.onIdleTimeout(async () => {
        if (!useGiaStore.getState().autoModelUnload) return;
        logger.log('[IdleManager] Unloading idle models…');
        try { const { default: llm } = await import('./services/LocalLLMService'); await llm.unloadModel(); } catch { /* noop */ }
        try { const { default: whisper } = await import('./services/WhisperService'); whisper.unload(); } catch { /* noop */ }
      });
      const unsubActive = idleManager.onActiveAgain(() => {
        logger.log('[IdleManager] User active — models will reload on next use');
      });
      startLongRunning();
      const unsubLongRunning = useGiaStore.subscribe((s) => {
        if (s.longRunningMode) startLongRunning();
        else stopLongRunning();
      });

      // Configure SW polling for Telegram
      if (messagingBridge.isConnected('telegram')) {
        messagingBridge.configureSWPolling();
      }

      // Messaging bridge — process incoming Telegram messages via GiaBrain
      const unsubMessage = messagingBridge.onMessage(async (incoming: { isGroup: boolean; chatTitle: string; from: string; text: string; channel: string; chatId: string }) => {
        const ctx = incoming.isGroup ? `group "${incoming.chatTitle}"` : 'DM';
        logger.log(`[Messaging] ${ctx} from ${incoming.from}: ${incoming.text.slice(0, 80)}`);
        try {
          const { default: GiaBrain } = await import('./services/GiaBrain');
          const systemPrompt = incoming.isGroup
            ? `You are GIA, an AI assistant in the Telegram group "${incoming.chatTitle}". ${incoming.from} is speaking to you. Be helpful, concise, and natural. Address the whole group unless the message is directed at you personally. Keep responses brief — this is a group chat.`
            : `You are GIA, chatting with ${incoming.from} on Telegram. Be concise and natural. Respond conversationally.`;
          const res = await GiaBrain.generate({
            prompt: incoming.text,
            systemPrompt,
            onStream: undefined,
          });
          const reply = res.text;
          await messagingBridge.sendMessage({
            channel: incoming.channel,
            to: incoming.chatId,
            text: reply,
          });
          logger.log(`[Messaging] Replied to ${incoming.from} in ${ctx}`);
        } catch (e) {
          logger.error('[Messaging] Failed to process message:', e);
          await messagingBridge.sendMessage({
            channel: incoming.channel,
            to: incoming.chatId,
            text: 'Sorry, I hit an error. Try again in a moment.',
          }).catch(() => {});
        }
      });

      cleanupFns.push(
        () => { unsubUnload(); unsubActive(); unsubLongRunning(); unsubMessage(); messagingBridge.stopPolling(); messagingBridge.stopSWPolling(); },
      );
    });

    // App lifecycle — persist + recover on resume
    servicesReady.then(s => s.backgroundRecovery.recover());
    const visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        servicesReady.then(s => s.backgroundRecovery.recover());
        logger.log('[App] Window focused — checking for interrupted tasks');
      }
    };
    document.addEventListener('visibilitychange', visibilityHandler);

    return () => {
      clearTimeout(t1); clearTimeout(t2);
      clearInterval(digestTimer);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
      window.removeEventListener('online', flushOnOnline);
      window.removeEventListener('mousedown', trackActivity);
      window.removeEventListener('keydown', trackActivity);
      document.removeEventListener('visibilitychange', visibilityHandler);
      if (svc) { svc.MCPManager.shutdown(); svc.SystemService.stopMonitoring(); svc.proactiveEngine.stop(); }
      for (const fn of cleanupFns) fn();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (notifications.length === 0) return;
    const latest = notifications[0];
    const timeout = setTimeout(() => clearNotification(latest.id), 5000);
    return () => clearTimeout(timeout);
  }, [notifications, clearNotification]);

  return (
    <div
      className="flex flex-col h-full overflow-hidden relative"
      style={{ background: 'var(--gia-bg)' }}
    >
      <Suspense fallback={null}>
        <ProfileDrawer />
      </Suspense>
      {/* Global Notifications */}
      <div className="fixed top-16 left-0 right-0 z-[60] px-4 pointer-events-none space-y-2">
        <AnimatePresence>
          {notifications.map((n) => {
            const msg = n.message;
            const iconMap: [RegExp, React.ReactNode, string][] = [
              [/model|switch|provider|connected/i, <Cpu size={14} />, '#a855f7'],
              [/brain|memory|export|import/i, <Download size={14} />, '#8b5cf6'],
              [/error|fail|blocked/i, <AlertCircle size={14} />, '#f87171'],
              [/online|back online/i, <Wifi size={14} />, '#34d399'],
              [/offline|no internet/i, <WifiOff size={14} />, '#71717a'],
              [/notification|listen|voice/i, <Bell size={14} />, '#ec4899'],
            ];
            const match = iconMap.find(([re]) => re.test(msg));
            const icon = match ? match[1] : <Bell size={14} />;
            const color = match ? match[2] : '#34d399';
            return (
              <motion.div
                key={n.id}
                initial={{ opacity: 0, x: 20, scale: 0.95 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: -20, scale: 0.95 }}
                className="gia-card p-3.5 flex items-start gap-3 pointer-events-auto shadow-2xl bg-zinc-900/95 backdrop-blur-xl border-zinc-800"
              >
                <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: `${color}22` }}>
                  <span style={{ color }}>{icon}</span>
                </div>
                <div className="flex-1 pt-0.5">
                  <p className="text-[13px] font-medium text-zinc-100 leading-tight">{msg}</p>
                  <p className="text-[9px] text-zinc-500 mt-1 uppercase tracking-wider" style={{ color }}>Just now</p>
                </div>
                <button onClick={() => clearNotification(n.id)} className="text-zinc-600 hover:text-zinc-400 p-1">
                  <X size={14} />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>

{/* Header */}
       {!fullScreenMode && <AppNavigation />}

       {/* Module content */}
       <main className="flex-1 overflow-hidden relative z-10">
        <ModuleView />
      </main>

      {/* Clipboard toast */}
      <AnimatePresence>
        {copiedText && (
          <motion.div
            initial={{ opacity: 0, y: 40, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            className="fixed bottom-24 left-4 right-4 z-50 max-w-md mx-auto"
          >
            <div
              className="flex items-center gap-3 px-4 py-3 rounded-2xl shadow-2xl"
              style={{
                background: 'rgba(20,20,30,0.95)',
                border: '1px solid rgba(168,85,247,0.2)',
                backdropFilter: 'blur(20px)',
              }}
            >
              <ClipboardIcon size={16} className="text-violet-400 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-[10px] font-medium text-zinc-400">Copied to clipboard</p>
                <p className="text-xs text-zinc-200 truncate">{copiedText.slice(0, 100)}</p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={pasteCopied}
                  className="text-[10px] font-semibold px-3 py-1.5 rounded-xl transition-all"
                  style={{ background: 'rgba(168,85,247,0.2)', color: '#a855f7' }}
                >
                  Ask GIA
                </button>
                <button
                  onClick={dismissCopied}
                  className="w-6 h-6 rounded-lg flex items-center justify-center text-zinc-500 hover:text-zinc-300"
                >
                  <X size={12} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Update notification slide-up */}
      <AnimatePresence>
        {updateNotification && (
          <motion.div
            initial={{ opacity: 0, y: 60, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 40, scale: 0.95 }}
            transition={{ duration: 0.35, ease: [0.4, 0, 0.2, 1] }}
            className="fixed bottom-24 left-4 right-4 z-50 max-w-md mx-auto"
          >
            <div
              className="flex items-start gap-3 px-4 py-4 rounded-2xl shadow-2xl"
              style={{
                background: 'rgba(15, 15, 22, 0.98)',
                border: '1px solid rgba(52,211,153,0.3)',
                backdropFilter: 'blur(24px)',
                WebkitBackdropFilter: 'blur(24px)',
                boxShadow: '0 20px 60px rgba(0,0,0,0.4), 0 0 0 1px rgba(52,211,153,0.1), inset 0 1px 0 rgba(52,211,153,0.08)',
              }}
            >
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, rgba(52,211,153,0.2), rgba(16,185,129,0.1))', border: '1px solid rgba(52,211,153,0.25)' }}>
                <Download size={20} style={{ color: '#34d399' }} />
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <p className="text-sm font-semibold" style={{ color: '#e5e7eb' }}>Update Available</p>
                <p className="text-xs mt-1" style={{ color: 'var(--gia-muted)' }}>
                  v{updateNotification.version} · {updateNotification.size ? (updateNotification.size / (1024*1024)).toFixed(1) + ' MB' : 'Download'}
                </p>
                <p className="text-[10px] mt-2" style={{ color: 'var(--gia-muted-2)' }}>
                  {updateNotification.releaseName}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  onClick={() => { setModule('settings'); setUpdateNotification(null); }}
                  className="px-3.5 py-1.5 rounded-xl text-[10px] font-semibold whitespace-nowrap transition-all"
                  style={{ background: 'linear-gradient(135deg, rgba(52,211,153,0.2), rgba(16,185,129,0.1))', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)' }}
                >
                  Update
                </button>
                <button
                  onClick={() => { setUpdateNotification(null); setUpdateDismissed(true); }}
                  className="w-8 h-8 rounded-xl flex items-center justify-center text-zinc-600 hover:text-zinc-400 transition-all"
                  style={{ background: 'rgba(255,255,255,0.03)' }}
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Engine Room overlay */}
      <AnimatePresence>
        {showTerminal && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50"
          >
            <EngineRoom />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showConsole && (
          <GiaConsole
            logs={consoleLogs}
            isVisible={showConsole}
            onClose={() => setShowConsole(false)}
          />
        )}
      </AnimatePresence>

      {showTaskBoard && (
        <div className="fixed inset-0 z-[150] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowTaskBoard(false)}>
          <div className="relative rounded-2xl w-full max-w-4xl h-[80vh] overflow-hidden shadow-2xl" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowTaskBoard(false)}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-lg hover:bg-black/10 transition-colors"
              style={{ color: 'var(--gia-muted)' }}
              aria-label="Close task board"
            >
              <X size={16} />
            </button>
            <TaskBoard />
          </div>
        </div>
      )}
      {showNotesPanel && (
        <div className="fixed inset-0 z-[150] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setShowNotesPanel(false)}>
          <div className="relative rounded-2xl w-full max-w-2xl h-[80vh] overflow-hidden shadow-2xl" style={{ background: 'var(--gia-surface)', border: '1px solid var(--gia-border)' }} onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => setShowNotesPanel(false)}
              className="absolute top-2 right-2 z-10 p-1.5 rounded-lg hover:bg-black/10 transition-colors"
              style={{ color: 'var(--gia-muted)' }}
              aria-label="Close notes"
            >
              <X size={16} />
            </button>
            <NotesPanel />
          </div>
        </div>
      )}

      <AnimatePresence>
        {showSetup && (
          <motion.div
            key="setup-wizard"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-[200] w-full h-[100dvh] bg-[var(--gia-bg)] flex flex-col overflow-y-auto"
          >
            <SetupWizard onClose={() => setShowSetup(false)} onComplete={() => setShowSetup(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      <SourcesPanel />
      <ApiKeyInputPanel />
      <CommandPalette
        isOpen={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={(action) => {
          if (action === 'task-board') setShowTaskBoard(true);
          else if (action === 'notes-panel') setShowNotesPanel(true);
        }}
      />
    </div>
  );
};

export default App;
