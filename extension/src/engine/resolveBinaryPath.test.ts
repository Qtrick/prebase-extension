import { chmodSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { EngineClient, EngineClientError } from './EngineClient';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('resolveBinaryPath packaging', () => {
  it('prefers extension/bin over sibling target/', () => {
    const root = join(tmpdir(), `prebase-bin-${Date.now()}`);
    dirs.push(root);
    const ext = join(root, 'extension');
    mkdirSync(join(ext, 'bin'), { recursive: true });
    mkdirSync(join(root, 'target', 'release'), { recursive: true });
    const name = process.platform === 'win32' ? 'prebase-engine.exe' : 'prebase-engine';
    const packaged = join(ext, 'bin', name);
    const release = join(root, 'target', 'release', name);
    writeFileSync(packaged, '#!/bin/sh\n');
    writeFileSync(release, '#!/bin/sh\n');
    if (process.platform !== 'win32') {
      chmodSync(packaged, 0o755);
      chmodSync(release, 0o755);
    }
    const client = new EngineClient(ext, () => undefined);
    expect(client.resolveBinaryPath()).toBe(packaged);
  });

  it('rejects a non-executable unix binary', () => {
    if (process.platform === 'win32') return;
    const ext = join(tmpdir(), `prebase-nox-${Date.now()}`);
    dirs.push(ext);
    mkdirSync(join(ext, 'bin'), { recursive: true });
    const path = join(ext, 'bin', 'prebase-engine');
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o644);
    const client = new EngineClient(ext, () => undefined);
    expect(() => client.resolveBinaryPath()).toThrow(EngineClientError);
    expect(() => client.resolveBinaryPath()).toThrow(/not executable/);
  });
});
