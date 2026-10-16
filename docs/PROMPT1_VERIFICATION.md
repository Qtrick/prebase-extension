# Prompt 1 verification notes

## Commands run (all passed)

```bash
CARGO_TARGET_DIR=target cargo test -p prebase-engine   # 9 passed
npm run test:extension                                 # 20 passed
npm run test:webview                                   # 8 passed
npm run typecheck
npm run build:engine:debug
npm run build:webview
npm run build:extension
```

Engine stdio smoke: `initialize` → `getNetworkGraph` → `shutdown` over `./extension/bin/prebase-engine`.

## Live UI inspection

Launched Vite webview preview (`npm run dev -w webview`) and inspected via browser automation:

- Loading state with Thinking Orb activity indicator
- Fixture Network Graph render (nodes/edges, kind shapes)
- Node selection via keyboard-accessible combobox + inspector metadata
- Temporal entry point (honest “Not available in Prompt 1”)
- Duplicate fixture messaging removed after visual review

Screenshots: `docs/screenshots/network-selected.png`, `docs/screenshots/temporal-entry.png`.

## Extension Development Host

Launch config is in `vscode-config/launch.json` (copy to `.vscode/` if needed). Full F5 Extension Host launch was not automated in this environment; engine + webview + IPC were verified independently.
