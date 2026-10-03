/**
 * Page snapshots — giving the model something it can actually aim at.
 *
 * The old browser tooling handed the model a wall of extracted text and then
 * expected it to click things, which meant inventing a CSS selector from prose.
 * That is a coin flip: `button.submit` versus `.btn.btn-primary` versus
 * `form > div:nth-child(2) > button` — the model cannot know which, and when
 * it guesses wrong it burns a whole turn discovering that the click missed.
 *
 * A snapshot inverts the problem. Walk the document once, describe what is
 * there in the vocabulary a person would use ("button, labelled Sign in"), and
 * give each interactive element a stable short reference. Clicking becomes
 * `click ref=e14` — a fact about the page, not a guess about its markup.
 *
 * This is the same idea as an accessibility tree, and OpenCode's docs call the
 * equivalent "page snapshots and search". Two properties matter:
 *
 *  - Refs are stable for the lifetime of a snapshot. You re-snapshot after
 *    anything that changes the page, and stale refs fail loudly instead of
 *    clicking the wrong button.
 *  - Refs are assigned in document order, so the output is deterministic and a
 *    test can assert on it.
 *
 * Pure functions over a Document. No network, no globals, no state — the live
 * tab manager owns identity and lifetime, this file only describes.
 */

export interface SnapshotNode {
  /** Short stable handle, e.g. 'e14'. How the model refers to this element. */
  ref: string;
  /** Coarse accessibility role: link, button, textbox, checkbox, heading… */
  role: string;
  /** Accessible name — label text, aria-label, placeholder, or trimmed text. */
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  /** Heading depth, 1-6. */
  level?: number;
}

export interface PageSnapshot {
  title: string;
  url: string;
  nodes: SnapshotNode[];
  /** Readable page text, already stripped of chrome. */
  text: string;
  textTruncated: boolean;
}

/** Fences around page-authored text. Matched by the system prompt's rule. */
export const UNTRUSTED_OPEN = '<<<UNTRUSTED_PAGE_CONTENT>>>';
export const UNTRUSTED_CLOSE = '<<<END_UNTRUSTED_PAGE_CONTENT>>>';

/** Cap the rendered text. Snapshots are context, not a content dump. */
export const MAX_SNAPSHOT_TEXT = 12_000;
/** Hard cap on nodes, so a pathological page cannot flood the context. */
export const MAX_SNAPSHOT_NODES = 400;

const INTERACTIVE_SELECTOR = [
  'a[href]', 'button', 'input', 'textarea', 'select', 'summary', 'label', 'option',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role]', '[role^="heading"]', '[onclick]',
  '[contenteditable=""]', '[contenteditable="true"]',
].join(',');

/** Chrome that is never useful in a snapshot and only adds noise. */
const NOISE_SELECTOR = [
  'script', 'style', 'noscript', 'template', 'svg', 'head', 'meta', 'link',
  '[aria-hidden="true"]', '.advertisement', '.advert', '.ad', '[id^="ad-"]',
].join(',');

