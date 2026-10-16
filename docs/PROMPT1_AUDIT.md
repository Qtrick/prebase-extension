# Prompt 1 pre-implementation audit

## Current repository

- Empty git repo on `main` (no prior extension code).
- Implementation built greenfield per the stack plan doc and older `graphs/` research.

## Older Prebasecode (`graphs/`)

| Asset | Decision |
|-------|----------|
| `NodeKind` / `EdgeKind` / snapshot provenance concepts | **Reuse** as Rust+TS canonical contract |
| Canonical analyzer, parse workers, SHA caches | **Defer** — TypeScript analysis contradicts Rust ownership |
| Network layouts / normalization ideas | **Adapt** — deterministic layered layout in React presentation only |
| Temporal SQLite store, lineage, ingestion | **Defer** — keep shared domain + Temporal UI entry |
| Workbench host / Code OSS contrib | **Reject** — out of product boundary |
| GitHub webhooks / remote sync | **Reject** — MVP is local-first |

## Thinking Orbs

- Evaluated upstream README (MIT). Adapted a single canvas activity indicator.
- Not used as graph engine or per-node canvases.

## Critical gaps closed in Prompt 1

- No extension/webview/Rust existed → scaffolded end-to-end slice
- No IPC → versioned JSON-lines
- No design tokens → VS Code theme vars + Pro Max palette fallbacks

## Stable decisions (do not reopen without evidence)

1. Rust owns graph truth; TS is a thin bridge; React is presentation.
2. One canonical graph model for Network + Temporal.
3. Stdio JSON-lines protocol v1.
4. Fixture data must be explicit (`provenance: fixture`).
5. No Git mutations; no cloud/AI backend.
6. Single reusable webview panel (`prebase.open`).
