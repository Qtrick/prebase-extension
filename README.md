# PreBase

VS Code extension that maps a codebase as a **Network Graph** (current
architecture) and a **Temporal Graph** (how that architecture changed over Git
history). Local-first. No cloud, accounts, or AI runtime in the MVP.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

```
Webview (React) → Extension Host (TypeScript) → prebase-engine (Rust)
```

## Prerequisites

- Node.js 20+
- Rust stable (`cargo`)
- VS Code or Cursor (Extension Development Host)

## Setup

```bash
npm install
npm run build
```

This builds the Rust engine, copies it to `extension/bin/`, builds the React
webview into `extension/media/`, and compiles the extension TypeScript.

## Launch (development)

1. Copy launch config if needed:

   ```bash
   mkdir -p .vscode && cp vscode-config/launch.json .vscode/launch.json
   ```

2. Open this folder in VS Code/Cursor.
3. Run **Run PreBase Extension** (F5).
4. In the Extension Development Host: **PreBase: Open PreBase**.

## Package (VSIX)

```bash
npm run package
```

Produces `extension/prebase-0.1.0.vsix` (version from `extension/package.json`)
and inspects the archive for required runtime assets (`bin/prebase-engine`,
`media/`, compiled `out/`).

Install into a clean profile (example with Cursor CLI):

```bash
cursor --install-extension extension/prebase-0.1.0.vsix
```

The bundled engine binary is **platform-specific**. Build and package on each
target OS/architecture you intend to distribute.

## Tests

```bash
npm run test:rust
npm run test:extension
npm run test:webview
npm run typecheck
```

## Scope

- Network Graph from local repository analysis (Rust)
- Temporal Graph from read-only Git history (no checkout or mutation)
- Explicit IPC protocols between host, webview, and engine
