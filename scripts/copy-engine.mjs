import { copyFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const debug = process.argv.includes('--debug');
const profile = debug ? 'debug' : 'release';
const binaryName = process.platform === 'win32' ? 'prebase-engine.exe' : 'prebase-engine';
const src = join(root, 'target', profile, binaryName);
const destDir = join(root, 'extension', 'bin');
const dest = join(destDir, binaryName);

if (!existsSync(src)) {
  console.error(`Engine binary not found at ${src}. Run cargo build first.`);
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
if (process.platform !== 'win32') {
  chmodSync(dest, 0o755);
}
console.log(`Copied ${src} -> ${dest}`);
