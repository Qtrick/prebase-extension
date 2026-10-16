# PreBase

Local-first VS Code extension that shows a codebase as a **Network Graph**
(current architecture) and a **Temporal Graph** (how that architecture changed
across Git history).

## Commands

- **PreBase: Open PreBase**: open the graph panel

## Requirements

- VS Code 1.93+ or a compatible host (Cursor)
- A local workspace folder (virtual workspaces are not supported)
- For Temporal Graph: a Git repository with readable commit history

## Privacy

Analysis runs locally. PreBase does not send repository source, Git history, or
graph data to a remote service.

## Notes

- Temporal exploration is read-only. It does not checkout, reset, stash, or
  modify branches, the index, or the working tree.
- The bundled `prebase-engine` binary is platform-specific. This package must be
  built on (or for) the target OS/architecture.
