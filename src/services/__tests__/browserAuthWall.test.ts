import { describe, it, expect } from 'vitest';
import { detectAuthWall, authWallAdvice } from '../browser/authWall';

function docFrom(html: string, title = 'Page', url = 'https://example.com/') {
  const doc = document.implementation.createHTMLDocument(title);
  doc.body.innerHTML = html;
  return detectAuthWall(doc, url);
}

describe('detectAuthWall — recognising a wall', () => {
  it('spots a sign-in form', () => {
    const wall = docFrom('<form><input type="password" name="pw"><button>Log in</button></form>', 'Sign in');
    expect(wall.detected).toBe(true);
    expect(wall.kind).toBe('login');
    expect(wall.confidence).toBe('strong');
  });

  it('does not fire on an ordinary article', () => {
    // A false positive is cheap; a false negative is the expensive one. This
    // guards against tuning the detector into uselessness.
    const wall = docFrom('<article><h1>How browsers work</h1><p>Lots of real prose about rendering engines.</p></article>');
    expect(wall.detected).toBe(false);
  });

  it('spots a paywall', () => {
    const wall = docFrom('<p>Subscribe now to keep reading this article.</p>');
    expect(wall.kind).toBe('paywall');
  });

  it('spots a bot check', () => {
    const wall = docFrom('<p>Verify you are human before continuing.</p>', 'Just a moment');
    expect(wall.kind).toBe('captcha');
  });

  it('spots rate limiting', () => {
    const wall = docFrom('<p>Too many requests. Please slow down.</p>');
    expect(wall.kind).toBe('rate-limit');
  });

  it('spots a geo block', () => {
    const wall = docFrom('<p>This content is not available in your country.</p>');
    expect(wall.kind).toBe('geo');
  });

  it('spots a consent dialog', () => {
    const wall = docFrom('<p>We use cookies. Accept all cookies to continue.</p>');
    expect(wall.kind).toBe('consent');
  });

  it('is not fooled by a script that merely mentions signing in', () => {
    // Text inside a script tag is never visible to a person, so it must not
    // convince the detector that this is a login page.
    const wall = docFrom('<script>var msg = "please sign in";</script><article><p>Real content here.</p></article>');
    expect(wall.detected).toBe(false);
  });

  it('uses the URL when the page itself says nothing', () => {
    const wall = docFrom('<form><input name="q"></form>', 'Account', 'https://example.com/account/login');
    expect(wall.detected).toBe(true);
    expect(wall.kind).toBe('login');
  });

  it('copes with no document at all', () => {
    expect(detectAuthWall(null, 'https://example.com/').detected).toBe(false);
  });
});

describe('authWallAdvice — what to actually do', () => {
  it('tells the model to stop and hand a login back to the user', () => {
    const advice = authWallAdvice({ detected: true, confidence: 'strong', kind: 'login', reason: '' });
    expect(advice).toMatch(/credentials/i);
    expect(advice).toMatch(/own browser|paste/i);
  });

  it('forbids working around a paywall', () => {
    expect(authWallAdvice({ detected: true, confidence: 'weak', kind: 'paywall', reason: '' }))
      .toMatch(/mirror|cache/i);
  });

  it('tells the model not to hammer a rate limit', () => {
    expect(authWallAdvice({ detected: true, confidence: 'strong', kind: 'rate-limit', reason: '' }))
      .toMatch(/Do not retry immediately/i);
  });

  it('permits clicking a consent accept button, but says so', () => {
    expect(authWallAdvice({ detected: true, confidence: 'weak', kind: 'consent', reason: '' }))
      .toMatch(/say that you did/i);
  });
});