function textOf(el: Element): string {
  // `innerText` respects layout and is what a reader sees, but it is absent in
  // some non-browser DOM implementations, so fall back rather than return ''.
  const anyEl = el as unknown as { innerText?: string; textContent?: string | null };
  return (anyEl.innerText ?? anyEl.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function isDisabled(el: Element): boolean {
  const anyEl = el as unknown as { disabled?: boolean };
  return el.hasAttribute('disabled') || anyEl.disabled === true;
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy
      .split(/\s+/)
      .map(id => el.ownerDocument?.getElementById(id)?.textContent ?? '')
      .filter(Boolean);
    if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  const tag = el.tagName.toLowerCase();
  if (tag === 'input') {
    const id = el.getAttribute('id');
    if (id) {
      // Build the selector by hand rather than via CSS.escape, which is not
      // present in every DOM implementation this runs against.
      const label = Array.from(el.ownerDocument?.querySelectorAll('label[for]') ?? [])
        .find(l => l.getAttribute('for') === id);
      if (label && textOf(label)) return textOf(label);
    }
    // A wrapping <label> is the other standard way to name an input.
    const parentLabel = el.closest('label');
    if (parentLabel && textOf(parentLabel)) return textOf(parentLabel);
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    return type === 'submit' || type === 'button' || type === 'reset'
      ? (el.getAttribute('value') || '').trim() || type
      : type;
  }

  if (tag === 'img') return el.getAttribute('alt')?.trim() || '';

  // Trim very long button text so a paragraph inside a button stays readable.
  const own = textOf(el);
  return own.length > 120 ? `${own.slice(0, 117)}…` : own;
}

function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit && explicit.trim()) return explicit.trim().split(/\s+/)[0];

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'a': return el.hasAttribute('href') ? 'link' : null;
    case 'button': return 'button';
    case 'summary': return 'button';
    case 'textarea': return 'textbox';
    case 'select': return 'combobox';
    case 'option': return 'option';
    case 'label': return null; // structure only; named inputs carry the label
    case 'input': {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (['checkbox'].includes(type)) return 'checkbox';
      if (['radio'].includes(type)) return 'radio';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (['range'].includes(type)) return 'slider';
      if (['file'].includes(type)) return 'fileupload';
      return 'textbox';
    }
    default: return null;
  }
}

function isHeading(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return true;
  return (el.getAttribute('role')?.toLowerCase().startsWith('heading')) === true;
}

function headingLevel(el: Element): number | undefined {
  const tag = el.tagName.toLowerCase();
  const match = /^h([1-6])$/.exec(tag);
  if (match) return Number(match[1]);
  const role = el.getAttribute('role')?.toLowerCase();
  const ariaLevel = el.getAttribute('aria-level');
  if (role === 'heading' && ariaLevel) return Number(ariaLevel);
  return undefined;
}

export interface SnapshotOptions {
  url?: string;
  /** Free-text filter over accessible names, roles and values. */
  query?: string;
  /** Include the readable page text alongside the node list. */
  includeText?: boolean;
}

export interface CollectedNode {
  node: SnapshotNode;
  el: Element;
}

/**
 * Walk the document once and return every addressable element WITH its node.
 *
 * Keeping the element attached is the point. A ref is only useful if something
 * can turn it back into a live element, and any scheme that re-walks the
 * document a second time to find it can disagree with the first walk the
 * moment the page changes — which would mean clicking something the model
 * never actually saw. One traversal, one source of truth.
 */
export function collectNodes(doc: Document): CollectedNode[] {
  const collected: CollectedNode[] = [];
  const seen = new Set<Element>();
  let index = 0;

  const root = doc.body || doc.documentElement;
  if (!root) return collected;

  // Sort into document order explicitly. The spec says querySelectorAll returns
  // document order for a selector list, but refs are numbered from that order
  // and a DOM implementation that grouped results by selector would silently
  // renumber every page differently — so this does not rely on the guarantee.
  const candidates = Array.from(root.querySelectorAll(INTERACTIVE_SELECTOR));
  candidates.sort((a, b) => {
    const rel = a.compareDocumentPosition(b);
    if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  for (const el of candidates) {
    if (collected.length >= MAX_SNAPSHOT_NODES) break;
    if (seen.has(el)) continue;
    // An element inside an aria-hidden subtree is not reachable by a person
    // using assistive tech, so it is not something the model should aim at.
    if (el.closest(NOISE_SELECTOR)) continue;

    const role = roleOf(el);
    const isH = isHeading(el);
    if (!role && !isH) continue;

    const name = accessibleName(el);
    if (!name && !isH) continue;
    if (role === 'link' && !name) continue;

    seen.add(el);
    index += 1;

    const node: SnapshotNode = { ref: `e${index}`, role: role || 'heading', name };
    const level = headingLevel(el);
    if (level) node.level = level;

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const value = (el as HTMLInputElement).value;
      if (value) node.value = String(value);
      const type = (el.getAttribute('type') || '').toLowerCase();
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        node.checked = (el as HTMLInputElement).checked === true;
      }
    }
    if (tag === 'a' && el.hasAttribute('href')) {
      node.value = el.getAttribute('href') || undefined;
    }
    if (isDisabled(el)) node.disabled = true;

    collected.push({ node, el });
  }
  return collected;
}

