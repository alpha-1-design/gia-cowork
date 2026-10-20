import { useGiaStore } from '../store/useGiaStore';
export type ThinkingPhase =
  | 'gathering'
  | 'analyzing'
  | 'coding'
  | 'writing'
  | 'searching'
  | 'planning'
  | 'reasoning'
  | 'processing'
  | 'idle';

interface PhaseDef {
  label: string;
  icon: string;
  color: string;
  glowColor: string;
  speed: number;
}

const PHASE_MAP: Record<ThinkingPhase, PhaseDef> = {
  gathering:  { label: 'Reading context',     icon: '⟐', color: '#6366f1', glowColor: 'rgba(99,102,241,0.3)',  speed: 700 },
  analyzing:  { label: 'Checking the facts',  icon: '⟐', color: '#f59e0b', glowColor: 'rgba(245,158,11,0.3)', speed: 600 },
  coding:     { label: 'Writing the change',  icon: '⟐', color: '#8b5cf6', glowColor: 'rgba(139,92,246,0.3)', speed: 450 },
  writing:    { label: 'Drafting the answer', icon: '⟐', color: '#ec4899', glowColor: 'rgba(236,72,153,0.3)', speed: 500 },
  searching:  { label: 'Searching',           icon: '⟐', color: '#14b8a6', glowColor: 'rgba(20,184,166,0.3)', speed: 650 },
  planning:   { label: 'Planning the move',   icon: '⟐', color: '#22c55e', glowColor: 'rgba(34,197,94,0.3)',  speed: 700 },
  reasoning:  { label: 'Thinking it through', icon: '⟐', color: '#a855f7', glowColor: 'rgba(168,85,247,0.3)', speed: 800 },
  processing: { label: 'Running a tool',      icon: '⟐', color: '#3b82f6', glowColor: 'rgba(59,130,246,0.3)', speed: 400 },
  idle:       { label: 'Ready',               icon: '',   color: '#6b7280', glowColor: 'rgba(107,114,128,0.3)', speed: 0 },
};

const THINKING_EXTRAS = [
  'Looking before touching anything',
  'Waiting on the tool result',
  'Checking I understood the ask',
  'Comparing what I found',
  'Narrowing to the next step',
  'Verifying the last result',
  'Keeping the change small',
  'Reading the surrounding code',
];

const BUILD_PHASE_MAP: Partial<Record<ThinkingPhase, PhaseDef>> = {
  planning:   { label: 'Deciding the shape',  icon: '⟐', color: '#f97316', glowColor: 'rgba(249,115,22,0.35)', speed: 700 },
  gathering:  { label: 'Reading the project', icon: '⟐', color: '#fb923c', glowColor: 'rgba(251,146,60,0.35)', speed: 600 },
  coding:     { label: 'Writing the app',     icon: '⟐', color: '#f97316', glowColor: 'rgba(249,115,22,0.35)', speed: 450 },
  processing: { label: 'Checking it runs',    icon: '⟐', color: '#ea580c', glowColor: 'rgba(234,88,12,0.35)',  speed: 500 },
  reasoning:  { label: 'Fixing what failed',  icon: '⟐', color: '#c2410c', glowColor: 'rgba(194,65,12,0.35)',  speed: 600 },
};

const BUILD_EXTRAS = [
  'Scaffold first, then the feature',
  'Matching the files that already exist',
  'Running the check before I say it works',
  'Keeping the preview in sync',
];

