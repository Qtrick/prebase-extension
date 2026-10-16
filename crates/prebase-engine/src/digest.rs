//! Deterministic content-addressed digests for canonical graphs.

use sha2::{Digest, Sha256};

use crate::domain::{CanonicalGraph, GRAPH_SCHEMA_VERSION, IDENTITY_VERSION};

/// SHA-256 hex digest of the structural graph (nodes, edges, analysis versions).
/// Excludes project_path, timestamps, and provenance_note so equivalent architecture
/// across commits / paths can deduplicate.
pub fn graph_digest(graph: &CanonicalGraph) -> String {
    let mut h = Sha256::new();
    h.update(b"prebase-graph-digest-v1\0");
    h.update(GRAPH_SCHEMA_VERSION.to_le_bytes());
    h.update(graph.versions.analyzer_version.to_le_bytes());
    h.update(IDENTITY_VERSION.to_le_bytes());

    let mut nodes = graph.nodes.clone();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    for n in &nodes {
        h.update(n.id.as_bytes());
        h.update(b"\0");
        h.update(format!("{:?}", n.kind).as_bytes());
        h.update(b"\0");
        h.update(n.label.as_bytes());
        h.update(b"\0");
        if let Some(p) = &n.path {
            h.update(p.as_bytes());
        }
        h.update(b"\0");
        if let Some(lang) = &n.language {
            h.update(lang.as_bytes());
        }
        h.update(b"\0");
    }

    let mut edges = graph.edges.clone();
    edges.sort_by(|a, b| a.id.cmp(&b.id));
    for e in &edges {
        h.update(e.id.as_bytes());
        h.update(b"\0");
        h.update(e.source.as_bytes());
        h.update(b"\0");
        h.update(e.target.as_bytes());
        h.update(b"\0");
        h.update(format!("{:?}", e.kind).as_bytes());
        h.update(b"\0");
        if let Some(r) = &e.resolution {
            h.update(format!("{r:?}").as_bytes());
        }
        h.update(b"\0");
        if let Some(s) = &e.specifier {
            h.update(s.as_bytes());
        }
        h.update(b"\0");
    }

    format!("gdig-{}", hex::encode(h.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::{
        EdgeKind, GraphCoverage, GraphEdge, GraphNode, GraphProvenance, NodeKind, ResolutionStatus,
    };

    fn sample() -> CanonicalGraph {
        CanonicalGraph {
            nodes: vec![
                GraphNode {
                    id: "file:b.ts".into(),
                    kind: NodeKind::File,
                    label: "b.ts".into(),
                    path: Some("b.ts".into()),
                    parent_id: None,
                    language: Some("typescript".into()),
                    location: None,
                },
                GraphNode {
                    id: "file:a.ts".into(),
                    kind: NodeKind::File,
                    label: "a.ts".into(),
                    path: Some("a.ts".into()),
                    parent_id: None,
                    language: Some("typescript".into()),
                    location: None,
                },
            ],
            edges: vec![GraphEdge {
                id: "e1".into(),
                source: "file:a.ts".into(),
                target: "file:b.ts".into(),
                kind: EdgeKind::Import,
                resolution: Some(ResolutionStatus::Resolved),
                specifier: Some("./b".into()),
                evidence: None,
                location: None,
            }],
            project_path: "/ws".into(),
            project_name: "ws".into(),
            entry_node_id: None,
            revision: "r".into(),
            provenance: GraphProvenance::Historical,
            versions: CanonicalGraph::versions(),
            provenance_note: Some("ignore me".into()),
            coverage: GraphCoverage::default(),
        }
    }

    #[test]
    fn equivalent_graphs_same_digest_regardless_of_order_or_path() {
        let mut a = sample();
        let mut b = sample();
        b.nodes.reverse();
        b.project_path = "/other".into();
        b.provenance_note = None;
        assert_eq!(graph_digest(&a), graph_digest(&b));
        a.edges[0].specifier = Some("./changed".into());
        assert_ne!(graph_digest(&a), graph_digest(&b));
    }
}