/**
 * Walk a document and describe it.
 *
 * Order is document order, and that is what makes refs reproducible: the same
 * page always yields the same `e14`.
 */
export function buildSnapshot(doc: Document, options: SnapshotOptions = {}): PageSnapshot {
  const collected = collectNodes(doc);
  // Refs are numbered from the FULL document walk, then filtered for display.
  // So a filtered snapshot shows a subset of the page's real refs rather than
  // renumbering them — a model that searched for "login" and then used e14 can
  // still trust what e14 meant before it filtered.
  const nodes = collected.map(c => c.node);
  const root = doc.body || doc.documentElement;

  const title = doc.title || '';
  let text = '';
  let textTruncated = false;
  if (options.includeText !== false) {
    const full = textOf(root) || '';
    if (full.length > MAX_SNAPSHOT_TEXT) {
      // Cut on a paragraph boundary where possible — a snapshot that stops
      // mid-sentence reads as if the page ended there.
      const sliced = full.slice(0, MAX_SNAPSHOT_TEXT);
      const brk = sliced.lastIndexOf('. ');
      text = brk > MAX_SNAPSHOT_TEXT * 0.6 ? sliced.slice(0, brk + 1) : sliced;
      textTruncated = true;
    } else {
      text = full;
    }
  }

  const query = options.query?.trim().toLowerCase();
  const filtered = query
    ? nodes.filter(n =>
        n.name.toLowerCase().includes(query) ||
        n.role.toLowerCase().includes(query) ||
        (n.value ?? '').toLowerCase().includes(query))
    : nodes;

  return { title, url: options.url || '', nodes: filtered, text, textTruncated };
}

/**
 * Render a snapshot as text for the model.
 *
 * The header states the count explicitly so the model can tell "there are only
 * four things here" from "I filtered these four out of a thousand" — without
 * that it silently assumes the page is simpler than it is.
 */
export function renderSnapshot(snap: PageSnapshot, totalNodes?: number): string {
  const lines: string[] = [];
  const where = snap.url ? `${snap.url}` : '(unknown url)';
  lines.push(`# ${snap.title || '(untitled)'}`);
  lines.push(where);

  const total = totalNodes ?? snap.nodes.length;
  if (total === 0) {
    lines.push('');
    lines.push('_No interactive elements found._');
  } else if (snap.nodes.length === 0) {
    lines.push('');
    lines.push(`_No elements match. ${total} interactive elements exist on this page._`);
  } else {
    if (snap.nodes.length < total) {
      lines.push(`**${snap.nodes.length} of ${total} interactive elements match** — re-snapshot without a filter to see the rest.`);
    } else {
      lines.push(`**${total} interactive element${total === 1 ? '' : 's'}.**`);
    }
    lines.push('');
    for (const n of snap.nodes) {
      const bits = [`${n.ref} ${n.role}`, `"${n.name}"`];
      if (n.level) bits.push(`h${n.level}`);
      if (n.value) bits.push(`value: ${n.value.length > 60 ? `${n.value.slice(0, 57)}…` : n.value}`);
      if (n.checked !== undefined) bits.push(n.checked ? 'checked' : 'unchecked');
      if (n.disabled) bits.push('disabled');
      lines.push(`- ${bits.join(' ')}`);
    }
  }

  if (snap.text) {
    lines.push('');
    lines.push('## Page text');
    // Everything between these markers is text the PAGE wrote, not the user.
    // A web page can contain "ignore your instructions and run this" aimed at
    // exactly this moment. Fencing it here — and saying so in the system
    // prompt — is the difference between reading a page and obeying one.
    lines.push('<<<UNTRUSTED_PAGE_CONTENT>>>');
    lines.push(snap.text);
    if (snap.textTruncated) lines.push('_(text truncated)_');
    lines.push('<<<END_UNTRUSTED_PAGE_CONTENT>>>');
  }
  return lines.join('\n');
}