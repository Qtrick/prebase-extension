//! Read-only Git history access via gix (no checkout, no working-tree mutation).

use std::path::{Path, PathBuf};

use gix::bstr::ByteSlice;
use gix::object::tree::EntryKind;
use serde::{Deserialize, Serialize};

use crate::discover::{is_supported_extension, language_for_extension, resolve_workspace_root};

const SKIP_DIR_NAMES: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".next",
    ".turbo",
    "coverage",
    ".cache",
    "__pycache__",
    ".venv",
    "venv",
    "vendor",
];

const MAX_BLOB_BYTES: usize = 1_500_000;
pub const DEFAULT_HISTORY_LIMIT: u32 = 40;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub oid: String,
    pub parents: Vec<String>,
    pub summary: String,
    pub author: String,
    pub time_seconds: i64,
}

#[derive(Debug, Clone)]
pub struct HistoricalFile {
    pub relative_posix: String,
    pub bytes: Vec<u8>,
    pub blob_oid: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoCapabilities {
    pub is_git_repo: bool,
    pub head_oid: Option<String>,
    pub is_shallow: bool,
    pub commit_count_hint: Option<u32>,
}

pub fn open_repo(workspace_path: &Path) -> Result<gix::Repository, String> {
    gix::discover(workspace_path).map_err(|e| format!("Not a Git repository: {e}"))
}

pub fn repo_capabilities(workspace_path: &Path) -> Result<RepoCapabilities, String> {
    let repo = match gix::discover(workspace_path) {
        Ok(r) => r,
        Err(_) => {
            return Ok(RepoCapabilities {
                is_git_repo: false,
                head_oid: None,
                is_shallow: false,
                commit_count_hint: None,
            });
        }
    };
    let head_oid = repo.head_id().ok().map(|id| id.to_string());
    let is_shallow = repo.is_shallow();
    Ok(RepoCapabilities {
        is_git_repo: true,
        head_oid,
        is_shallow,
        commit_count_hint: None,
    })
}

/// First-parent ancestry from HEAD, newest first, bounded by `limit`.
pub fn list_first_parent_commits(
    workspace_path: &Path,
    limit: u32,
) -> Result<Vec<CommitInfo>, String> {
    let repo = open_repo(workspace_path)?;
    let head = repo.head_id().map_err(|e| format!("No HEAD commit: {e}"))?;

    let mut out = Vec::new();
    let mut current = Some(head.detach());
    let limit = limit.max(1) as usize;

    while let Some(oid) = current {
        if out.len() >= limit {
            break;
        }
        let commit = repo
            .find_commit(oid)
            .map_err(|e| format!("Missing commit {oid}: {e}"))?;
        let parents: Vec<String> = commit.parent_ids().map(|p| p.to_string()).collect();
        let message = commit.message_raw_sloppy();
        let summary = message
            .to_str()
            .ok()
            .and_then(|m| m.lines().next())
            .unwrap_or("")
            .trim()
            .to_string();
        let author = commit
            .author()
            .map(|a| a.name.to_string())
            .unwrap_or_else(|_| "unknown".into());
        let time_seconds = commit.time().map(|t| t.seconds).unwrap_or(0);

        out.push(CommitInfo {
            oid: oid.to_string(),
            parents: parents.clone(),
            summary,
            author,
            time_seconds,
        });

        // First-parent timeline for MVP clarity.
        current = commit.parent_ids().next().map(|id| id.detach());
    }

    Ok(out)
}

/// Load supported source files from the commit tree (Git objects only).
pub fn load_historical_sources(
    workspace_path: &Path,
    commit_oid: &str,
) -> Result<(Vec<HistoricalFile>, u32, u32), String> {
    let repo = open_repo(workspace_path)?;
    let oid = repo
        .rev_parse_single(commit_oid.as_bytes())
        .map_err(|e| format!("Unknown commit {commit_oid}: {e}"))?
        .detach();
    let commit = repo
        .find_commit(oid)
        .map_err(|e| format!("Cannot read commit {commit_oid}: {e}"))?;
    let tree = commit
        .tree()
        .map_err(|e| format!("Missing tree for {commit_oid}: {e}"))?;

    let mut files = Vec::new();
    let mut unsupported = 0u32;
    let mut excluded = 0u32;
    walk_tree(
        &repo,
        &tree,
        "",
        &mut files,
        &mut unsupported,
        &mut excluded,
    )?;
    files.sort_by(|a, b| a.relative_posix.cmp(&b.relative_posix));
    Ok((files, unsupported, excluded))
}

fn walk_tree(
    repo: &gix::Repository,
    tree: &gix::Tree<'_>,
    prefix: &str,
    files: &mut Vec<HistoricalFile>,
    unsupported: &mut u32,
    excluded: &mut u32,
) -> Result<(), String> {
    let mut entries: Vec<_> = tree
        .iter()
        .map(|e| e.map_err(|err| format!("Tree decode error: {err}")))
        .collect::<Result<Vec<_>, _>>()?;
    entries.sort_by(|a, b| a.filename().cmp(b.filename()));

    for entry in entries {
        let name = entry.filename().to_string();
        let rel = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };

        match entry.mode().kind() {
            EntryKind::Tree => {
                if should_skip_dir(&name) {
                    *excluded += 1;
                    continue;
                }
                let subtree = repo
                    .find_tree(entry.id())
                    .map_err(|e| format!("Missing subtree {rel}: {e}"))?;
                walk_tree(repo, &subtree, &rel, files, unsupported, excluded)?;
            }
            EntryKind::Blob | EntryKind::BlobExecutable => {
                let ext = Path::new(&name)
                    .extension()
                    .and_then(|e| e.to_str())
                    .unwrap_or("");
                if !is_supported_extension(ext) {
                    *unsupported += 1;
                    continue;
                }
                let blob = repo
                    .find_blob(entry.id())
                    .map_err(|e| format!("Missing blob {rel}: {e}"))?;
                let data = blob.data.clone();
                if data.len() > MAX_BLOB_BYTES {
                    *excluded += 1;
                    continue;
                }
                let _ = language_for_extension(ext);
                files.push(HistoricalFile {
                    relative_posix: rel,
                    bytes: data,
                    blob_oid: entry.id().to_string(),
                });
            }
            EntryKind::Link | EntryKind::Commit => {
                *excluded += 1;
            }
        }
    }
    Ok(())
}

