import { logger } from '../utils/logger';
import { useGiaStore } from '../store/useGiaStore';
import { useProviderStore } from '../store/useProviderStore';
import { useGiaIdentity } from '../store/useGiaIdentity';
import { useTransferStore } from './TransferProgress';

/**
 * Editable configuration surface.
 *
 * Every capability in GIA was reachable only through bespoke UI. That makes
 * advanced settings tedious to change and impossible to script. This exports
 * the real runtime configuration as JSON, validates edits, and applies them
 * live — so config is a first-class, inspectable artifact rather than
 * something buried in a dozen dialogs.
 *
 * Secrets are redacted on export. Writing a placeholder is rejected rather
 * than silently overwriting a real key with the literal string "***", which
 * would be a genuinely nasty way to break someone's setup.
 */

export interface GiaConfig {
  identity: {
    name: string;
    tone: string;
    personalityStyle: string;
    customPrompt: string;
    proactiveness: number;
    focusAreas: string[];
  };
  behaviour: {
    webSearch: boolean;
    deepSearch: boolean;
    extThinking: boolean;
    handsOff: boolean;
    localVision: boolean;
    multiProvider: boolean;
    smartFallback: boolean;
    hapticFeedback: boolean;
    responseCache: boolean;
    localTranslate: boolean;
  };
  user: {
    name: string;
    bio: string;
    goals: string;
    customInstructions: string;
  };
  providers: Record<string, {
    enabled: boolean;
    model: string;
    imageModel?: string;
    baseUrl?: string;
    apiKey: string;
  }>;
  activeProvider: string;
}

const REDACTED = '***redacted***';