const TOOL_LABELS: Record<string, { label: string; color: string }> = {
  web_search:       { label: 'Searching the web',        color: '#14b8a6' },
  read_url:         { label: 'Reading the page',         color: '#14b8a6' },
  browser_navigate: { label: 'Opening the page',         color: '#14b8a6' },
  page_info:        { label: 'Reading page details',     color: '#14b8a6' },
  web_scrape:       { label: 'Extracting the page',      color: '#14b8a6' },
  terminal_run:     { label: 'Running a command',        color: '#8b5cf6' },
  terminal_status:  { label: 'Checking the command',     color: '#8b5cf6' },
  terminal_kill:    { label: 'Stopping the command',     color: '#8b5cf6' },
  filesystem_read:  { label: 'Reading a file',           color: '#6366f1' },
  filesystem_write: { label: 'Writing a file',           color: '#6366f1' },
  list_files:       { label: 'Listing files',            color: '#6366f1' },
  file_search:      { label: 'Searching files',          color: '#6366f1' },
  file_get:         { label: 'Opening a file',           color: '#6366f1' },
  file_list:        { label: 'Listing files',            color: '#6366f1' },
  image_generation: { label: 'Generating an image',      color: '#ec4899' },
  zip_project:      { label: 'Packing the project',      color: '#f59e0b' },
  http_request:     { label: 'Calling an API',           color: '#3b82f6' },
  emoji_search:     { label: 'Finding an emoji',         color: '#f59e0b' },
  brain_boost:      { label: 'Pulling extra context',    color: '#a855f7' },
  delegate_task:    { label: 'Handing off to an agent',  color: '#22c55e' },
  request_clarification: { label: 'Waiting on your answer', color: '#f59e0b' },
  code_execute:     { label: 'Running code',             color: '#8b5cf6' },
  python_execute:   { label: 'Running Python',           color: '#8b5cf6' },
  build_project:    { label: 'Building the project',     color: '#f97316' },
  neura_query:      { label: 'Searching memory',         color: '#a78bfa' },
  neura_related:    { label: 'Following a connection',   color: '#818cf8' },
  neura_stats:      { label: 'Checking memory health',   color: '#c084fc' },
  save_memory:      { label: 'Saving a memory',          color: '#a855f7' },
  forget_memory:    { label: 'Removing a memory',        color: '#a855f7' },
  note_create:      { label: 'Writing a note',           color: '#f59e0b' },
  note_read:        { label: 'Reading a note',           color: '#f59e0b' },
  note_update:      { label: 'Updating a note',          color: '#f59e0b' },
  note_delete:      { label: 'Deleting a note',          color: '#f59e0b' },
  task_create:      { label: 'Adding a task',            color: '#22c55e' },
  task_read:        { label: 'Reading tasks',            color: '#22c55e' },
  task_update:      { label: 'Updating a task',          color: '#22c55e' },
  task_delete:      { label: 'Removing a task',          color: '#22c55e' },
  generate_file:    { label: 'Creating a file',          color: '#6366f1' },
  edit_document:    { label: 'Editing a document',       color: '#6366f1' },
  download_url:     { label: 'Downloading',              color: '#6366f1' },
  download_file:    { label: 'Downloading',              color: '#6366f1' },
  browse_web:       { label: 'Browsing',                 color: '#14b8a6' },
  read_document:    { label: 'Reading a document',       color: '#14b8a6' },
  data_analysis:    { label: 'Analyzing data',           color: '#3b82f6' },
  local_search:     { label: 'Searching this machine',   color: '#3b82f6' },
  screenshot:       { label: 'Capturing the screen',     color: '#ec4899' },
  share_content:    { label: 'Preparing a share',        color: '#22c55e' },
  create_pdf:       { label: 'Making a PDF',             color: '#f97316' },
  sandbox_exec:     { label: 'Running in the sandbox',   color: '#8b5cf6' },
  sandbox_install:  { label: 'Installing packages',      color: '#8b5cf6' },
  sandbox_clone:    { label: 'Cloning repo',             color: '#8b5cf6' },
};

export function ThinkingStatus({ phase, toolName, onTap }: { phase?: ThinkingPhase; toolName?: string | null; onTap?: () => void }) {
  const buildMode = useGiaStore(s => s.buildMode);
  const known = toolName ? TOOL_LABELS[toolName] : undefined;
  const toolLine = known ?? (toolName
    ? { label: toolName.replace(/_/g, ' '), color: '#e7e2d6' }
    : null);
  const activePhase: ThinkingPhase = phase && phase !== 'idle' ? phase : (buildMode ? 'coding' : 'processing');
  const def = (buildMode && BUILD_PHASE_MAP[activePhase]) || PHASE_MAP[activePhase] || PHASE_MAP.processing;
  const label = toolLine?.label ?? def.label;
  const color = toolLine?.color ?? def.color;

  return (
    <div
      onClick={onTap}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        borderRadius: 999,
        cursor: onTap ? 'pointer' : 'default',
        background: 'rgba(255,255,255,0.04)',
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span className="text-[12px]" style={{ color: 'var(--gia-text)' }}>{label}</span>
    </div>
  );
}