fn should_skip_dir(name: &str) -> bool {
    SKIP_DIR_NAMES.iter().any(|d| *d == name) || (name.starts_with('.') && name != ".")
}

/// Resolve workspace path to a PathBuf for Git discovery.
pub fn workspace_path(path: &str) -> Result<PathBuf, String> {
    resolve_workspace_root(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::tempdir;

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "PreBase")
            .env("GIT_AUTHOR_EMAIL", "prebase@test")
            .env("GIT_COMMITTER_NAME", "PreBase")
            .env("GIT_COMMITTER_EMAIL", "prebase@test")
            .status()
            .expect("git");
        assert!(status.success(), "git {args:?} failed");
    }

    #[test]
    fn lists_commits_and_reads_historical_blob_not_working_tree() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "t@t"]);
        git(root, &["config", "user.name", "t"]);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "initial"]);

        let commits = list_first_parent_commits(root, 10).unwrap();
        assert_eq!(commits.len(), 1);
        let oid = commits[0].oid.clone();

        // Mutate working tree without committing — historical read must stay old.
        fs::write(root.join("src/a.ts"), "export const a = 999;\n").unwrap();
        let (files, _, _) = load_historical_sources(root, &oid).unwrap();
        let a = files
            .iter()
            .find(|f| f.relative_posix == "src/a.ts")
            .unwrap();
        assert_eq!(
            std::str::from_utf8(&a.bytes).unwrap(),
            "export const a = 1;\n"
        );
    }

    #[test]
    fn first_parent_history_omits_merged_side_branch_commits() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        git(root, &["init"]);
        git(root, &["config", "user.email", "t@t"]);
        git(root, &["config", "user.name", "t"]);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.ts"), "export const main = 1;\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "main: initial"]);

        git(root, &["checkout", "-b", "feature"]);
        fs::write(root.join("src/feature.ts"), "export const feature = 1;\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "feature-only: side branch"]);

        git(root, &["checkout", "main"]);
        fs::write(root.join("src/main.ts"), "export const main = 2;\n").unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "main: advance tip"]);
        git(
            root,
            &[
                "merge",
                "--no-ff",
                "feature",
                "-m",
                "Merge branch 'feature'",
            ],
        );

        let commits = list_first_parent_commits(root, 20).unwrap();
        let summaries: Vec<&str> = commits.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(commits.len(), 3);
        assert!(summaries.iter().any(|s| s.contains("main: initial")));
        assert!(summaries.iter().any(|s| s.contains("main: advance tip")));
        assert!(
            summaries.iter().any(|s| s.contains("Merge")),
            "expected merge commit subject, got: {summaries:?}"
        );
        assert!(
            !summaries
                .iter()
                .any(|s| s.contains("feature-only: side branch")),
            "first-parent walk must not include the merged branch tip"
        );
    }
}
