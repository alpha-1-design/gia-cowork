import { describe, it, expect } from 'vitest';
import { parseProbeOutput, PROBED_BINARIES } from '../CapabilityService';

describe('CapabilityService — probe output parsing', () => {
  it('parses binaries with and without versions', () => {
    const output = [
      'BIN|node|/usr/bin/node|v24.19.0',
      'BIN|git|/usr/bin/git|git version 2.43.0',
      'BIN|jq|/usr/bin/jq|',
      'BIN|ffmpeg|/usr/bin/ffmpeg|ffmpeg version 6.1.1-3ubuntu5',
      'PM|apt-get',
      'PM|apt',
      'ID=ubuntu',
      'ID_LIKE=debian',
      'PRETTY_NAME="Ubuntu 24.04 LTS"',
      'UNAME|Linux 6.8.0-31-generic x86_64',
      'PROBE_DONE',
    ].join('\n');

    const parsed = parseProbeOutput(output);
    expect(parsed.binaries).toHaveLength(4);
    expect(parsed.binaries[0]).toEqual({ name: 'node', path: '/usr/bin/node', version: 'v24.19.0' });
    expect(parsed.binaries[1]).toEqual({ name: 'git', path: '/usr/bin/git', version: 'git version 2.43.0' });
    expect(parsed.binaries[2]).toEqual({ name: 'jq', path: '/usr/bin/jq', version: '' });
    expect(parsed.packageManagers).toEqual(['apt-get', 'apt']);
    expect(parsed.distroId).toBe('ubuntu');
    expect(parsed.os).toContain('Ubuntu 24.04 LTS');
    expect(parsed.os).toContain('Linux 6.8.0-31-generic x86_64');
  });

  it('returns empty results for an empty probe', () => {
    const parsed = parseProbeOutput('');
    expect(parsed.binaries).toEqual([]);
    expect(parsed.packageManagers).toEqual([]);
    expect(parsed.os).toBe('');
    expect(parsed.distroId).toBe('');
  });

  it('ignores unrelated output lines', () => {
    const parsed = parseProbeOutput('random noise\nBIN|gh|/usr/bin/gh|gh version 2.100.0\nmore noise\n');
    expect(parsed.binaries).toHaveLength(1);
    expect(parsed.binaries[0].name).toBe('gh');
  });

  it('probes a non-empty, sensible binary list', () => {
    expect(PROBED_BINARIES.length).toBeGreaterThan(10);
    expect(PROBED_BINARIES).toContain('node');
    expect(PROBED_BINARIES).toContain('python3');
    expect(PROBED_BINARIES).toContain('git');
    expect(PROBED_BINARIES).toContain('ffmpeg');
  });
});