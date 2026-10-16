//! Explicit sample graph for tests / preferFixture.
//! Not used as silent fallback after analysis failure.

use crate::domain::{
    CanonicalGraph, EdgeKind, GraphCoverage, GraphEdge, GraphNode, GraphProvenance, NodeKind,
    SourceLocation,
};

pub fn sample_network_graph(workspace_path: &str) -> CanonicalGraph {
    let project_name = std::path::Path::new(workspace_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("workspace")
        .to_string();

    let edge = |id: &str, source: &str, target: &str, kind: EdgeKind| GraphEdge {
        id: id.into(),
        source: source.into(),
        target: target.into(),
        kind,
        resolution: None,
        specifier: None,
        evidence: None,
        location: None,
    };

    let nodes = vec![
        GraphNode {
            id: "mod:app".into(),
            kind: NodeKind::Module,
            label: "app".into(),
            path: Some("src".into()),
            parent_id: None,
            language: Some("typescript".into()),
            location: None,
        },
        GraphNode {
            id: "file:src/extension.ts".into(),
            kind: NodeKind::File,
            label: "extension.ts".into(),
            path: Some("src/extension.ts".into()),
            parent_id: Some("mod:app".into()),
            language: Some("typescript".into()),
            location: Some(SourceLocation {
                path: "src/extension.ts".into(),
                line: Some(1),
                column: Some(1),
            }),
        },
        GraphNode {
            id: "file:src/engine/client.ts".into(),
            kind: NodeKind::File,
            label: "client.ts".into(),
            path: Some("src/engine/client.ts".into()),
            parent_id: Some("mod:app".into()),
            language: Some("typescript".into()),
            location: Some(SourceLocation {
                path: "src/engine/client.ts".into(),
                line: Some(1),
                column: Some(1),
            }),
        },
        GraphNode {
            id: "fn:activate".into(),
            kind: NodeKind::Function,
            label: "activate".into(),
            path: Some("src/extension.ts".into()),
            parent_id: Some("file:src/extension.ts".into()),
            language: Some("typescript".into()),
            location: Some(SourceLocation {
                path: "src/extension.ts".into(),
                line: Some(12),
                column: Some(1),
            }),
        },
        GraphNode {
            id: "mod:engine".into(),
            kind: NodeKind::Module,
            label: "prebase-engine".into(),
            path: Some("crates/prebase-engine".into()),
            parent_id: None,
            language: Some("rust".into()),
            location: None,
        },
        GraphNode {
            id: "file:crates/prebase-engine/src/main.rs".into(),
            kind: NodeKind::File,
            label: "main.rs".into(),
            path: Some("crates/prebase-engine/src/main.rs".into()),
            parent_id: Some("mod:engine".into()),
            language: Some("rust".into()),
            location: Some(SourceLocation {
                path: "crates/prebase-engine/src/main.rs".into(),
                line: Some(1),
                column: Some(1),
            }),
        },
        GraphNode {
            id: "comp:NetworkGraphView".into(),
            kind: NodeKind::Component,
            label: "NetworkGraphView".into(),
            path: Some("webview/src/graph/NetworkGraphView.tsx".into()),
            parent_id: Some("mod:app".into()),
            language: Some("tsx".into()),
            location: Some(SourceLocation {
                path: "webview/src/graph/NetworkGraphView.tsx".into(),
                line: Some(1),
                column: Some(1),
            }),
        },
    ];

    let edges = vec![
        edge(
            "e:contains:mod:app->file:src/extension.ts",
            "mod:app",
            "file:src/extension.ts",
            EdgeKind::Contains,
        ),
        edge(
            "e:contains:file:src/extension.ts->fn:activate",
            "file:src/extension.ts",
            "fn:activate",
            EdgeKind::Contains,
        ),
        edge(
            "e:import:file:src/extension.ts->file:src/engine/client.ts",
            "file:src/extension.ts",
            "file:src/engine/client.ts",
            EdgeKind::Import,
        ),
        edge(
            "e:dependency:file:src/engine/client.ts->mod:engine",
            "file:src/engine/client.ts",
            "mod:engine",
            EdgeKind::Dependency,
        ),
        edge(
            "e:contains:mod:engine->file:crates/prebase-engine/src/main.rs",
            "mod:engine",
            "file:crates/prebase-engine/src/main.rs",
            EdgeKind::Contains,
        ),
        edge(
            "e:reference:comp:NetworkGraphView->mod:engine",
            "comp:NetworkGraphView",
            "mod:engine",
            EdgeKind::Reference,
        ),
    ];

    CanonicalGraph {
        nodes,
        edges,
        project_path: workspace_path.to_string(),
        project_name,
        entry_node_id: Some("mod:app".into()),
        revision: "fixture-v1".into(),
        provenance: GraphProvenance::Fixture,
        versions: CanonicalGraph::versions(),
        provenance_note: Some(
            "Sample architecture graph for tests. Not derived from repository analysis.".into(),
        ),
        coverage: GraphCoverage::default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixture_has_stable_ids_and_provenance() {
        let g = sample_network_graph("/tmp/demo");
        assert_eq!(g.provenance, GraphProvenance::Fixture);
        assert!(!g.nodes.is_empty());
        g.validate_invariants().unwrap();
    }
}
