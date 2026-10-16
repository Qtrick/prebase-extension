# PreBase Architecture (Prompt 1–2)

PreBase is a VS Code desktop extension for **Network Graph** and **Temporal Graph** visualization. It is not an editor fork, AI agent, or cloud product.

## Layers

```
React Webview  --postMessage-->  TypeScript Extension Host  --JSON-lines stdio-->  Rust Engine
     ^                                      |                                         |
     |                                      |                                         |
 presentation / interaction          lifecycle, validation,                   canonical graph,
                                     process management                       analysis truth
```

| Layer | Owns | Must not |
|-------|------|----------|
| **Rust (`prebase-engine`)** | Discovery, Tree-sitter extract, resolve, canonical graph, process cache | Depend on VS Code or React |
| **TypeScript extension** | Activation, commands, webview panel, engine process, message validation | Reconstruct graph semantics |
| **React webview** | Projection, layout, selection, search/filter, loading/error UI | Read repo/Git/SQLite |

## Canonical graph

Defined in `crates/prebase-engine/src/domain.rs` and mirrored in `shared/protocol/src/index.ts`.

- Stable IDs: file nodes `file:<workspace-relative-path>`; edge IDs derived from endpoints + kind + specifier
- `GraphProvenance`: `fixture` \| `repository` (default path is repository analysis)
- Coverage stats: discovered/analyzed/unsupported, resolved/unresolved/external/ambiguous, parse failures
- Edges carry `evidence`, `resolution` (`resolved` \| `unresolved` \| `external` \| `ambiguous`)
- Network and Temporal share this model; Temporal is not implemented yet

## Analysis pipeline (Prompt 2)

```
workspace root → discover (ignores, bounds) → language id → Tree-sitter extract
  → resolve imports → two-pass graph build → validate → DTO over IPC
```

Supported today: TypeScript/TSX imports (primary); light Rust `mod`/`use`. Unsupported files counted, not fabricated into edges. Package imports stay `external`.

## Protocol

Versioned JSON-lines over stdio (`PROTOCOL_VERSION = 1`).

- Methods: `initialize`, `getNetworkGraph`, `ping`, `shutdown`
- `getNetworkGraph` params: `workspacePath`, `preferFixture` (default **false**)
- stdout = protocol only; stderr = diagnostics
- Request/response correlated by `id`; stale responses discarded in the host client

## Workspace policy (MVP)

Use the **first** workspace folder. Multi-root picker deferred.

## Workspace Trust

Analysis is read-only filesystem + parse. No repository scripts, package lifecycle hooks, or Git mutation. Restricted Mode should still allow open/analyze; never execute untrusted code.

## Incremental refresh (Prompt 3)

- **Watcher:** VS Code `WorkspaceGraphWatcher` (debounced RelativePattern).
- **Rust:** content-hash parse cache + graph revision cache; `forceRefresh` clears caches.
- **Host:** `graphRequestSeq` + quiet `updating_graph` status; dispose watcher with panel.

## Temporal Graph (Prompt 4)

- **Git:** `gix` first-parent enumeration; tree/blob reads (no checkout).
- **Analyze:** shared `sources::analyze_sources` on historical bytes; provenance `historical`.
- **Persist:** SQLite under extension storage (`temporal/<workspace-hash>/`), content-addressed digests.
- **IPC:** `listTemporalHistory`, `indexTemporalHistory`, `getTemporalSnapshot`, `compareTemporalSnapshots`.
- **UI:** timeline, snapshot graph, two-point compare with added/removed highlighting.

## Prompt status

| Done (Prompt 1–4) | Deferred (Prompt 5+) |
|-------------------|----------------------|
| Network Graph + incremental refresh | Broader languages / path aliases |
| Temporal snapshots + deltas + UI | Multi-root picker |
| SQLite temporal store (extension storage) | Full-history / all-branch indexing |
| Fixture only when requested | Packaging / marketplace polish |

## Run

```bash
npm install
npm run build
# Then: Run and Debug → "Run PreBase Extension" (see vscode-config/launch.json)
```

Copy `vscode-config/launch.json` to `.vscode/launch.json` if your environment allows.

See also: `docs/PROMPT2_VERIFICATION.md`.
