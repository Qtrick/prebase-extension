//! Structural diffs between two canonical graphs.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use crate::domain::CanonicalGraph;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDelta {
    pub base_commit_oid: String,
    pub target_commit_oid: String,
    pub base_digest: String,
    pub target_digest: String,
    pub nodes_added: Vec<String>,
    pub nodes_removed: Vec<String>,
    pub edges_added: Vec<String>,
    pub edges_removed: Vec<String>,
    pub summary: DeltaSummary,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DeltaSummary {
    pub nodes_added: u32,
    pub nodes_removed: u32,
    pub edges_added: u32,
    pub edges_removed: u32,
    pub unchanged: bool,
}

pub fn diff_graphs(
    base: &CanonicalGraph,
    target: &CanonicalGraph,
    base_commit_oid: &str,
    target_commit_oid: &str,
    base_digest: &str,
    target_digest: &str,
) -> GraphDelta {
    let base_nodes: BTreeSet<&str> = base.nodes.iter().map(|n| n.id.as_str()).collect();
    let target_nodes: BTreeSet<&str> = target.nodes.iter().map(|n| n.id.as_str()).collect();
    let nodes_added: Vec<String> = target_nodes
        .difference(&base_nodes)
        .map(|s| (*s).to_string())
        .collect();
    let nodes_removed: Vec<String> = base_nodes
        .difference(&target_nodes)
        .map(|s| (*s).to_string())
        .collect();

    let base_edges: BTreeMap<&str, &str> = base
        .edges
        .iter()
        .map(|e| (e.id.as_str(), e.id.as_str()))
        .collect();
    let target_edge_ids: BTreeSet<&str> = target.edges.iter().map(|e| e.id.as_str()).collect();
    let base_edge_ids: BTreeSet<&str> = base_edges.keys().copied().collect();

    let edges_added: Vec<String> = target_edge_ids
        .difference(&base_edge_ids)
        .map(|s| (*s).to_string())
        .collect();
    let edges_removed: Vec<String> = base_edge_ids
        .difference(&target_edge_ids)
        .map(|s| (*s).to_string())
        .collect();

    let summary = DeltaSummary {
        nodes_added: nodes_added.len() as u32,
        nodes_removed: nodes_removed.len() as u32,
        edges_added: edges_added.len() as u32,
        edges_removed: edges_removed.len() as u32,
        unchanged: nodes_added.is_empty()
            && nodes_removed.is_empty()
            && edges_added.is_empty()
            && edges_removed.is_empty(),
    };

    GraphDelta {
        base_commit_oid: base_commit_oid.to_string(),
        target_commit_oid: target_commit_oid.to_string(),
        base_digest: base_digest.to_string(),
        target_digest: target_digest.to_string(),
        nodes_added,
        nodes_removed,
        edges_added,
        edges_removed,
        summary,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        EdgeKind, GraphCoverage, GraphEdge, GraphNode, GraphProvenance, NodeKind, ResolutionStatus,
    };

    fn graph(nodes: &[&str], edges: &[(&str, &str, &str)]) -> CanonicalGraph {
        CanonicalGraph {
            nodes: nodes
                .iter()
                .map(|id| GraphNode {
                    id: (*id).into(),
                    kind: NodeKind::File,
                    label: (*id).into(),
                    path: Some((*id).trim_start_matches("file:").into()),
                    parent_id: None,
                    language: Some("typescript".into()),
                    location: None,
                })
                .collect(),
            edges: edges
                .iter()
                .map(|(id, s, t)| GraphEdge {
                    id: (*id).into(),
                    source: (*s).into(),
                    target: (*t).into(),
                    kind: EdgeKind::Import,
                    resolution: Some(ResolutionStatus::Resolved),
                    specifier: None,
                    evidence: None,
                    location: None,
                })
                .collect(),
            project_path: "/".into(),
            project_name: "t".into(),
            entry_node_id: None,
            revision: "r".into(),
            provenance: GraphProvenance::Historical,
            versions: CanonicalGraph::versions(),
            provenance_note: None,
            coverage: GraphCoverage::default(),
        }
    }

    #[test]
    fn empty_delta_for_equivalent_graphs() {
        let g = graph(&["file:a.ts"], &[]);
        let d = diff_graphs(&g, &g, "c1", "c2", "d1", "d1");
        assert!(d.summary.unchanged);
    }

    #[test]
    fn detects_edge_addition_and_removal() {
        let base = graph(
            &["file:a.ts", "file:b.ts"],
            &[("e:a-b", "file:a.ts", "file:b.ts")],
        );
        let target = graph(
            &["file:a.ts", "file:b.ts", "file:c.ts"],
            &[("e:a-c", "file:a.ts", "file:c.ts")],
        );
        let d = diff_graphs(&base, &target, "c1", "c2", "d1", "d2");
        assert_eq!(d.nodes_added, vec!["file:c.ts".to_string()]);
        assert_eq!(d.edges_removed, vec!["e:a-b".to_string()]);
        assert_eq!(d.edges_added, vec!["e:a-c".to_string()]);
        assert!(!d.summary.unchanged);
    }
}
