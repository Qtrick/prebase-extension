//! Build a canonical graph from in-memory source files (working tree or historical).

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::time::Instant;

use sha2::{Digest, Sha256};

use crate::discover::language_for_extension;
use crate::domain::{
    CanonicalGraph, EdgeKind, EvidenceKind, GraphCoverage, GraphEdge, GraphNode, GraphProvenance,
    NodeKind, ResolutionStatus, SourceLocation,
};
use crate::extract::extract_imports;
use crate::resolve::{resolve_import, ResolutionIndex};

#[derive(Debug, Clone)]
pub struct SourceFile {
    pub relative_posix: String,
    pub bytes: Vec<u8>,
}

fn content_hash(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    hex::encode(h.finalize())
}

pub struct AnalyzeSourcesOpts<'a> {
    pub project_path: &'a str,
    pub project_name: &'a str,
    pub files: &'a [SourceFile],
    pub unsupported_files: u32,
    pub excluded_paths: u32,
    pub provenance: GraphProvenance,
    pub provenance_note: Option<String>,
}

pub fn analyze_sources(opts: AnalyzeSourcesOpts<'_>) -> Result<CanonicalGraph, String> {
    let started = Instant::now();
    let mut fingerprint = Sha256::new();
    fingerprint.update(opts.project_path.as_bytes());
    fingerprint.update(b"\0");
    fingerprint.update(format!("{:?}", opts.provenance).as_bytes());
    fingerprint.update(opts.unsupported_files.to_le_bytes());
    fingerprint.update(opts.excluded_paths.to_le_bytes());

    for f in opts.files {
        fingerprint.update(f.relative_posix.as_bytes());
        fingerprint.update(content_hash(&f.bytes).as_bytes());
    }
    let revision = format!(
        "{}-{}",
        match opts.provenance {
            GraphProvenance::Historical => "hist",
            GraphProvenance::Repository => "repo",
            GraphProvenance::Fixture => "fix",
        },
        hex::encode(fingerprint.finalize())
    );

    let index = ResolutionIndex::new(opts.files.iter().map(|f| f.relative_posix.clone()));

    let mut nodes: BTreeMap<String, GraphNode> = BTreeMap::new();
    let mut edges: BTreeSet<(String, String, String)> = BTreeSet::new();
    let mut edge_meta: BTreeMap<String, GraphEdge> = BTreeMap::new();

    let mut coverage = GraphCoverage {
        discovered_files: opts.files.len() as u32 + opts.unsupported_files,
        unsupported_files: opts.unsupported_files,
        excluded_paths: opts.excluded_paths,
        ..GraphCoverage::default()
    };

    for file in opts.files {
        let id = CanonicalGraph::file_id(&file.relative_posix);
        let label = Path::new(&file.relative_posix)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| file.relative_posix.clone());
        let ext = Path::new(&file.relative_posix)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let language = language_for_extension(ext).map(|s| s.to_string());
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

    for file in opts.files {
        let rel = &file.relative_posix;
        let id = CanonicalGraph::file_id(rel);
        let ext = Path::new(rel)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_string();
        let source = match std::str::from_utf8(&file.bytes) {
            Ok(s) => s,
            Err(_) => {
                coverage.parse_failures += 1;
                continue;
            }
        };
        let extraction = extract_imports(rel, &ext, source);
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

    let graph = CanonicalGraph {
        nodes: node_list,
        edges: edge_list,
        project_path: opts.project_path.to_string(),
        project_name: opts.project_name.to_string(),
        entry_node_id,
        revision,
        provenance: opts.provenance,
        versions: CanonicalGraph::versions(),
        provenance_note: opts.provenance_note,
        coverage,
    };
    graph.validate_invariants()?;
    Ok(graph)
}
