# Prompt 4 Verification

Date: 2026-10-16

## Scope

Temporal Graph MVP: gix read-only history, shared analyzer on historical trees, deterministic digests, SQLite snapshots (extension storage), graph deltas, timeline + compare UI. No checkout / no Git mutation.

## Historical semantics

A snapshot = architecture graph reconstructed from the **Git tree at a commit OID**, using analyzer version 4. Provenance `historical`. First-parent timeline (merge side branches not in default list; parents preserved on commits). Working-tree edits do not affect historical blob reads.

## Live experiment (controlled repo)

| Metric | Value |
|--------|-------|
| Commits | 3 (A billing edge → B +notifications → C remove billing) |
| Snapshots complete | 3 |
| Unique digests | 3 |
| Index duration | ~171 ms |
| Compare A→C | +1/−0 nodes, +1/−1 edges, unchanged=false |
| Oldest snapshot | provenance=historical, 2 nodes, 1 edge |
| HEAD unchanged | yes |
| Source file unchanged | yes |
| `git status` clean (store outside repo) | yes |

This PreBase workspace has **no Git commits yet**, so self-index correctly reports no HEAD.

## Automated tests

| Suite | Result |
|-------|--------|
| Rust | **47 passed** |
| Extension | **30 passed** |
| Webview | **26 passed** |
| Typecheck / builds | **passed** |

## UI

Vite preview Temporal tab: History panel, Index history, Compare controls, empty-state copy. Screenshot: `docs/screenshots/prompt4-temporal.png`.

## Subagents

- code-reviewer-editor: first-parent walk, digest versioning, SQLite WAL/path checks, per-workspace storage, compare removed-node overlay.
- test-writer: merge first-parent, incomplete≠complete, incompatible compare, validate temporal messages, timeline/index UI test.
