import { describe, it, expect, beforeEach } from 'vitest';
import { projectMemoryTools } from '../tools/projectMemory';
import { useProjectMemoryStore } from '../ProjectMemory';
import { useProjectContextStore } from '../../store/useProjectContextStore';

const [projectMemory, projectMemoryList, projectMemoryForget] = projectMemoryTools;

function reset() {
  useProjectMemoryStore.setState({ entries: [] });
  useProjectContextStore.setState({ entry: null });
}

describe('project_memory tool', () => {
  beforeEach(reset);

  it('records a note against the default project', async () => {
    const res = await projectMemory.execute({
      kind: 'gotcha', title: 'Relay is HTTP only',
      body: 'The dev relay does not speak websockets, so do not swap it without reading relay/index.js.',
    });
    expect(res.success).toBe(true);

    const entries = useProjectMemoryStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe('gotcha');
    expect(entries[0].project).toBe('current');
  });

  it('files notes under the project /init recorded', async () => {
    useProjectContextStore.setState({
      entry: { path: '/x/AGENTS.md', projectName: 'gia-cowork', markdown: '#', updatedAt: 1 },
    });
    await projectMemory.execute({
      kind: 'decision', title: 'Polling', body: 'The relay only supports HTTP, so we poll.',
    });
    expect(useProjectMemoryStore.getState().entries[0].project).toBe('gia-cowork');
  });

  it('keeps two projects apart', async () => {
    useProjectContextStore.setState({
      entry: { path: '/x/AGENTS.md', projectName: 'a', markdown: '#', updatedAt: 1 },
    });
    await projectMemory.execute({ kind: 'gotcha', title: 'in a', body: 'a-specific gotcha here.' });
    await projectMemory.execute({ kind: 'gotcha', title: 'in b', body: 'b-specific gotcha here.', project: 'b' });

    const list = await projectMemoryList.execute({ project: 'a' });
    expect(list.content).toContain('in a');
    expect(list.content).not.toContain('in b');
  });

  it('rejects a title that is too short to be useful', async () => {
    const res = await projectMemory.execute({ kind: 'gotcha', title: 'x', body: 'A body long enough to pass.' });
    expect(res.success).toBe(false);
  });

  it('rejects a body that is too short to be useful', async () => {
    const res = await projectMemory.execute({ kind: 'gotcha', title: 'A valid title', body: 'short' });
    expect(res.success).toBe(false);
  });
});

describe('project_memory_list tool', () => {
  beforeEach(async () => {
    reset();
    await projectMemory.execute({ kind: 'gotcha', title: 'Relay is HTTP', body: 'It does not speak websockets at all.' });
    await projectMemory.execute({ kind: 'decision', title: 'Chose polling', body: 'Because the bridge has no streaming endpoint.' });
    await projectMemory.execute({ kind: 'todo', title: 'Parked the rewrite', body: 'Revisit once the relay supports sockets.' });
  });

  it('lists everything for the project', async () => {
    const res = await projectMemoryList.execute({ project: 'current' });
    expect(res.success).toBe(true);
    expect(res.content).toContain('Relay is HTTP');
    expect(res.content).toContain('Chose polling');
    expect(res.content).toContain('Parked the rewrite');
  });

  it('filters by kind', async () => {
    const res = await projectMemoryList.execute({ project: 'current', kind: 'gotcha' });
    expect(res.content).toContain('Relay is HTTP');
    expect(res.content).not.toContain('Chose polling');
  });

  it('filters by free text across title and body', async () => {
    // "websockets" only appears in the gotcha, not the other two entries.
    const byBody = await projectMemoryList.execute({ project: 'current', query: 'websockets' });
    expect(byBody.content).toContain('Relay is HTTP');
    expect(byBody.content).not.toContain('Chose polling');
    expect(byBody.content).not.toContain('Parked the rewrite');
  });

  it('says so when nothing matches instead of returning an empty list', async () => {
    const res = await projectMemoryList.execute({ project: 'current', query: 'zzzznothing' });
    expect(res.success).toBe(true);
    expect(res.content).toMatch(/No notes recorded/);
  });
});

describe('project_memory_forget tool', () => {
  beforeEach(async () => {
    reset();
    await projectMemory.execute({ kind: 'gotcha', title: 'Stale note', body: 'This turned out to be wrong entirely.' });
  });

  it('deletes by exact title', async () => {
    const res = await projectMemoryForget.execute({ project: 'current', title: 'Stale note' });
    expect(res.success).toBe(true);
    expect(useProjectMemoryStore.getState().entries).toHaveLength(0);
  });

  it('refuses when there is no match rather than deleting something else', async () => {
    // Deleting the wrong note is worse than not deleting.
    const res = await projectMemoryForget.execute({ project: 'current', title: 'Nonexistent note' });
    expect(res.success).toBe(false);
    expect(useProjectMemoryStore.getState().entries).toHaveLength(1);
  });

  it('cannot delete a note belonging to another project', async () => {
    await projectMemory.execute({ kind: 'gotcha', title: 'Other project note', body: 'Belongs somewhere else.', project: 'other' });
    const res = await projectMemoryForget.execute({ project: 'current', title: 'Other project note' });
    expect(res.success).toBe(false);
    expect(useProjectMemoryStore.getState().entries).toHaveLength(2);
  });
});