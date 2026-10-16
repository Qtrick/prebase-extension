import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  evaluateVsixEntries,
  forbiddenPatterns,
  requiredPatterns,
} from '../../../scripts/vsixInspectPolicy.mjs';

/** Minimal compliant VSIX layout (synthetic — no real archive required). */
const COMPLIANT_ENTRIES = [
  'extension/package.json',
  'extension/out/extension/src/extension.js',
  'extension/media/webview.js',
  'extension/media/webview.css',
  'extension/bin/prebase-engine',
  'extension/LICENSE.txt',
  'extension/NOTICE.md',
  'extension/readme.md',
];

describe('VSIX packaging policy', () => {
  it('documents required runtime asset patterns', () => {
    expect(requiredPatterns.length).toBeGreaterThanOrEqual(7);
    expect(forbiddenPatterns.length).toBeGreaterThanOrEqual(4);
  });

  it('accepts a minimal compliant entry list', () => {
    const result = evaluateVsixEntries(COMPLIANT_ENTRIES);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.forbidden).toEqual([]);
  });

  it('accepts Windows engine binary name', () => {
    const entries = COMPLIANT_ENTRIES.map((e) =>
      e.endsWith('prebase-engine') ? 'extension/bin/prebase-engine.exe' : e,
    );
    expect(evaluateVsixEntries(entries).ok).toBe(true);
  });

  it('fails when packaged engine binary is missing', () => {
    const entries = COMPLIANT_ENTRIES.filter((e) => !e.includes('/bin/'));
    const result = evaluateVsixEntries(entries);
    expect(result.ok).toBe(false);
    expect(result.missing.some((p) => p.includes('prebase-engine'))).toBe(true);
  });

  it('fails when any single required runtime entry is missing', () => {
    for (const pattern of requiredPatterns) {
      const entries = COMPLIANT_ENTRIES.filter((e) => !pattern.test(e));
      const result = evaluateVsixEntries(entries);
      expect(result.ok, String(pattern)).toBe(false);
      expect(result.missing, String(pattern)).toContain(String(pattern));
    }
  });

  it('reports every required pattern missing for an empty archive', () => {
    const result = evaluateVsixEntries([]);
    expect(result.ok).toBe(false);
    expect(result.missing).toHaveLength(requiredPatterns.length);
    expect(result.forbidden).toEqual([]);
  });

  it('fails when TypeScript sources leak into the VSIX', () => {
    const result = evaluateVsixEntries([
      ...COMPLIANT_ENTRIES,
      'extension/src/extension.ts',
    ]);
    expect(result.ok).toBe(false);
    expect(result.forbidden.some((f) => f.hits.includes('extension/src/extension.ts'))).toBe(
      true,
    );
  });

  it('fails when secrets or node_modules are packaged', () => {
    for (const bad of [
      'extension/.env',
      'extension/node_modules/lodash/index.js',
      'extension/secrets/credentials.json',
      'extension/keys/id_rsa',
      'extension/certs/dev.pem',
    ]) {
      const result = evaluateVsixEntries([...COMPLIANT_ENTRIES, bad]);
      expect(result.ok, bad).toBe(false);
      expect(result.forbidden.length, bad).toBeGreaterThan(0);
    }
  });

  it('fails when source maps, declarations, or compiled tests are packaged', () => {
    for (const bad of [
      'extension/out/extension/src/extension.js.map',
      'extension/out/extension/src/extension.d.ts',
      'extension/out/extension/src/engine/EngineClient.test.js',
    ]) {
      const result = evaluateVsixEntries([...COMPLIANT_ENTRIES, bad]);
      expect(result.ok, bad).toBe(false);
      expect(result.forbidden.length, bad).toBeGreaterThan(0);
    }
  });

  it('keeps a deny-all vscodeignore allowlist for packaged runtime assets', () => {
    const ignore = readFileSync(join(__dirname, '../../.vscodeignore'), 'utf8');
    for (const line of [
      '**/*',
      '../**',
      '!out/**',
      '!media/**',
      '!bin/**',
      '!package.json',
      '!LICENSE.txt',
      '!NOTICE.md',
      'out/**/*.map',
      'out/**/*.d.ts',
    ]) {
      expect(ignore.includes(line), line).toBe(true);
    }
  });
});
