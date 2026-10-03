/**
 * Auth walls — recognising when a page needs a login, instead of failing oddly.
 *
 * The failure this prevents is specific and ugly: the agent opens a page, gets
 * bounced to a sign-in form, tries again, gets bounced again, and eventually
 * reports "I can't access this site" when the site was perfectly reachable and
 * the only thing missing was a credential the agent was never going to have.
 *
 * Detecting the wall lets us say what is actually true — "this page is behind a
 * login, here is what you can do instead" — which is useful to the person
 * reading it. Silence here costs the user a confused agent and a support
 * question.
 *
 * Pure and conservative. A false positive ("this looks like a login page") is
 * cheap: the model just tries another way. A false negative is what we are
 * avoiding, so the signals are broad and the conclusion is hedged.
 */

export interface AuthWall {
  /** True when this looks like a sign-in interstitial rather than real content. */
  detected: boolean;
  /** 'strong' — a form that is clearly a credential prompt. */
  confidence: 'strong' | 'weak';
  /** What kind of wall it is. */
  kind: 'login' | 'consent' | 'paywall' | 'rate-limit' | 'captcha' | 'geo';
  reason: string;
}

const LOGIN_PATH = /\/(login|signin|sign-in|log-in|session|auth|authenticate|sso|account\/login)(?:\/|$|\?)/i;
const LOGIN_HOST = /\.(accounts|auth|login|id|sso)\./i;

const LOGIN_TEXT = /\b(sign in|log ?in|log on|signin|login)\b/i;
const CREDENTIAL_FIELD = /type\s*=\s*["']?password/i;
const CONSENT_TEXT = /\b(accept (all|the) cookies|cookie (settings|preferences)|consent|choose what you.{0,20}(allow|agree)|personalise|privacy preferences)\b/i;
const PAYWALL_TEXT = /\b(subscribe (now|to|today)|start (your )?(free )?trial|premium content|this (article|content) is for subscribers|become a member)\b/i;
const CAPTCHA_TEXT = /\b(are you (a )?(human|robot)|verify you are human|unusual traffic|checking your browser|captcha|press and hold)\b/i;
const GEO_TEXT = /\b(not available in (your|country|region)|unavailable in your|blocked in your country|content (is )?not available)\b/i;
const RATELIMIT_TEXT = /\b(rate limit|too many requests|slow down|temporarily blocked)\b/i;

/** Strip scripts/styles so their contents cannot masquerade as page text. */
function visibleText(doc: Document): string {
  const root = doc.body || doc.documentElement;
  if (!root) return '';
  const clone = root.cloneNode(true) as Element;
  clone.querySelectorAll('script, style, noscript, template').forEach(n => n.remove());
  const anyEl = clone as unknown as { innerText?: string; textContent?: string | null };
  return (anyEl.innerText ?? anyEl.textContent ?? '').replace(/\s+/g, ' ').slice(0, 4000);
}

export function detectAuthWall(doc: Document | null, url: string): AuthWall {
  if (!doc) {
    return { detected: false, confidence: 'weak', kind: 'login', reason: 'No document to inspect.' };
  }

  const text = visibleText(doc);
  const title = doc.title || '';

  // A page that is mostly a form is a wall whatever it is called. Many sites
  // use their own wording entirely, so the shape is the more reliable signal.
  const forms = doc.querySelectorAll('form');
  const passwordFields = doc.querySelectorAll('input[type="password"], input[autocomplete="current-password"]');
  const shortBody = text.replace(/\s+/g, ' ').length < 1200;

  const rateLimited = RATELIMIT_TEXT.test(text) || /too many requests/i.test(title);
  if (rateLimited) {
    return {
      detected: true, confidence: 'strong', kind: 'rate-limit',
      reason: 'The site is rate-limiting requests from this machine.',
    };
  }

  if (CAPTCHA_TEXT.test(text) || CAPTCHA_TEXT.test(title)) {
    return {
      detected: true, confidence: 'strong', kind: 'captcha',
      reason: 'The site is showing a bot check, which cannot be solved from here.',
    };
  }

  if (passwordFields.length > 0) {
    return {
      detected: true, confidence: 'strong', kind: 'login',
      reason: passwordFields.length > 1
        ? 'This page is a sign-in form asking for a username and password.'
        : 'This page is a sign-in form asking for a password.',
    };
  }

  const onLoginUrl = LOGIN_PATH.test(url) || LOGIN_HOST.test(url);
  if (onLoginUrl && (forms.length > 0 || LOGIN_TEXT.test(text) || LOGIN_TEXT.test(title))) {
    return {
      detected: true, confidence: 'strong', kind: 'login',
      reason: 'The URL is a sign-in endpoint and this page is the sign-in form.',
    };
  }

  if (CONSENT_TEXT.test(text) || CONSENT_TEXT.test(title)) {
    return {
      detected: true, confidence: 'weak', kind: 'consent',
      reason: 'This page is a cookie or privacy consent dialog that is covering the content.',
    };
  }

  if (PAYWALL_TEXT.test(text) || PAYWALL_TEXT.test(title)) {
    return {
      detected: true, confidence: 'weak', kind: 'paywall',
      reason: 'The content here is behind a subscription.',
    };
  }

  if (GEO_TEXT.test(text) || GEO_TEXT.test(title)) {
    return {
      detected: true, confidence: 'weak', kind: 'geo',
      reason: 'The site says this content is not available from this location.',
    };
  }

  // Last resort: a short page whose only control is "sign in". Weak on purpose.
  if (shortBody && forms.length > 0 && LOGIN_TEXT.test(text)) {
    return {
      detected: true, confidence: 'weak', kind: 'login',
      reason: 'This looks like a sign-in page rather than the content that was asked for.',
    };
  }

  return { detected: false, confidence: 'weak', kind: 'login', reason: '' };
}

/**
 * What to do about a wall, in words meant for the model.
 *
 * The important instruction is the negative one. The tempting failure is to
 * look for another way in — guess at an API, find a mirror, try to work around
 * the paywall. That is both useless and, for consent and paywalls, a decision
 * the user should make rather than the agent.
 */
export function authWallAdvice(wall: AuthWall): string {
  const common = 'Report this to the user in your own words and stop trying to get past it.';
  switch (wall.kind) {
    case 'login':
      return `${common} GIA has no credentials for this site and cannot borrow the ones in your browser. ` +
        'Say what you were trying to reach and offer to have the user open it in their own browser, or ask them to paste the content.';
    case 'consent':
      return `${common} If the dialog itself has a visible accept button you may click it, since that is a normal user choice — but say that you did.`;
    case 'paywall':
      return `${common} Do not look for a mirror, a cache or an unofficial source.`;
    case 'captcha':
      return `${common} These exist to tell humans from software and are not meant to be solved here.`;
    case 'rate-limit':
      return 'Wait and try once, later. Do not retry immediately — retrying now makes the block longer.';
    case 'geo':
      return `${common} The site is refusing by region and there is no workaround from here.`;
    default:
      return common;
  }
}