import { describe, it, expect } from 'vitest';
import { CookieJar, splitSetCookie } from '../browser/cookies';

describe('splitSetCookie', () => {
  it('separates cookies folded into one header', () => {
    expect(splitSetCookie('a=1; Path=/, b=2; Path=/')).toEqual(['a=1; Path=/', 'b=2; Path=/']);
  });

  it('does not split inside an Expires date', () => {
    // The comma in "Wed, 01 Jan" is the trap: splitting there turns one cookie
    // into two, one of which loses its value and gets a bogus expiry.
    const out = splitSetCookie('s=abc; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/');
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('s=abc');
  });

  it('handles both cases together', () => {
    const out = splitSetCookie('a=1; Expires=Wed, 01 Jan 2031 00:00:00 GMT, b=2');
    expect(out).toHaveLength(2);
  });
});

describe('CookieJar — a session that survives navigation', () => {
  it('stores a cookie and sends it back', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('session=abc123; Path=/', 'https://example.com/login');
    expect(jar.headerFor('https://example.com/dashboard')).toBe('session=abc123');
  });

  it('returns null when nothing applies', () => {
    const jar = new CookieJar();
    expect(jar.headerFor('https://example.com/')).toBeNull();
  });
});

describe('CookieJar — domain scoping', () => {
  it('never sends one site\'s cookies to another', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('secret=leak; Path=/', 'https://example.com/');
    // This is the whole reason the jar is keyed by domain. A cookie picked up
    // from one site must not ride along to another.
    expect(jar.headerFor('https://bank.com/')).toBeNull();
    expect(jar.headerFor('https://evil.test/')).toBeNull();
  });

  it('sends a Domain cookie to subdomains', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('sid=1; Domain=example.com; Path=/', 'https://app.example.com/');
    expect(jar.headerFor('https://api.example.com/x')).toBe('sid=1');
  });

  it('keeps a host-only cookie on its own host', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('sid=1; Path=/', 'https://app.example.com/');
    expect(jar.headerFor('https://app.example.com/')).toBe('sid=1');
    // No Domain attribute means host-only, so a sibling subdomain gets nothing.
    expect(jar.headerFor('https://other.example.com/')).toBeNull();
  });

  it('rejects a cookie claiming a domain it does not belong to', () => {
    const jar = new CookieJar();
    // Without this guard a hostile response could set Domain=.com and be sent
    // to every site on the internet thereafter.
    jar.storeFromHeaders('evil=1; Domain=not-mine.com; Path=/', 'https://example.com/');
    expect(jar.headerFor('https://example.com/')).toBeNull();
  });
});

describe('CookieJar — attributes', () => {
  it('withholds a Secure cookie from plain http', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('s=1; Secure; Path=/', 'https://example.com/');
    expect(jar.headerFor('http://example.com/')).toBeNull();
    expect(jar.headerFor('https://example.com/')).toBe('s=1');
  });

  it('respects Path', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('admin=1; Path=/admin', 'https://example.com/admin');
    expect(jar.headerFor('https://example.com/admin/panel')).toBe('admin=1');
    expect(jar.headerFor('https://example.com/public')).toBeNull();
  });

  it('treats an expiry in the past as a deletion', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('s=1; Path=/', 'https://example.com/');
    expect(jar.headerFor('https://example.com/')).toBe('s=1');

    jar.storeFromHeaders('s=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'https://example.com/');
    expect(jar.headerFor('https://example.com/')).toBeNull();
  });

  it('honours Max-Age', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('s=1; Max-Age=3600; Path=/', 'https://example.com/');
    expect(jar.cookiesFor('https://example.com/')).toHaveLength(1);
  });

  it('replaces a cookie of the same name and path', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('sid=old; Path=/', 'https://example.com/');
    jar.storeFromHeaders('sid=new; Path=/', 'https://example.com/');
    expect(jar.headerFor('https://example.com/')).toBe('sid=new');
    expect(jar.cookiesFor('https://example.com/')).toHaveLength(1);
  });

  it('orders the most specific path first', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('a=1; Path=/', 'https://example.com/');
    jar.storeFromHeaders('b=2; Path=/admin/x', 'https://example.com/admin/x');
    expect(jar.headerFor('https://example.com/admin/x')).toBe('b=2; a=1');
  });

  it('sends several cookies together', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('a=1; Path=/, b=2; Path=/', 'https://example.com/');
    expect(jar.headerFor('https://example.com/')).toBe('a=1; b=2');
  });

  it('survives a nonsense Set-Cookie without throwing', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('=novalue; garbage', 'https://example.com/');
    jar.storeFromHeaders('', 'not a url');
    expect(jar.headerFor('https://example.com/')).toBeNull();
  });

  it('clears everything when told to', () => {
    const jar = new CookieJar();
    jar.storeFromHeaders('a=1; Path=/', 'https://example.com/');
    jar.clear();
    expect(jar.size).toBe(0);
  });
});