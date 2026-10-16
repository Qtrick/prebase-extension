//! Orchestrates discovery → extract → resolve → canonical graph.
//!
//! Parse results are cached per workspace by content hash so unchanged files
//! skip Tree-sitter on refresh. Graph publication remains atomic (build full
//! graph, then replace). Full rescan of discovery always runs; expensive parse
//! work is what we avoid.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use sha2::{Digest, Sha256};

use crate::discover::{discover_workspace, language_for_extension, resolve_workspace_root};
use crate::domain::{
    CanonicalGraph, EdgeKind, EvidenceKind, GraphCoverage, GraphEdge, GraphNode, GraphProvenance,
    NodeKind, ResolutionStatus, SourceLocation,
};
use crate::extract::{extract_imports, FileExtraction};
use crate::resolve::{resolve_import, ResolutionIndex};

#[derive(Clone)]
struct CachedParse {
    content_hash: String,
    extraction: FileExtraction,
}

#[derive(Default)]
struct WorkspaceCache {
    /// Absolute workspace root (canonical string).
    root: String,
    /// Relative posix path → parse cache.
    parses: HashMap<String, CachedParse>,
    /// Last published graph fingerprint → graph.
    graph_key: String,
    graph: Option<CanonicalGraph>,
    /// Monotonic generation for this process (published graphs).
    generation: u64,
}

static CACHE: Mutex<Option<WorkspaceCache>> = Mutex::new(None);
/// Serializes full analyze passes (parse cache + graph publish). The stdio engine
/// is single-threaded; this also keeps unit tests from clearing `CACHE` mid-pass.
static ANALYZE_LOCK: Mutex<()> = Mutex::new(());

fn ensure_workspace_cache(guard: &mut Option<WorkspaceCache>, root_key: &str) {
    match guard.as_mut() {
        Some(c) if c.root == root_key => {}
        _ => {
            *guard = Some(WorkspaceCache {
                root: root_key.to_string(),
                ..WorkspaceCache::default()
            });
        }
    }
}

fn content_hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

fn cache_lock() -> std::sync::MutexGuard<'static, Option<WorkspaceCache>> {
    CACHE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Clear all derived analysis state (recovery / force refresh).
pub fn clear_caches() {
    if let Ok(mut guard) = CACHE.lock() {
        *guard = None;
    }
}

pub fn analyze_workspace(workspace_path: &str) -> Result<CanonicalGraph, String> {
    analyze_workspace_opts(workspace_path, false)
}

