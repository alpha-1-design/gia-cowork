/**
 * SentenceChunker — turns a token stream into speakable sentences.
 *
 * Phase 2 of the voice build: GIA speaks WHILE she thinks, straight from
 * `GiaBrain.generate`'s `onStream`. The chunker buffers stream chunks and
 * emits complete sentences (wave-1 anti-drowning rules: never speak a
 * fragment, never speak tool JSON, never speak code fences).
 *
 * Pure and synchronous — fully unit-testable without a mic or a model.
 */

export interface ChunkerOptions {
  /** Minimum characters before a sentence boundary is honored. Default 24. */
  minSentenceChars?: number;
  /** Emit a long run without punctuation after this many chars. Default 220. */
  maxSentenceChars?: number;
  /** Strip ``` code fences instead of speaking them. Default true. */
  stripFences?: boolean;
}

const DEFAULTS: Required<ChunkerOptions> = {
  minSentenceChars: 24,
  maxSentenceChars: 220,
  stripFences: true,
};

export class SentenceChunker {
  private opts: Required<ChunkerOptions>;
  private buffer = '';
  /** True once a fence opened and has not closed — its content is swallowed. */
  private inFence = false;

  constructor(opts: ChunkerOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get pendingChars() { return this.buffer.length; }

  /** Feed one stream chunk; returns every complete sentence it completed. */
  feed(chunk: string): string[] {
    if (!chunk) return [];
    let text = chunk;

    // Fence filtering BEFORE buffering: never speak code.
    if (this.opts.stripFences) {
      text = this.stripFences(text);
      if (!text) return [];
    }

    this.buffer += text;
    return this.drain();
  }

  /** Call at end of stream; emits whatever complete-enough text remains. */
  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (!rest) return [];
    // The tail is a real sentence if it ends in punctuation; otherwise it's
    // still worth speaking (stream cut-off) — she shouldn't swallow her
    // last words.
    return [rest];
  }

  reset() {
    this.buffer = '';
    this.inFence = false;
  }

  /** Remove ```fenced blocks, keeping any prose around them. Handles fences
   *  opening mid-line ("...prose. ```js" — common model output) and markers
   *  split across stream chunks. Passes text through byte-for-byte when no
   *  fence is open and the chunk contains none. */
  private stripFences(chunk: string): string {
    if (!this.inFence && !/(?:^|[\s\S])```|~~~/.test(chunk)) return chunk;
    let out = '';
    let rest = chunk;
    while (rest.length > 0) {
      if (this.inFence) {
        // Inside a fence: swallow everything up to the closing marker.
        const end = rest.search(/```|~~~/);
        if (end === -1) { rest = ''; break; }
        const marker = rest.slice(end).match(/^```|~~~/)![0];
        rest = rest.slice(end + marker.length);
        this.inFence = false;
        continue;
      }
      const open = rest.match(/```|~~~/);
      if (!open || open.index === undefined) { out += rest; rest = ''; break; }
      out += rest.slice(0, open.index);
      // Drop the marker plus the rest of its line (the language tag).
      const after = rest.slice(open.index + open[0].length);
      const lineEnd = after.indexOf('\n');
      if (lineEnd === -1) { this.inFence = true; rest = ''; break; }
      rest = after.slice(lineEnd + 1);
      this.inFence = true;
    }
    return out;
  }

  private drain(): string[] {
    const sentences: string[] = [];
    while (true) {
      const ready = this.nextSentence();
      if (ready === null) break;
      const trimmed = ready.trim();
      if (trimmed) sentences.push(trimmed);
      if (ready === '') break; // safety
    }
    return sentences;
  }

  /** Find the next complete sentence at the head of the buffer. */
  private nextSentence(): string | null {
    const { minSentenceChars, maxSentenceChars } = this.opts;
    if (this.buffer.length < minSentenceChars) return null;

    // Sentence boundaries: . ! ? or newline followed by space/end.
    const match = this.buffer.match(/^[\s\S]*?[.!?](?=\s|$)|^[\s\S]*?\n/);
    if (match && match[0].trim().length >= minSentenceChars) {
      this.buffer = this.buffer.slice(match[0].length);
      return match[0];
    }
    // Runaway clause (lists, long speech): emit at the last safe break so
    // the listener isn't left in silence for 20+ seconds.
    if (this.buffer.length >= maxSentenceChars) {
      const cut = this.buffer.lastIndexOf(',', maxSentenceChars);
      const idx = cut > minSentenceChars ? cut + 1 : maxSentenceChars;
      const piece = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx);
      return piece;
    }
    return null;
  }
}
