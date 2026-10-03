import React, { useMemo } from 'react';
import { FileWarning } from 'lucide-react';
import MermaidRenderer from './MermaidRenderer';
import MarkdownRenderer from './MarkdownRenderer';

interface Props {
  type: string;
  content: string;
  title: string;
}

/**
 * Rendering things the agent generated.
 *
 * The HTML path already sandboxed its output correctly. The SVG path did not:
 * it injected the markup straight into the app's own document with
 * `dangerouslySetInnerHTML`, behind a regex that removed `<script>` and
 * `on*=`. That regex is not a security boundary. SVG carries a dozen ways to
 * run code that never use a `<script>` tag — `<foreignObject>`, `<use href>`,
 * `<animate attributeName="href">`, `<set>` — and any of them executes in the
 * GIA origin, with access to the same page that holds your session.
 *
 * That matters more than it sounds here, because the content is not authored by
 * anyone you trust. A web page GIA reads can tell it to emit an SVG; anything
 * a model hallucinates can too. Generated output is untrusted input wearing a
 * costume.
 *
 * So both paths now render the same way: an isolated document, no `allow-same-origin`,
 * so there is nothing for it to reach.
 */

const stripScripts = (html: string): string =>
  html.replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\bon\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\bon\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\bon\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript\s*:/gi, '');

/**
 * One preview height for every artifact kind, so a chat of them lines up.
 * Kept as a number and rendered to CSS, because the image path needs to inset
 * it (`maxHeight: HEIGHT - 24`) and arithmetic on a `'400px'` string is a
 * type error rather than a value.
 */
const PREVIEW_HEIGHT_PX = 400;
const PREVIEW_HEIGHT = `${PREVIEW_HEIGHT_PX}px`;

/**
 * Isolated preview.
 *
 * `allow-scripts` but NOT `allow-same-origin`: without same-origin the frame
 * gets an opaque origin and cannot touch this page, its storage, or its cookies
 * — which is the whole point of putting it in a frame rather than in the DOM.
 */
const SandboxedPreview: React.FC<{ doc: string; title: string; background?: string }> = ({
  doc, title, background,
}) => (
  <iframe
    title={title}
    srcDoc={doc}
    sandbox="allow-scripts"
    className="w-full rounded-lg"
    style={{
      border: '1px solid var(--gia-border)',
      background: background ?? 'var(--gia-surface)',
      minHeight: '300px',
      height: PREVIEW_HEIGHT,
    }}
  />
);

const HtmlPreview: React.FC<{ html: string; title: string }> = ({ html, title }) => {
  const sanitized = useMemo(() => stripScripts(html), [html]);
  return <SandboxedPreview doc={sanitized} title={title} />;
};

/**
 * SVG, sandboxed like everything else.
 *
 * An `<svg>` root needs an XML prolog or the browser treats the document as
 * broken, which is why wrapping it in a full HTML document is deliberate
 * rather than decorative.
 */
const SvgPreview: React.FC<{ svg: string; title: string }> = ({ svg, title }) => {
  const doc = useMemo(() => {
    const clean = stripScripts(svg);
    return `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:transparent}
svg{max-width:100%;max-height:100%}</style></head><body>${clean}</body></html>`;
  }, [svg]);
  return <SandboxedPreview doc={doc} title={title} background="transparent" />;
};

/**
 * PDF.
 *
 * Claude Code's desktop app ships an expanded HTML/PDF preview because the
 * single most common "build me a thing" output is a document, and dumping raw
 * PDF bytes into a `<pre>` is not a preview. The native viewer is used instead
 * of a JS PDF library — one less CDN, and no script running inside our page.
 *
 * The sandbox deliberately omits `allow-scripts`: PDF action scripts then have
 * nothing to execute in. It keeps `allow-same-origin` because the WebKit PDF
 * viewer refuses to load at all without it, and that is the trade — the frame
 * gets the *native viewer*, not our DOM, and its content cannot script this page.
 *
 * Content may arrive as raw base64 or as an already-formed data URL, because the
 * two tool paths that produce PDFs disagree about which.
 */