pub fn analyze_workspace_opts(
    workspace_path: &str,
    force_refresh: bool,
) -> Result<CanonicalGraph, String> {
    let _analyze_guard = ANALYZE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let started = Instant::now();
    let root = resolve_workspace_root(workspace_path)?;
    let root_key = root.to_string_lossy().into_owned();

    if force_refresh {
        clear_caches();
    }

    let discovery = discover_workspace(&root)?;

    // Ensure workspace cache matches current root.
    {
        let mut guard = cache_lock();
        ensure_workspace_cache(&mut guard, &root_key);
    }

    let mut fingerprint = Sha256::new();
    fingerprint.update(root_key.as_bytes());
    fingerprint.update(discovery.unsupported_files.to_le_bytes());
    fingerprint.update(discovery.excluded_paths.to_le_bytes());

    struct FileInput {
        relative_posix: String,
        content_hash: String,
        bytes: Vec<u8>,
    }

    let mut file_inputs: Vec<FileInput> = Vec::with_capacity(discovery.files.len());
    for f in &discovery.files {
        fingerprint.update(f.relative_posix.as_bytes());
        let bytes = match fs::read(&f.absolute) {
            Ok(b) => b,
            Err(_) => {
                fingerprint.update(b"<read_error>");
                continue;
            }
        };
        let hash = content_hash(&bytes);
        fingerprint.update(hash.as_bytes());
        file_inputs.push(FileInput {
            relative_posix: f.relative_posix.clone(),
            content_hash: hash,
            bytes,
        });
    }
    let revision = format!("repo-{}", hex::encode(fingerprint.finalize()));

    {
        let guard = cache_lock();
        if let Some(c) = guard.as_ref() {
            if !force_refresh && c.graph_key == revision {
                if let Some(mut cached) = c.graph.clone() {
                    cached.coverage.duration_ms = started.elapsed().as_millis() as u64;
                    return Ok(cached);
                }
            }
        }
    }

    // Drop parse entries for files that no longer exist.
    {
        let mut guard = cache_lock();
        if let Some(c) = guard.as_mut() {
            let live: BTreeSet<&str> = discovery
                .files
                .iter()
                .map(|f| f.relative_posix.as_str())
                .collect();
            c.parses.retain(|path, _| live.contains(path.as_str()));
        }
    }

    let index = ResolutionIndex::new(discovery.files.iter().map(|f| f.relative_posix.clone()));

    let mut nodes: BTreeMap<String, GraphNode> = BTreeMap::new();
    let mut edges: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut edge_meta: BTreeMap<String, GraphEdge> = BTreeMap::new();

    let mut coverage = GraphCoverage {
        discovered_files: discovery.files.len() as u32 + discovery.unsupported_files,
        unsupported_files: discovery.unsupported_files,
        excluded_paths: discovery.excluded_paths,
        ..GraphCoverage::default()
    };

    // Pass 1: create every file node so later import edges never dangle.
    for file in &discovery.files {
        let id = CanonicalGraph::file_id(&file.relative_posix);
        let label = Path::new(&file.relative_posix)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file.relative_posix.clone());
        let language = language_for_extension(&file.extension).map(|s| s.to_string());
        nodes.insert(
            id.clone(),
            GraphNode {
                id,
                kind: NodeKind::File,
                label,
                path: Some(file.relative_posix.clone()),
                parent_id: None,
                language,
                location: Some(SourceLocation {
                    path: file.relative_posix.clone(),
                    line: Some(1),
                    column: Some(1),
                }),
            },
        );
    }

    // Pass 2: extract (with content-hash cache) and emit resolved edges.
    for input in &file_inputs {
        let rel = &input.relative_posix;
        let hash = &input.content_hash;
        let id = CanonicalGraph::file_id(rel);
        let ext = Path::new(rel)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();

        let cached_hit = {
            let guard = cache_lock();
            guard
                .as_ref()
                .and_then(|c| c.parses.get(rel.as_str()))
                .filter(|e| e.content_hash == *hash)
                .map(|e| e.extraction.clone())
        };

        let extraction = if let Some(hit) = cached_hit {
            hit
        } else {
            let source = match std::str::from_utf8(&input.bytes) {
                Ok(s) => s,
                Err(_) => {
                    coverage.parse_failures += 1;
                    continue;
                }
            };
            let extraction = extract_imports(rel, &ext, source);
            {
                let mut guard = cache_lock();
                if let Some(cache) = guard.as_mut() {
                    cache.parses.insert(
                        rel.clone(),
                        CachedParse {
                            content_hash: hash.clone(),
                            extraction: extraction.clone(),
                        },
                    );
                }
            }
            extraction
        };

        if extraction.parse_error {
            coverage.parse_failures += 1;
        }
        coverage.analyzed_files += 1;

        for imp in &extraction.imports {
            let resolved = resolve_import(rel, imp, &index);
            match resolved.status {
                ResolutionStatus::Resolved => {
                    coverage.resolved_imports += 1;
                    if let Some(target_rel) = &resolved.target_relative {
                        let target_id = CanonicalGraph::file_id(target_rel);
                        if !nodes.contains_key(&target_id) {
                            continue;
                        }
                        let edge_id =
                            format!("e:import:{}->{}:{}", rel, target_rel, resolved.specifier);
                        let key = (id.clone(), target_id.clone(), edge_id.clone());
                        if edges.insert(key) {
                            edge_meta.insert(
                                edge_id.clone(),
                                GraphEdge {
                                    id: edge_id,
                                    source: id.clone(),
                                    target: target_id,
                                    kind: EdgeKind::Import,
                                    resolution: Some(ResolutionStatus::Resolved),
                                    specifier: Some(resolved.specifier.clone()),
                                    evidence: Some(EvidenceKind::SyntaxImport),
                                    location: Some(SourceLocation {
                                        path: rel.clone(),
                                        line: Some(resolved.line),
                                        column: Some(resolved.column),
                                    }),
                                },
                            );
                        }
                    }
                }
                ResolutionStatus::Unresolved => coverage.unresolved_imports += 1,
                ResolutionStatus::External => coverage.external_imports += 1,
                ResolutionStatus::Ambiguous => coverage.ambiguous_imports += 1,
            }
        }
    }

    coverage.duration_ms = started.elapsed().as_millis() as u64;

    let project_name = root
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();

    let entry_node_id = nodes
        .keys()
        .find(|id| {
            id.ends_with("/main.ts")
                || id.ends_with("/index.ts")
                || id.ends_with("/main.tsx")
                || id.ends_with("/extension.ts")
                || id.ends_with("/main.rs")
                || id.ends_with("/lib.rs")
        })
        .cloned()
        .or_else(|| nodes.keys().next().cloned());

    let mut edge_list: Vec<GraphEdge> = edge_meta.into_values().collect();
    edge_list.sort_by(|a, b| a.id.cmp(&b.id));
    let mut node_list: Vec<GraphNode> = nodes.into_values().collect();
    node_list.sort_by(|a, b| a.id.cmp(&b.id));

    let generation = {
        let mut guard = cache_lock();
        ensure_workspace_cache(&mut guard, &root_key);
        let c = guard.as_mut().expect("workspace cache initialized");
        c.generation = c.generation.saturating_add(1);
        c.generation
    };

    let mut graph = CanonicalGraph {
        nodes: node_list,
        edges: edge_list,
        project_path: root_key.clone(),
        project_name,
        entry_node_id,
        revision,
        provenance: GraphProvenance::Repository,
        versions: CanonicalGraph::versions(),
        provenance_note: None,
        coverage,
    };

    if force_refresh {
        graph.provenance_note = Some(format!("force_refresh generation={generation}"));
    }

    graph.validate_invariants()?;

    {
        let mut guard = cache_lock();
        ensure_workspace_cache(&mut guard, &root_key);
        if let Some(c) = guard.as_mut() {
            c.graph_key = graph.revision.clone();
            c.graph = Some(graph.clone());
        }
    }

    Ok(graph)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn analyzes_miniature_repo() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/a.ts"),
            "import { b } from './b';\nexport const a = 1;\n",
        )
        .unwrap();
        fs::write(
            root.join("src/b.ts"),
            "import { a } from './a';\nexport const b = 2;\n",
        )
        .unwrap();
        fs::write(root.join("src/orphan.ts"), "export const o = 3;\n").unwrap();
        fs::write(
            root.join("src/bad.ts"),
            "import { x } from './definitely-missing';\nexport const bad = 1;\n",
        )
        .unwrap();
        fs::create_dir_all(root.join("node_modules/x")).unwrap();
        fs::write(root.join("node_modules/x/index.js"), "module.exports={}\n").unwrap();
        fs::write(root.join("notes.md"), "hi\n").unwrap();

        let graph = analyze_workspace(root.to_str().unwrap()).unwrap();
        assert_eq!(graph.provenance, GraphProvenance::Repository);
        assert!(graph.nodes.len() >= 3);
        assert!(graph.edges.iter().any(|e| e.kind == EdgeKind::Import));
        assert!(graph.coverage.resolved_imports >= 2);
        assert!(graph.coverage.unresolved_imports >= 1);
        assert!(graph.coverage.unsupported_files >= 1);

        let a = CanonicalGraph::file_id("src/a.ts");
        let b = CanonicalGraph::file_id("src/b.ts");
        assert!(graph.edges.iter().any(|e| e.source == a && e.target == b));
        assert!(graph.edges.iter().any(|e| e.source == b && e.target == a));
        graph.validate_invariants().unwrap();
    }

    #[test]
    fn empty_supported_sources_yields_empty_repo_graph() {
        clear_caches();
        let dir = tempdir().unwrap();
        fs::write(dir.path().join("README.md"), "x\n").unwrap();
        let graph = analyze_workspace(dir.path().to_str().unwrap()).unwrap();
        assert!(graph.nodes.is_empty());
        assert_eq!(graph.provenance, GraphProvenance::Repository);
    }

    #[test]
    fn cache_revision_changes_when_unsupported_file_count_changes() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        let g1 = analyze_workspace(root.to_str().unwrap()).unwrap();

        fs::write(root.join("notes.md"), "hello\n").unwrap();
        let g2 = analyze_workspace(root.to_str().unwrap()).unwrap();

        assert_ne!(g1.revision, g2.revision);
        assert!(g2.coverage.unsupported_files >= g1.coverage.unsupported_files);
    }

    #[test]
    fn content_change_invalidates_graph_revision() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        fs::write(root.join("src/b.ts"), "export const b = 2;\n").unwrap();
        let g1 = analyze_workspace(root.to_str().unwrap()).unwrap();

        fs::write(
            root.join("src/a.ts"),
            "import { b } from './b';\nexport const a = 1;\n",
        )
        .unwrap();
        let g2 = analyze_workspace(root.to_str().unwrap()).unwrap();
        assert_ne!(g1.revision, g2.revision);
        assert!(g2.coverage.resolved_imports >= 1);
        assert!(g2.edges.iter().any(|e| e.kind == EdgeKind::Import));
    }

    #[test]
    fn creating_file_resolves_previous_unresolved_import() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/a.ts"),
            "import { c } from './c';\nexport const a = 1;\n",
        )
        .unwrap();
        let g1 = analyze_workspace(root.to_str().unwrap()).unwrap();
        assert!(g1.coverage.unresolved_imports >= 1);
        assert!(!g1.edges.iter().any(|e| e.target.ends_with("/c.ts")));

        fs::write(root.join("src/c.ts"), "export const c = 3;\n").unwrap();
        let g2 = analyze_workspace(root.to_str().unwrap()).unwrap();
        let a = CanonicalGraph::file_id("src/a.ts");
        let c = CanonicalGraph::file_id("src/c.ts");
        assert!(g2.edges.iter().any(|e| e.source == a && e.target == c));
        assert!(g2.coverage.resolved_imports >= 1);
    }

    #[test]
    fn deleting_file_removes_node_and_edges() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src/a.ts"),
            "import { b } from './b';\nexport const a = 1;\n",
        )
        .unwrap();
        fs::write(root.join("src/b.ts"), "export const b = 2;\n").unwrap();
        let g1 = analyze_workspace(root.to_str().unwrap()).unwrap();
        assert!(g1.nodes.iter().any(|n| n.id.ends_with("/b.ts")));

        fs::remove_file(root.join("src/b.ts")).unwrap();
        let g2 = analyze_workspace(root.to_str().unwrap()).unwrap();
        assert!(!g2.nodes.iter().any(|n| n.id.ends_with("/b.ts")));
        assert!(!g2.edges.iter().any(|e| e.target.ends_with("/b.ts")));
        assert!(g2.coverage.unresolved_imports >= 1);
    }

    #[test]
    fn unchanged_second_analyze_hits_graph_cache() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        let g1 = analyze_workspace(root.to_str().unwrap()).unwrap();
        let g2 = analyze_workspace(root.to_str().unwrap()).unwrap();
        assert_eq!(g1.revision, g2.revision);
        assert_eq!(g1.nodes.len(), g2.nodes.len());
    }

    #[test]
    fn force_refresh_clears_caches() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.ts"), "export const a = 1;\n").unwrap();
        let _ = analyze_workspace(root.to_str().unwrap()).unwrap();
        let g2 = analyze_workspace_opts(root.to_str().unwrap(), true).unwrap();
        assert!(g2
            .provenance_note
            .as_deref()
            .unwrap_or("")
            .contains("force_refresh"));
    }

    #[test]
    fn rename_like_move_swaps_file_identity_and_revision() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/foo.ts"), "export const x = 1;\n").unwrap();
        let g1 = analyze_workspace(root.to_str().unwrap()).unwrap();
        let old_id = CanonicalGraph::file_id("src/foo.ts");
        assert!(g1.nodes.iter().any(|n| n.id == old_id));

        fs::rename(root.join("src/foo.ts"), root.join("src/bar.ts")).unwrap();
        let g2 = analyze_workspace(root.to_str().unwrap()).unwrap();
        let new_id = CanonicalGraph::file_id("src/bar.ts");
        assert_ne!(g1.revision, g2.revision);
        assert!(!g2.nodes.iter().any(|n| n.id == old_id));
        assert!(g2.nodes.iter().any(|n| n.id == new_id));
    }

    #[test]
    fn concurrent_analyze_from_threads_returns_consistent_graphs() {
        clear_caches();
        let dir = tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        for i in 0..5 {
            fs::write(
                root.join("src").join(format!("f{i}.ts")),
                format!("export const f{i} = {i};\n"),
            )
            .unwrap();
        }
        let root_str = root.to_str().unwrap().to_string();
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let r = root_str.clone();
                std::thread::spawn(move || analyze_workspace(&r))
            })
            .collect();
        let mut revisions = BTreeSet::new();
        for h in handles {
            let g = h.join().expect("thread panicked").expect("analyze ok");
            assert!(g.nodes.len() >= 5);
            revisions.insert(g.revision.clone());
        }
        assert!(
            revisions.len() <= 2,
            "expected at most one in-flight rebuild revision, got {revisions:?}"
        );
    }
}