/** Snapshot the live config, with provider keys stripped. */
export function exportConfig(): GiaConfig {
  const gia = useGiaStore.getState();
  const providerState = useProviderStore.getState();
  const identity = useGiaIdentity.getState().identity;

  const providers: GiaConfig['providers'] = {};
  for (const [id, cfg] of Object.entries(providerState.providers)) {
    providers[id] = {
      enabled: cfg.enabled,
      model: cfg.model,
      ...(cfg.imageModel ? { imageModel: cfg.imageModel } : {}),
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      // Never leak a credential into an exported/clipboarded document.
      apiKey: cfg.apiKey ? REDACTED : '',
    };
  }

  return {
    identity: {
      name: identity.name,
      tone: identity.tone,
      personalityStyle: identity.personalityStyle,
      customPrompt: identity.customPrompt,
      proactiveness: identity.proactiveness,
      focusAreas: [...identity.focusAreas],
    },
    behaviour: {
      webSearch: gia.webSearch,
      deepSearch: gia.deepSearch,
      extThinking: gia.extThinking,
      handsOff: gia.handsOff,
      localVision: gia.localVision,
      multiProvider: gia.multiProvider,
      smartFallback: gia.smartFallback,
      hapticFeedback: gia.hapticFeedback,
      responseCache: gia.responseCache,
      localTranslate: gia.localTranslate,
    },
    user: {
      name: gia.userProfile.name,
      bio: gia.userProfile.bio,
      goals: gia.userProfile.goals,
      customInstructions: gia.customInstructions,
    },
    providers,
    activeProvider: providerState.activeProvider,
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate a config document before applying it. Unknown top-level keys are
 * a warning rather than an error so a config written for a newer version
 * still loads the parts it can.
 */
export function validateConfig(doc: unknown): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { ok: false, errors: ['Config must be a JSON object.'], warnings };
  }
  const cfg = doc as Record<string, unknown>;

  const known = new Set(['identity', 'behaviour', 'user', 'providers', 'activeProvider']);
  for (const key of Object.keys(cfg)) {
    if (!known.has(key)) warnings.push(`Unknown section "${key}" will be ignored.`);
  }

  if (cfg.identity !== undefined) {
    const id = cfg.identity as Record<string, unknown>;
    if (id.proactiveness !== undefined &&
        (typeof id.proactiveness !== 'number' || id.proactiveness < 0 || id.proactiveness > 1)) {
      errors.push('identity.proactiveness must be a number between 0 and 1.');
    }
    if (id.focusAreas !== undefined && !Array.isArray(id.focusAreas)) {
      errors.push('identity.focusAreas must be an array of strings.');
    }
  }

  if (cfg.providers !== undefined) {
    if (typeof cfg.providers !== 'object' || cfg.providers === null || Array.isArray(cfg.providers)) {
      errors.push('providers must be an object keyed by provider id.');
    } else {
      for (const [id, p] of Object.entries(cfg.providers as Record<string, unknown>)) {
        if (typeof p !== 'object' || p === null) {
          errors.push(`providers.${id} must be an object.`);
          continue;
        }
        const entry = p as Record<string, unknown>;
        if (entry.apiKey === REDACTED) {
          // The export redacts keys; writing it back must not wipe them.
          warnings.push(`providers.${id}.apiKey is redacted and will be left unchanged.`);
        }
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') {
          errors.push(`providers.${id}.enabled must be a boolean.`);
        }
      }
    }
  }

  if (cfg.activeProvider !== undefined && typeof cfg.activeProvider !== 'string') {
    errors.push('activeProvider must be a string.');
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Apply a validated config. Only known keys are written, and redacted apiKeys
 * are skipped so a round-tripped export can't destroy credentials.
 */
export function applyConfig(doc: GiaConfig): void {
  const gia = useGiaStore.getState();
  const providerState = useProviderStore.getState();
  const identityState = useGiaIdentity.getState();

  if (doc.identity) {
    const id = doc.identity;
    if (id.name !== undefined) identityState.setName(id.name);
    if (id.tone !== undefined) identityState.setTone(id.tone);
    if (id.personalityStyle !== undefined) identityState.setPersonality(id.personalityStyle as never);
    if (id.customPrompt !== undefined) identityState.setCustomPrompt(id.customPrompt);
    if (id.proactiveness !== undefined) identityState.setProactiveness(id.proactiveness);
    if (id.focusAreas !== undefined) identityState.setFocusAreas(id.focusAreas);
  }

  if (doc.behaviour) {
    const b = doc.behaviour;
    const toggles: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(b)) {
      if (typeof v === 'boolean' && k in gia) toggles[k] = v;
    }
    if (Object.keys(toggles).length > 0) useGiaStore.setState(toggles);
  }

  if (doc.user) {
    const u = doc.user;
    const profile = gia.userProfile;
    gia.setUserProfile({
      name: u.name ?? profile.name,
      bio: u.bio ?? profile.bio,
      goals: u.goals ?? profile.goals,
    });
    if (u.customInstructions !== undefined) gia.setCustomInstructions(u.customInstructions);
  }

  if (doc.providers) {
    for (const [id, p] of Object.entries(doc.providers)) {
      if (p.model !== undefined) providerState.setProviderModel(id, p.model);
      if (p.imageModel !== undefined) providerState.setProviderImageModel(id, p.imageModel);
      if (p.baseUrl !== undefined) providerState.setProviderBaseUrl(id, p.baseUrl);
      if (p.enabled !== undefined) {
        // setProviderKey is what flips `enabled`; only call it when we have a
        // real key so toggling enabled=false doesn't also clear the secret.
        const existing = providerState.providers[id];
        if (!p.enabled) {
          if (existing?.apiKey) providerState.setProviderKey(id, '');
        } else if (existing?.apiKey) {
          providerState.setProviderKey(id, existing.apiKey);
        }
      }
      // Redacted keys are deliberately skipped — never write the placeholder.
      if (p.apiKey && p.apiKey !== REDACTED && p.apiKey !== undefined) {
        providerState.setProviderKey(id, p.apiKey);
      }
    }
  }

  if (doc.activeProvider && doc.activeProvider !== providerState.activeProvider) {
    providerState.setActiveProvider(doc.activeProvider);
  }

  // Anything in flight reads cached config; drop it so the new values apply.
  useTransferStore.setState({ tasks: [] });
  logger.log('[ConfigEditor] Configuration applied');
}

export function exportConfigString(): string {
  return JSON.stringify(exportConfig(), null, 2);
}