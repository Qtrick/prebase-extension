import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Pure policy helpers mirrored from PreBasePanel bootstrap rules.
 * Kept free of vscode imports so vitest can run in Node.
 */
export function isAnalyzableWorkspaceUri(scheme: string): boolean {
  return scheme === 'file';
}

describe('workspace policy', () => {
  it('allows local file workspaces', () => {
    expect(isAnalyzableWorkspaceUri('file')).toBe(true);
  });

  it('rejects virtual schemes', () => {
    expect(isAnalyzableWorkspaceUri('vscode-vfs')).toBe(false);
    expect(isAnalyzableWorkspaceUri('untitled')).toBe(false);
  });

  it('declares Workspace Trust and virtual workspace capabilities in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '../../package.json'), 'utf8'),
    ) as {
      capabilities: {
        untrustedWorkspaces: { supported: boolean };
        virtualWorkspaces: { supported: boolean };
      };
    };
    expect(pkg.capabilities.untrustedWorkspaces.supported).toBe(true);
    expect(pkg.capabilities.virtualWorkspaces.supported).toBe(false);
  });

  it('keeps a restrictive webview CSP in PreBasePanel', () => {
    const src = readFileSync(join(__dirname, 'PreBasePanel.ts'), 'utf8');
    expect(src).toContain(`default-src 'none'`);
    expect(src).toContain(`connect-src 'none'`);
    expect(src).toContain(`worker-src 'none'`);
    expect(src).toContain(`script-src 'nonce-\${nonce}' \${webview.cspSource}`);
    expect(src).toContain('localResourceRoots: [vscode.Uri.joinPath(extensionUri, \'media\')]');
  });
});
