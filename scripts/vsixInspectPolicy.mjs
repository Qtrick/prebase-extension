/**
 * Shared VSIX packaging policy for inspect-vsix and unit tests.
 * Paths are zip entries as produced by `unzip -Z1` (forward slashes).
 */

export const requiredPatterns = [
  /^extension\/package\.json$/,
  /^extension\/out\/extension\/src\/extension\.js$/,
  /^extension\/media\/webview\.js$/,
  /^extension\/media\/webview\.css$/,
  /^extension\/bin\/prebase-engine(\.exe)?$/,
  /^extension\/LICENSE\.txt$/,
  /^extension\/NOTICE\.md$/,
];

export const forbiddenPatterns = [
  /^extension\/src\//,
  /node_modules/,
  /\.env/,
  /credentials/i,
  /id_rsa/,
  /\.pem$/,
  /\.map$/,
  /\.d\.ts$/,
  /\.test\.js$/,
  /\.git\//,
  /\/target\//,
  /\/crates\//,
  /Cargo\.(toml|lock)$/,
];

/**
 * @param {string[]} entries
 * @returns {{ ok: boolean, missing: string[], forbidden: Array<{ pattern: string, hits: string[] }> }}
 */
export function evaluateVsixEntries(entries) {
  const missing = [];
  for (const pattern of requiredPatterns) {
    if (!entries.some((e) => pattern.test(e))) {
      missing.push(String(pattern));
    }
  }

  const forbidden = [];
  for (const pattern of forbiddenPatterns) {
    const hits = entries.filter((e) => pattern.test(e));
    if (hits.length) {
      forbidden.push({ pattern: String(pattern), hits });
    }
  }

  return {
    ok: missing.length === 0 && forbidden.length === 0,
    missing,
    forbidden,
  };
}
