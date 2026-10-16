//! Canonical graph domain model.
//!
//! Adapted from the older PreBase `graphs/` TypeScript types.
//! Stable string IDs are application identities — never petgraph indices.
//!
//! Identity strategy (identityVersion = 1):
//! - File nodes: `file:<posix-relative-path>` from the workspace root.
//! - Paths use `/` separators, no leading `./`.
//! - Rename without history mapping ⇒ new identity (Prompt 3+ may add lineage).

use serde::{Deserialize, Serialize};

pub const GRAPH_SCHEMA_VERSION: u32 = 1;
pub const IDENTITY_VERSION: u32 = 1;
pub const ANALYZER_VERSION: u32 = 4;
/// Temporal snapshot / SQLite schema version (independent of analyzer).
pub const TEMPORAL_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    Folder,
    File,
    Function,
    Component,
    Service,
    Module,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    Import,
    Export,
    Reference,
    Contains,
    Dependency,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionStatus {
    Resolved,
    Unresolved,
    External,
    Ambiguous,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    /// Tree-sitter / parser extracted import or require.
    SyntaxImport,
    /// Heuristic-only (must not be presented as certainty).
    Heuristic,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLocation {
    pub path: String,
    pub line: Option<u32>,
    pub column: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub id: String,
    pub kind: NodeKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub id: String,
    pub source: String,
    pub target: String,
    pub kind: EdgeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolution: Option<ResolutionStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub specifier: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<EvidenceKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<SourceLocation>,
}

/// Provenance of graph data. Fixture must never be presented as repository analysis.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GraphProvenance {
    Fixture,
    Repository,
    /// Reconstructed from a historical Git tree (not the working tree).
    Historical,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphVersions {
    pub graph_schema_version: u32,
    pub analyzer_version: u32,
    pub identity_version: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GraphCoverage {
    pub discovered_files: u32,
    pub analyzed_files: u32,
    pub unsupported_files: u32,
    pub parse_failures: u32,
    pub resolved_imports: u32,
    pub unresolved_imports: u32,
    pub external_imports: u32,
    pub ambiguous_imports: u32,
    pub excluded_paths: u32,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalGraph {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub project_path: String,
    pub project_name: String,
    pub entry_node_id: Option<String>,
    pub revision: String,
    pub provenance: GraphProvenance,
    pub versions: GraphVersions,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provenance_note: Option<String>,
    #[serde(default)]
    pub coverage: GraphCoverage,
}

impl CanonicalGraph {
    pub fn versions() -> GraphVersions {
        GraphVersions {
            graph_schema_version: GRAPH_SCHEMA_VERSION,
            analyzer_version: ANALYZER_VERSION,
            identity_version: IDENTITY_VERSION,
        }
    }

    pub fn file_id(relative_posix: &str) -> String {
        format!("file:{relative_posix}")
    }

    pub fn validate_invariants(&self) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        for n in &self.nodes {
            if n.id.is_empty() {
                return Err("empty node id".into());
            }
            if !ids.insert(n.id.as_str()) {
                return Err(format!("duplicate node id {}", n.id));
            }
        }
        let mut edge_ids = std::collections::HashSet::new();
        for e in &self.edges {
            if e.id.is_empty() {
                return Err("empty edge id".into());
            }
            if !edge_ids.insert(e.id.as_str()) {
                return Err(format!("duplicate edge id {}", e.id));
            }
            if !ids.contains(e.source.as_str()) {
                return Err(format!("edge {} missing source {}", e.id, e.source));
            }
            if !ids.contains(e.target.as_str()) {
                return Err(format!("edge {} missing target {}", e.id, e.target));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_ids_are_stable_strings() {
        let n = GraphNode {
            id: CanonicalGraph::file_id("src/main.rs"),
            kind: NodeKind::File,
            label: "main.rs".into(),
            path: Some("src/main.rs".into()),
            parent_id: None,
            language: Some("rust".into()),
            location: None,
        };
        let json = serde_json::to_string(&n).unwrap();
        let back: GraphNode = serde_json::from_str(&json).unwrap();
        assert_eq!(back.id, "file:src/main.rs");
    }

    #[test]
    fn graph_coverage_roundtrips_camel_case_json() {
        let g = CanonicalGraph {
            nodes: vec![],
            edges: vec![],
            project_path: "/ws".into(),
            project_name: "ws".into(),
            entry_node_id: None,
            revision: "r1".into(),
            provenance: GraphProvenance::Repository,
            versions: CanonicalGraph::versions(),
            provenance_note: None,
            coverage: GraphCoverage {
                discovered_files: 10,
                analyzed_files: 8,
                unsupported_files: 1,
                parse_failures: 1,
                resolved_imports: 5,
                unresolved_imports: 2,
                external_imports: 3,
                ambiguous_imports: 0,
                excluded_paths: 4,
                duration_ms: 42,
            },
        };
        let json = serde_json::to_string(&g).unwrap();
        assert!(json.contains("\"analyzedFiles\":8"));
        assert!(json.contains("\"durationMs\":42"));
        let back: CanonicalGraph = serde_json::from_str(&json).unwrap();
        assert_eq!(back.coverage.analyzed_files, 8);
        assert_eq!(back.coverage.duration_ms, 42);
    }

    #[test]
    fn validate_rejects_dangling_edge() {
        let g = CanonicalGraph {
            nodes: vec![],
            edges: vec![GraphEdge {
                id: "e1".into(),
                source: "a".into(),
                target: "b".into(),
                kind: EdgeKind::Import,
                resolution: None,
                specifier: None,
                evidence: None,
                location: None,
            }],
            project_path: "/".into(),
            project_name: "t".into(),
            entry_node_id: None,
            revision: "r".into(),
            provenance: GraphProvenance::Repository,
            versions: CanonicalGraph::versions(),
            provenance_note: None,
            coverage: GraphCoverage::default(),
        };
        assert!(g.validate_invariants().is_err());
    }
}
