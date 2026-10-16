#!/usr/bin/env node
/**
 * Inspect a PreBase VSIX and fail if required runtime assets are missing.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  evaluateVsixEntries,
  forbiddenPatterns,
  requiredPatterns,
} from './vsixInspectPolicy.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionDir = join(root, 'extension');

function findVsix() {
  const arg = process.argv[2];
  if (arg) return arg.startsWith('/') ? arg : join(process.cwd(), arg);
  const files = readdirSync(extensionDir)
    .filter((f) => f.endsWith('.vsix'))
    .map((f) => ({ f, m: statSync(join(extensionDir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (files.length === 0) {
    throw new Error('No .vsix found in extension/. Pass a path as the first argument.');
  }
  return join(extensionDir, files[0].f);
}

function listZip(vsixPath) {
  const out = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

const vsix = findVsix();
if (!existsSync(vsix)) {
  console.error(`Missing VSIX: ${vsix}`);
  process.exit(1);
}

const entries = listZip(vsix);
const size = statSync(vsix).size;
console.log(`VSIX: ${vsix}`);
console.log(`Size: ${(size / (1024 * 1024)).toFixed(1)} MiB`);
console.log(`Entries: ${entries.length}`);

const evaluation = evaluateVsixEntries(entries);
let failed = !evaluation.ok;
for (const pattern of requiredPatterns) {
  const hit = entries.some((e) => pattern.test(e));
  if (!hit) {
    console.error(`MISSING required: ${pattern}`);
  } else {
    console.log(`OK required: ${pattern}`);
  }
}

for (const pattern of forbiddenPatterns) {
  const hits = entries.filter((e) => pattern.test(e));
  if (hits.length) {
    console.error(`FORBIDDEN present (${pattern}):`);
    for (const h of hits.slice(0, 20)) console.error(`  ${h}`);
  }
}

const engine = entries.find((e) => /\/bin\/prebase-engine(\.exe)?$/.test(e));
if (engine) {
  // Check unix executable bit via unzip -Z
  try {
    const info = execFileSync('unzip', ['-Z', vsix, engine], { encoding: 'utf8' });
    console.log(`Engine entry meta:\n${info.trim()}`);
    if (!engine.endsWith('.exe') && !/\-rwx/.test(info) && !/unsuffix/.test(info)) {
      // unzip -Z long listing often shows permissions like -rwxr-xr-x
      if (!/rwx/.test(info)) {
        console.warn('WARN: engine may lack executable permission bits in the archive');
      }
    }
  } catch {
    console.warn('WARN: could not read engine zip metadata');
  }
}

console.log('\nSample entries:');
for (const e of entries.slice(0, 40)) console.log(`  ${e}`);
if (entries.length > 40) console.log(`  ... +${entries.length - 40} more`);

if (failed) {
  console.error('\nVSIX inspection FAILED');
  process.exit(1);
}
console.log('\nVSIX inspection PASSED');
