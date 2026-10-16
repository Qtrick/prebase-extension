//! Temporal indexing: historical analysis → digests → SQLite snapshots → deltas.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::delta::{diff_graphs, GraphDelta};
use crate::digest::graph_digest;
use crate::domain::{CanonicalGraph, GraphProvenance, ANALYZER_VERSION, TEMPORAL_SCHEMA_VERSION};
use crate::git::{
    list_first_parent_commits, load_historical_sources, repo_capabilities, workspace_path,
    CommitInfo, DEFAULT_HISTORY_LIMIT,
};
use crate::sources::{analyze_sources, AnalyzeSourcesOpts, SourceFile};
use crate::store::{resolve_storage_dir, SnapshotStatus, TemporalStore};

fn parse_commit_oid(oid: &str) -> Result<String, String> {
    let trimmed = oid.trim();
    // Align with extension host validation: abbreviated SHA-1 through full SHA-256.
    if trimmed.len() < 7 || trimmed.len() > 64 {
        return Err("commitOid must be 7-64 hex characters".into());
    }
    if !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("commitOid must be hexadecimal".into());
    }
    Ok(trimmed.to_ascii_lowercase())
}

fn open_store(storage_dir: &str) -> Result<TemporalStore, String> {
    TemporalStore::open(&resolve_storage_dir(storage_dir)?)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub commit: CommitInfo,
    pub status: String,
    pub digest: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexResult {
    pub commits_enumerated: u32,
    pub snapshots_complete: u32,
    pub snapshots_failed: u32,
    pub unique_digests: u32,
    pub duration_ms: u64,
    pub is_shallow: bool,
    pub timeline: Vec<TimelineEntry>,
    pub analyzer_version: u32,
    pub temporal_schema_version: u32,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResult {
    pub commit: CommitInfo,
    pub digest: String,
    pub graph: CanonicalGraph,
    pub status: String,
}

pub fn list_timeline(
    workspace: &str,
    storage_dir: &str,
    limit: Option<u32>,
) -> Result<(Vec<TimelineEntry>, bool), String> {
    let root = workspace_path(workspace)?;
    let caps = repo_capabilities(&root)?;
    if !caps.is_git_repo {
        return Err("No Git repository found for this workspace".into());
    }
    let limit = limit.unwrap_or(DEFAULT_HISTORY_LIMIT);
    let commits = list_first_parent_commits(&root, limit)?;
    let store = open_store(storage_dir)?;
    let mut timeline = Vec::new();
    for c in commits {
        let status = store.snapshot_status(&c.oid)?;
        let (status_s, digest, error) = match status {
            Some(SnapshotStatus::Complete) => {
                if let Some((d, _)) = store.get_complete_snapshot(&c.oid)? {
                    ("complete".into(), Some(d), None)
                } else {
                    (
                        "incomplete".into(),
                        None,
                        Some("snapshot marked complete but data is missing or stale".into()),
                    )
                }
            }
            Some(SnapshotStatus::Failed) => ("failed".into(), None, Some("analysis failed".into())),
            Some(SnapshotStatus::Incomplete) => ("incomplete".into(), None, None),
            None => ("pending".into(), None, None),
        };
        timeline.push(TimelineEntry {
            commit: c,
            status: status_s,
            digest,
            error,
        });
    }
    Ok((timeline, caps.is_shallow))
}

pub fn index_history(
    workspace: &str,
    storage_dir: &str,
    limit: Option<u32>,
) -> Result<IndexResult, String> {
    let started = std::time::Instant::now();
    let root = workspace_path(workspace)?;
    let caps = repo_capabilities(&root)?;
    if !caps.is_git_repo {
        return Err("No Git repository found for this workspace".into());
    }
    let limit = limit.unwrap_or(DEFAULT_HISTORY_LIMIT);
    let commits = list_first_parent_commits(&root, limit)?;
    let mut store = open_store(storage_dir)?;

    let mut complete = 0u32;
    let mut failed = 0u32;
    let mut digests = std::collections::BTreeSet::new();
    let project_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();
    // Index oldest→newest so failures don't block later navigation of older snapshots.
    let ordered: Vec<CommitInfo> = commits.into_iter().rev().collect();

    for commit in &ordered {
        if let Some((d, _)) = store.get_complete_snapshot(&commit.oid)? {
            digests.insert(d);
            complete += 1;
            continue;
        }

        store.begin_incomplete(
            &commit.oid,
            &commit.parents,
            &commit.summary,
            &commit.author,
            commit.time_seconds,
        )?;

        match reconstruct_commit(&root, &project_name, commit) {
            Ok((graph, digest)) => {
                digests.insert(digest.clone());
                store.publish_complete(
                    &commit.oid,
                    &digest,
                    &graph,
                    &commit.parents,
                    &commit.summary,
                    &commit.author,
                    commit.time_seconds,
                )?;
                complete += 1;
            }
            Err(e) => {
                store.publish_failed(&commit.oid, &e)?;
                failed += 1;
            }
        }
    }

    let (timeline, _) = list_timeline(workspace, storage_dir, Some(limit))?;
    Ok(IndexResult {
        commits_enumerated: ordered.len() as u32,
        snapshots_complete: complete,
        snapshots_failed: failed,
        unique_digests: digests.len() as u32,
        duration_ms: started.elapsed().as_millis() as u64,
        is_shallow: caps.is_shallow,
        timeline,
        analyzer_version: ANALYZER_VERSION,
        temporal_schema_version: TEMPORAL_SCHEMA_VERSION,
        note: "First-parent history only. Snapshots use Git trees (no checkout).".into(),
    })
}

fn reconstruct_commit(
    root: &Path,
    project_name: &str,
    commit: &CommitInfo,
) -> Result<(CanonicalGraph, String), String> {
    let (files, unsupported, excluded) = load_historical_sources(root, &commit.oid)?;
    let sources: Vec<SourceFile> = files
        .into_iter()
        .map(|f| SourceFile {
            relative_posix: f.relative_posix,
            bytes: f.bytes,
        })
        .collect();
    let graph = analyze_sources(AnalyzeSourcesOpts {
        project_path: &format!("git:{}@{}", root.display(), commit.oid),
        project_name,
        files: &sources,
        unsupported_files: unsupported,
        excluded_paths: excluded,
        provenance: GraphProvenance::Historical,
        provenance_note: Some(format!(
            "Historical snapshot for commit {} (first-parent timeline).",
            &commit.oid[..commit.oid.len().min(12)]
        )),
    })?;
    let digest = graph_digest(&graph);
    Ok((graph, digest))
}

pub fn get_snapshot(
    workspace: &str,
    storage_dir: &str,
    commit_oid: &str,
) -> Result<SnapshotResult, String> {
    let commit_oid = parse_commit_oid(commit_oid)?;
    let root = workspace_path(workspace)?;
    let store = open_store(storage_dir)?;
    if let Some((digest, graph)) = store.get_complete_snapshot(&commit_oid)? {
        let commits = list_first_parent_commits(&root, 500)?;
        let commit = commits
            .into_iter()
            .find(|c| c.oid == commit_oid)
            .ok_or_else(|| format!("Commit {commit_oid} not in recent first-parent window"))?;
        return Ok(SnapshotResult {
            commit,
            digest,
            graph,
            status: "complete".into(),
        });
    }

    // On-demand analyze if not indexed.
    let commits = list_first_parent_commits(&root, DEFAULT_HISTORY_LIMIT.max(100))?;
    let commit = commits
        .iter()
        .find(|c| c.oid == commit_oid)
        .cloned()
        .ok_or_else(|| format!("Unknown commit {commit_oid}"))?;
    let project_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();
    let mut store = open_store(storage_dir)?;
    store.begin_incomplete(
        &commit.oid,
        &commit.parents,
        &commit.summary,
        &commit.author,
        commit.time_seconds,
    )?;
    let (graph, digest) = match reconstruct_commit(&root, &project_name, &commit) {
        Ok(v) => v,
        Err(e) => {
            store.publish_failed(&commit.oid, &e)?;
            return Err(e);
        }
    };
    store.publish_complete(
        &commit.oid,
        &digest,
        &graph,
        &commit.parents,
        &commit.summary,
        &commit.author,
        commit.time_seconds,
    )?;
    Ok(SnapshotResult {
        commit,
        digest,
        graph,
        status: "complete".into(),
    })
}

pub fn compare_snapshots(
    storage_dir: &str,
    base_oid: &str,
    target_oid: &str,
) -> Result<(GraphDelta, CanonicalGraph, CanonicalGraph), String> {
    let base_oid = parse_commit_oid(base_oid)?;
    let target_oid = parse_commit_oid(target_oid)?;
    let store = open_store(storage_dir)?;
    let (base_digest, base_graph) = store
        .get_complete_snapshot(&base_oid)?
        .ok_or_else(|| format!("Base snapshot {base_oid} is not complete"))?;
    let (target_digest, target_graph) = store
        .get_complete_snapshot(&target_oid)?
        .ok_or_else(|| format!("Target snapshot {target_oid} is not complete"))?;

    if base_graph.versions.analyzer_version != target_graph.versions.analyzer_version {
        return Err("Cannot compare snapshots from incompatible analyzer versions".into());
    }

    let delta = diff_graphs(
        &base_graph,
        &target_graph,
        &base_oid,
        &target_oid,
        &base_digest,
        &target_digest,
    );
    Ok((delta, base_graph, target_graph))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::Path;
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
        assert!(status.success(), "git {args:?}");
    }

    #[test]
    fn indexes_architecture_change_across_commits() {
        let dir = tempdir().unwrap();
        let root = dir.path();
        let storage = dir.path().join(".prebase-store");
        git(root, &["init"]);
        git(root, &["config", "user.email", "t@t"]);
        git(root, &["config", "user.name", "t"]);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/billing.ts"), "export const billing = 1;\n").unwrap();
        fs::write(
            root.join("src/app.ts"),
            "import { billing } from './billing';\nexport const app = billing;\n",
        )
        .unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "A: app->billing"]);

        fs::write(root.join("src/notifications.ts"), "export const n = 1;\n").unwrap();
        fs::write(
            root.join("src/app.ts"),
            "import { billing } from './billing';\nimport { n } from './notifications';\nexport const app = billing;\n",
        )
        .unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "B: add notifications"]);

        fs::write(
            root.join("src/app.ts"),
            "import { n } from './notifications';\nexport const app = n;\n",
        )
        .unwrap();
        git(root, &["add", "."]);
        git(root, &["commit", "-m", "C: remove billing import"]);

        // Working-tree safety: note content before indexing
        let before = fs::read_to_string(root.join("src/app.ts")).unwrap();
        let head_before = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();

        let result =
            index_history(root.to_str().unwrap(), storage.to_str().unwrap(), Some(10)).unwrap();
        assert_eq!(result.commits_enumerated, 3);
        assert_eq!(result.snapshots_complete, 3);
        assert!(result.unique_digests >= 2);

        let after = fs::read_to_string(root.join("src/app.ts")).unwrap();
        let head_after = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        assert_eq!(before, after);
        assert_eq!(head_before.stdout, head_after.stdout);

        let newest = &result.timeline[0].commit.oid;
        let oldest = &result.timeline[2].commit.oid;
        let (delta, _, _) = compare_snapshots(storage.to_str().unwrap(), oldest, newest).unwrap();
        assert!(!delta.summary.unchanged);
        assert!(delta.edges_added.len() + delta.edges_removed.len() > 0);
    }

    #[test]
    fn temporal_index_and_snapshot_do_not_mutate_working_tree() {
        let dir = tempdir().unwrap();
        // Keep SQLite storage outside the git work tree (mirrors extension globalStorage).
        let root = dir.path().join("repo");
        let storage = dir.path().join("temporal-store");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]);
        git(&root, &["config", "user.email", "t@t"]);
        git(&root, &["config", "user.name", "t"]);
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "initial"]);

        // Dirty working tree + untracked file must survive temporal ops untouched.
        fs::write(root.join("src/a.ts"), "export const a = 42;\n").unwrap();
        fs::write(
            root.join("src/dirty-untracked.ts"),
            "export const dirty = true;\n",
        )
        .unwrap();

        let head_before = git_stdout(&root, &["rev-parse", "HEAD"]);
        let status_before = git_stdout(&root, &["status", "--porcelain"]);
        let a_before = fs::read_to_string(root.join("src/a.ts")).unwrap();
        let dirty_before = fs::read_to_string(root.join("src/dirty-untracked.ts")).unwrap();

        let indexed =
            index_history(root.to_str().unwrap(), storage.to_str().unwrap(), Some(5)).unwrap();
        assert_eq!(indexed.snapshots_complete, 1);

        let oid = indexed.timeline[0].commit.oid.clone();
        let snap = get_snapshot(root.to_str().unwrap(), storage.to_str().unwrap(), &oid).unwrap();
        assert_eq!(snap.status, "complete");
        assert_eq!(
            snap.graph.provenance,
            crate::domain::GraphProvenance::Historical
        );

        let head_after = git_stdout(&root, &["rev-parse", "HEAD"]);
        let status_after = git_stdout(&root, &["status", "--porcelain"]);
        let a_after = fs::read_to_string(root.join("src/a.ts")).unwrap();
        let dirty_after = fs::read_to_string(root.join("src/dirty-untracked.ts")).unwrap();

        assert_eq!(head_before, head_after, "HEAD must not move");
        assert_eq!(status_before, status_after, "git status must be unchanged");
        assert_eq!(a_before, a_after, "tracked dirty file must be unchanged");
        assert_eq!(
            dirty_before, dirty_after,
            "untracked file must be unchanged"
        );
        assert!(
            status_after.lines().any(|l| l.contains("src/a.ts")),
            "expected dirty tracked file in status, got: {status_after:?}"
        );
        assert!(
            status_after
                .lines()
                .any(|l| l.contains("dirty-untracked.ts")),
            "expected untracked file in status, got: {status_after:?}"
        );
        // Snapshots persist only under the external storage dir — never inside the repo.
        assert!(storage.join("temporal.sqlite").is_file());
        assert!(!root.join("temporal.sqlite").exists());
        assert!(!root.join("temporal-store").exists());
    }

    fn git_stdout(cwd: &std::path::Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .output()
            .expect("git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    #[test]
    fn commit_oid_length_bounds_match_host_validation() {
        assert!(parse_commit_oid(&"a".repeat(7)).is_ok());
        assert!(parse_commit_oid(&"a".repeat(40)).is_ok());
        assert!(parse_commit_oid(&"a".repeat(64)).is_ok());
        assert!(parse_commit_oid(&"a".repeat(6)).is_err());
        assert!(parse_commit_oid(&"a".repeat(65)).is_err());
        assert!(parse_commit_oid("notahex").is_err());
    }

    #[test]
    fn compare_rejects_incompatible_analyzer_versions() {
        use crate::domain::{CanonicalGraph, GraphCoverage, GraphNode, GraphProvenance, NodeKind};

        let dir = tempdir().unwrap();
        let storage = dir.path().join("temporal-store");
        let mut store = TemporalStore::open(&storage).unwrap();

        fn graph_with_file(analyzer_version: u32, file_id: &str) -> CanonicalGraph {
            let mut versions = CanonicalGraph::versions();
            versions.analyzer_version = analyzer_version;
            CanonicalGraph {
                nodes: vec![GraphNode {
                    id: file_id.into(),
                    kind: NodeKind::File,
                    label: file_id.into(),
                    path: Some(format!("{file_id}.ts")),
                    parent_id: None,
                    language: Some("typescript".into()),
                    location: None,
                }],
                edges: vec![],
                project_path: "/tmp".into(),
                project_name: "t".into(),
                entry_node_id: None,
                revision: "r".into(),
                provenance: GraphProvenance::Historical,
                versions,
                provenance_note: None,
                coverage: GraphCoverage::default(),
            }
        }

        let base_oid = "1111111111111111111111111111111111111111";
        let target_oid = "2222222222222222222222222222222222222222";
        let base_graph = graph_with_file(ANALYZER_VERSION, "file:base.ts");
        let target_graph = graph_with_file(ANALYZER_VERSION + 1, "file:target.ts");
        let base_digest = graph_digest(&base_graph);
        let target_digest = graph_digest(&target_graph);

        store
            .publish_complete(
                base_oid,
                &base_digest,
                &base_graph,
                &[],
                "base",
                "PreBase",
                1,
            )
            .unwrap();
        store
            .publish_complete(
                target_oid,
                &target_digest,
                &target_graph,
                &[],
                "target",
                "PreBase",
                2,
            )
            .unwrap();

        let err = compare_snapshots(storage.to_str().unwrap(), base_oid, target_oid).unwrap_err();
        assert!(
            err.contains("incompatible analyzer versions"),
            "unexpected error: {err}"
        );
    }
}
