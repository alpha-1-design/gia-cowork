import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ArtifactRenderer from '../ArtifactRenderer';

/**
 * The bug this guards: SVG was injected with `dangerouslySetInnerHTML` behind a
 * regex that stripped `<script>` and `on*=`. That regex is not a security
 * boundary. `<foreignObject>`, `<use href>`, `<animate attributeName="href">`
 * and `<set>` all run code without ever writing `<script>`, and generated output
 * is untrusted input — a page GIA reads can talk it into emitting an SVG.
 *
 * These tests assert the *mechanism* (an isolated frame with no
 * `allow-same-origin`, never raw DOM injection) rather than trying to enumerate
 * bypasses, because an enumeration test would pass while a new one is invented.
 */

vi.mock('../MermaidRenderer', () => ({
  default: ({ definition }: { definition: string }) => <div data-testid="mermaid">{definition}</div>,
}));

const frame = () => document.querySelector('iframe');

describe('ArtifactRenderer', () => {
  it('renders SVG in an isolated frame, never into the page DOM', () => {
    const { container } = render(
      <ArtifactRenderer type="image/svg+xml" content='<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' title="chart" />,
    );

    expect(frame()).toBeTruthy();
    expect(frame()!.getAttribute('sandbox')).toBe('allow-scripts');
    // The whole point: an opaque origin, so the frame cannot reach this page.
    expect(frame()!.getAttribute('sandbox')).not.toContain('allow-same-origin');

    // No raw SVG element reached the document outside the frame.
    expect(container.querySelector('svg')).toBeNull();
    expect(document.body.querySelector('foreignObject')).toBeNull();
  });

  it('neutralizes the SVG bypass vectors even before the frame', () => {
    render(
      <ArtifactRenderer
        type="svg"
        content={'<svg><script>alert(1)</script><rect onload="alert(2)"/></svg>'}
        title="x"
      />,
    );
    const doc = frame()!.getAttribute('srcdoc') ?? '';
    expect(doc).not.toContain('<script');
    expect(doc).not.toContain('onload');
  });

  it('keeps HTML sandboxed the same way', () => {
    render(<ArtifactRenderer type="text/html" content="<h1>hi</h1>" title="page" />);
    expect(frame()!.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame()!.getAttribute('sandbox')).not.toContain('allow-same-origin');
  });

  it('gives SVG and HTML a consistent preview height', () => {
    const { rerender } = render(<ArtifactRenderer type="svg" content="<svg/>" title="a" />);
    const svgHeight = (frame() as HTMLElement).style.height;
    rerender(<ArtifactRenderer type="text/html" content="<p>b</p>" title="b" />);
    expect((frame() as HTMLElement).style.height).toBe(svgHeight);
  });

  it('renders mermaid through the dedicated renderer', () => {
    render(<ArtifactRenderer type="application/vnd.mermaid" content="graph TD; A-->B;" title="m" />);
    expect(screen.getByTestId('mermaid')).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it('renders markdown as markdown, not as a raw preformatted dump', () => {
    render(<ArtifactRenderer type="text/markdown" content="# Title" title="readme" />);
    expect(screen.getByText('Title')).toBeTruthy();
    expect(frame()).toBeNull();
  });

  it('accepts case and alias variants of a mime type', () => {
    render(<ArtifactRenderer type="Application/PDF" content="" title="p" />);
    // Empty PDF still renders the preview shell, not a crash.
    expect(screen.getByText('Empty PDF')).toBeTruthy();
  });

  it('builds a data URL from raw base64 PDF content', () => {
    const b64 = Buffer.from('%PDF-1.4 fake').toString('base64');
    render(<ArtifactRenderer type="application/pdf" content={b64} title="doc" />);
    expect(frame()!.getAttribute('src')).toBe(`data:application/pdf;base64,${b64}`);
    // A sandboxed frame must not be allowed to script.
    expect(frame()!.getAttribute('sandbox')).not.toContain('allow-scripts');
  });

  it('renders raster images as images', () => {
    render(<ArtifactRenderer type="image/png" content="iVBORw0KGgo=" title="shot" />);
    const img = document.querySelector('img');
    expect(img).toBeTruthy();
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('falls back to plain text for unknown types', () => {
    render(<ArtifactRenderer type="application/x-weird" content="hello" title="t" />);
    expect(screen.getByText('hello')).toBeTruthy();
    expect(frame()).toBeNull();
  });
});