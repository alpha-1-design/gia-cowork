import { describe, it, expect } from 'vitest';
import { collectNodes, buildSnapshot, renderSnapshot, UNTRUSTED_OPEN, UNTRUSTED_CLOSE } from '../browser/snapshot';

function docFrom(html: string): Document {
  const doc = document.implementation.createHTMLDocument('test');
  doc.body.innerHTML = html;
  return doc;
}

const PAGE = `
  <h1>Sign in</h1>
  <nav><a href="/home">Home</a></nav>
  <form>
    <label for="u">Email</label>
    <input id="u" name="email" type="email" placeholder="you@example.com" />
    <input id="p" name="password" type="password" />
    <input id="remember" type="checkbox" aria-label="Remember me" checked />
    <button type="submit">Sign in</button>
    <button type="button" disabled>Cancel</button>
  </form>
  <select id="s"><option>One</option></select>
  <script>var x = 1;</script>
  <div aria-hidden="true"><button>Hidden trap</button></div>
`;

describe('collectNodes — addressing the page', () => {
  it('gives every interactive element a ref, in document order', () => {
    const nodes = collectNodes(docFrom(PAGE)).map(c => c.node);
    expect(nodes[0].ref).toBe('e1');
    expect(nodes.map(n => n.ref)).toEqual(nodes.map((_, i) => `e${i + 1}`));
  });

  it('identifies controls by role and name, not by markup', () => {
    const byName = new Map(collectNodes(docFrom(PAGE)).map(c => [c.node.name, c.node]));
    expect(byName.get('Sign in')?.role).toBe('button');
    expect(byName.get('Home')?.role).toBe('link');
    // The whole point: the model says "Sign in" and gets the right element
    // without ever seeing .btn-primary or form > div:nth-child(2) > button.
    expect(byName.get('Email')?.role).toBe('textbox');
  });

  it('names a labelled input from its <label for>', () => {
    const nodes = collectNodes(docFrom(PAGE)).map(c => c.node);
    const email = nodes.find(n => n.role === 'textbox' && n.value === undefined);
    expect(email?.name).toBe('Email');
  });

  it('falls back to the placeholder when there is no label', () => {
    const nodes = collectNodes(docFrom('<input type="text" placeholder="Search…">')).map(c => c.node);
    expect(nodes[0].name).toBe('Search…');
  });

  it('maps input types to the right roles', () => {
    const nodes = collectNodes(docFrom(`
      <input type="checkbox" aria-label="Remember me">
      <input type="radio" aria-label="Option A">
      <input type="file" aria-label="Upload">
      <input type="submit" value="Go">
      <select aria-label="Choice"></select>
      <textarea aria-label="Notes"></textarea>
    `)).map(c => c.node);
    const roleOf = (name: string) => nodes.find(n => n.name === name)?.role;
    expect(roleOf('Remember me')).toBe('checkbox');
    expect(roleOf('Option A')).toBe('radio');
    expect(roleOf('Upload')).toBe('fileupload');
    expect(roleOf('Go')).toBe('button');
    expect(roleOf('Choice')).toBe('combobox');
    expect(roleOf('Notes')).toBe('textbox');
  });

  it('reports checked state and disabled state', () => {
    const nodes = collectNodes(docFrom(PAGE)).map(c => c.node);
    expect(nodes.find(n => n.name === 'Remember me')?.checked).toBe(true);
    expect(nodes.find(n => n.name === 'Cancel')?.disabled).toBe(true);
  });

  it('keeps the element attached so a ref can be acted on', () => {
    const collected = collectNodes(docFrom(PAGE));
    // A ref that cannot be resolved to a live element is decoration.
    expect(collected.every(c => c.el && c.el.tagName)).toBe(true);
    expect(collected.find(c => c.node.role === 'button' && c.node.name === 'Sign in')!.el.tagName).toBe('BUTTON');
  });

  it('skips scripts and aria-hidden subtrees', () => {
    const names = collectNodes(docFrom(PAGE)).map(c => c.node.name);
    // A button a sighted user cannot reach is not something to offer the model.
    expect(names).not.toContain('Hidden trap');
  });

  it('includes headings so the page structure is legible', () => {
    const nodes = collectNodes(docFrom(PAGE)).map(c => c.node);
    const h1 = nodes.find(n => n.name === 'Sign in');
    expect(h1?.role).toBe('heading');
    expect(h1?.level).toBe(1);
  });

  it('returns an empty list rather than throwing on an empty document', () => {
    expect(collectNodes(docFrom(''))).toEqual([]);
  });
});

describe('buildSnapshot — search', () => {
  it('filters by accessible name', () => {
    const snap = buildSnapshot(docFrom(PAGE), { query: 'sign' });
    expect(snap.nodes.every(n => /sign/i.test(n.name))).toBe(true);
    expect(snap.nodes.length).toBeGreaterThan(0);
  });

  it('keeps the original refs when filtering', () => {
    const all = buildSnapshot(docFrom(PAGE));
    const filtered = buildSnapshot(docFrom(PAGE), { query: 'Sign in' });
    const target = all.nodes.find(n => n.name === 'Sign in')!;
    // Renumbering on filter would mean a ref the model already trusted meant
    // something else the moment it searched.
    expect(filtered.nodes.map(n => n.ref)).toContain(target.ref);
  });

  it('returns nothing and says so when nothing matches', () => {
    const snap = buildSnapshot(docFrom(PAGE), { query: 'nonexistent-xyz' });
    expect(snap.nodes).toEqual([]);
    expect(renderSnapshot(snap, 7)).toMatch(/No elements match/);
  });
});

describe('renderSnapshot', () => {
  it('states the element count so an empty page is not mistaken for a filtered one', () => {
    const out = renderSnapshot(buildSnapshot(docFrom('<p>nothing here</p>')));
    expect(out).toMatch(/No interactive elements found/);
  });

  it('says how many are hidden by a filter', () => {
    const out = renderSnapshot(buildSnapshot(docFrom(PAGE), { query: 'sign in' }), 9);
    expect(out).toMatch(/of 9 interactive elements match/);
  });

  it('fences page text as untrusted', () => {
    const out = renderSnapshot(buildSnapshot(docFrom('<button>Go</button><p>hello</p>')));
    expect(out).toContain(UNTRUSTED_OPEN);
    expect(out).toContain(UNTRUSTED_CLOSE);
    // Without the fence, a page saying "ignore previous instructions" is just
    // more text. With it, the fence tells the model this is evidence.
    expect(out.indexOf(UNTRUSTED_OPEN)).toBeLessThan(out.indexOf('hello'));
  });

  it('truncates very long page text and says it did', () => {
    const out = renderSnapshot(buildSnapshot(docFrom(`<p>${'word '.repeat(6000)}</p>`)));
    expect(out).toMatch(/text truncated/);
  });

  it('can omit page text for a structure-only snapshot', () => {
    const out = renderSnapshot(buildSnapshot(docFrom('<p>lots of prose here</p>'), { includeText: false }));
    expect(out).not.toContain('lots of prose here');
  });
});