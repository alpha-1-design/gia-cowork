import React, { useMemo } from 'react';
import { parseVisualBlock } from './parseVisualBlock';
import { VisualLoading } from './common';
import VisualErrorBoundary from './VisualErrorBoundary';
import { ArtifactVisual } from './ArtifactVisual';
import { DataFrameVisual } from './DataFrameVisual';
import { ExecResultVisual } from './ExecResultVisual';
import { ChartVisual } from './ChartVisual';
import { MindMapVisual } from './MindMapVisual';
import { DiffVisual } from './DiffVisual';
import { DataTableVisual } from './DataTableVisual';
import { ImageGalleryVisual } from './ImageGalleryVisual';
import { TimelineVisual } from './TimelineVisual';
import { TerminalVisual } from './TerminalVisual';
import { MetricWidgetVisual } from './MetricWidgetVisual';
import { WaveformVisual } from './WaveformVisual';
import { DocumentOutlineVisual } from './DocumentOutlineVisual';
import { MapVisual } from './MapVisual';
import { SlidesVisual } from './SlidesVisual';
import { CanvasVisual } from './CanvasVisual';
import ThreeVisual from './ThreeVisual';
import GraphVisual from './GraphVisual';
import { FileVisual } from './FileVisual';
import { CrawlResultVisual } from './CrawlResultVisual';

export interface VisualRendererProps {
  code: string;
  /** True while the source fence is still streaming (no closing ``` yet).
   * Unparseable or unknown content is then far more likely to be "the rest
   * of the block hasn't arrived", so we show the rendering placeholder
   * instead of degrading to the artifact card and flashing back. */
  incomplete?: boolean;
}

const RenderVisualByType: React.FC<VisualRendererProps> = ({ code, incomplete }) => {
  const parsed = useMemo(() => parseVisualBlock(code), [code]);

  // W9 render-anything guarantee: a block the pipeline can't confidently
  // draw — JSON that won't parse, or a type no renderer claims — never
  // surfaces as a red error, raw JSON, or a broken nothing. While streaming
  // it gets the rendering placeholder; once the fence is complete it degrades
  // to the generic artifact card. A renderer crash is still caught by the
  // boundary below as the true last resort.
  if ('error' in parsed) {
    return incomplete
      ? <VisualLoading label="Rendering visualization…" />
      : <ArtifactVisual source={code} error={parsed.error} />;
  }

  const { type, data } = parsed;

  switch (type) {
    case 'chart':
      return <ChartVisual data={data} />;
    case 'mindmap':
    case 'mind_map':
    case 'mind-map':
      return <MindMapVisual data={data} />;
    case 'diff':
    case 'code_diff':
    case 'code-diff':
      return <DiffVisual data={data} />;
    case 'table':
    case 'data_table':
    case 'data-table':
      return <DataTableVisual data={data} />;
    case 'dataframe':
    case 'csv':
    case 'dataframe_preview':
    case 'dataframe-preview':
      return <DataFrameVisual data={data} />;
    case 'gallery':
    case 'image_gallery':
    case 'image-gallery':
      return <ImageGalleryVisual data={data} />;
    case 'timeline':
      return <TimelineVisual data={data} />;
    case 'terminal':
    case 'terminal_output':
    case 'terminal-output':
      return <TerminalVisual data={data} />;
    case 'exec_result':
    case 'exec-result':
    case 'execution':
    case 'code_execution':
    case 'code-execution':
    case 'code_result':
    case 'code-result':
      return <ExecResultVisual data={data} />;
    case 'widget':
    case 'metric':
    case 'metrics':
      return <MetricWidgetVisual data={data as never} />;
    case 'waveform':
    case 'audio':
      return <WaveformVisual data={data} />;
    case 'outline':
    case 'document_outline':
    case 'toc':
      return <DocumentOutlineVisual data={data} />;
    case 'map':
    case 'openstreetmap':
      return <MapVisual data={data} />;
    case 'slides':
    case 'presentation':
    case 'slide_deck':
    case 'slide-deck':
      return <SlidesVisual data={data} />;
    case 'canvas':
    case 'drawing':
    case 'diagram':
      return <CanvasVisual data={data} />;
    case '3d':
    case 'three':
    case 'threejs':
    case 'scene':
      return <ThreeVisual data={data} />;
    case 'graph':
    case 'network':
    case 'node_graph':
    case 'node-graph':
    case 'topology':
      return <GraphVisual data={data as never} />;
    case 'file_preview':
    case 'file-preview':
      return <FileVisual data={data as never} />;
    case 'crawl_result':
    case 'crawl-result':
      return <CrawlResultVisual data={data} />;
    default:
      return incomplete
        ? <VisualLoading label="Rendering visualization…" />
        : <ArtifactVisual type={type} data={data} source={code} />;
  }
};

const VisualRenderer: React.FC<VisualRendererProps> = ({ code, incomplete }) => (
  <VisualErrorBoundary>
    <RenderVisualByType code={code} incomplete={incomplete} />
  </VisualErrorBoundary>
);

export default React.memo(VisualRenderer);