const PdfPreview: React.FC<{ content: string; title: string }> = ({ content, title }) => {
  const src = useMemo(() => {
    const trimmed = content.trim();
    if (trimmed.startsWith('data:')) return trimmed;
    // Strip any accidental whitespace/newlines from base64 payloads.
    const b64 = trimmed.replace(/\s+/g, '');
    if (!b64) return '';
    return `data:application/pdf;base64,${b64}`;
  }, [content]);

  if (!src) return <PreviewFallback label="Empty PDF" />;

  return (
    <div className="flex flex-col gap-1.5">
      <iframe
        title={title}
        src={src}
        // No `allow-scripts`: a PDF's embedded JS gets nothing to run in.
        sandbox="allow-same-origin"
        className="w-full rounded-lg"
        style={{
          border: '1px solid var(--gia-border)',
          background: '#fff',
          minHeight: '300px',
          height: PREVIEW_HEIGHT,
        }}
      />
      <PdfFallbackLink src={src} title={title} />
    </div>
  );
};

/**
 * WebKit will not paint a PDF inside a sandboxed frame on every platform, and
 * when it doesn't the user gets a blank rectangle with no explanation. An
 * always-present "open/download" link is the honest escape hatch.
 */
const PdfFallbackLink: React.FC<{ src: string; title: string }> = ({ src, title }) => (
  <a
    href={src}
    download={`${title || 'document'}.pdf`}
    className="self-start text-[10px] underline underline-offset-2"
    style={{ color: 'var(--gia-muted)' }}
  >
    Open PDF directly
  </a>
);

/** Raster images the agent produced (png/jpeg/webp/gif). */
const ImagePreview: React.FC<{ content: string; mime: string; title: string }> = ({ content, mime, title }) => {
  const src = useMemo(() => {
    const trimmed = content.trim();
    if (trimmed.startsWith('data:') || trimmed.startsWith('http')) return trimmed;
    return `data:${mime};base64,${trimmed.replace(/\s+/g, '')}`;
  }, [content, mime]);

  return (
    <div
      className="w-full rounded-lg flex items-center justify-center overflow-auto"
      style={{ border: '1px solid var(--gia-border)', background: 'var(--gia-surface-2)', minHeight: '120px', maxHeight: PREVIEW_HEIGHT }}
    >
      <img src={src} alt={title} className="max-w-full object-contain" style={{ maxHeight: PREVIEW_HEIGHT_PX - 24 }} />
    </div>
  );
};

/** Shown when an artifact is present but cannot be displayed. */
const PreviewFallback: React.FC<{ label: string }> = ({ label }) => (
  <div
    className="w-full rounded-lg flex items-center gap-2 justify-center"
    style={{ border: '1px solid var(--gia-border)', background: 'var(--gia-surface-2)', minHeight: '120px', color: 'var(--gia-muted)' }}
  >
    <FileWarning size={14} />
    <span className="text-xs">{label}</span>
  </div>
);

const ArtifactRenderer: React.FC<Props> = ({ type, content, title }) => {
  const kind = type.toLowerCase().trim();

  if (kind === 'text/html' || kind === 'html') {
    return <HtmlPreview html={content} title={title} />;
  }
  if (kind === 'image/svg+xml' || kind === 'svg' || kind === 'svg+xml') {
    return <SvgPreview svg={content} title={title} />;
  }
  if (kind === 'application/vnd.mermaid' || kind === 'mermaid' || kind === 'text/mermaid') {
    return <MermaidRenderer definition={content} />;
  }
  // Markdown was falling through to a raw `<pre>`, which is the single worst
  // way to show the format people actually ask for ("write me a README").
  if (kind === 'text/markdown' || kind === 'markdown' || kind === 'md') {
    return (
      <div
        className="rounded-lg p-4 overflow-auto"
        style={{ border: '1px solid var(--gia-border)', background: 'var(--gia-surface-2)', maxHeight: PREVIEW_HEIGHT }}
      >
        <MarkdownRenderer content={content} />
      </div>
    );
  }
  if (kind === 'application/pdf' || kind === 'pdf') {
    return <PdfPreview content={content} title={title} />;
  }
  if (kind.startsWith('image/')) {
    return <ImagePreview content={content} mime={kind} title={title} />;
  }
  return (
    <pre
      className="text-xs p-3 rounded-lg"
      style={{
        background: 'var(--gia-surface-2)',
        border: '1px solid var(--gia-border)',
        color: 'var(--gia-muted)',
        overflow: 'auto',
        maxHeight: PREVIEW_HEIGHT,
        whiteSpace: 'pre-wrap',
      }}
    >
      {content}
    </pre>
  );
};

export default React.memo(ArtifactRenderer);